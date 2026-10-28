import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from './agency-notification-store.js';
import {
  generateBashIntegrationScript,
  generateZshIntegrationScript,
  installShellIntegrationSafely,
  ShellIntegrationParser,
  ShellSequences,
} from './shell-integration.js';
import { ChatGPTActivityProvider } from './browser-activity-provider.js';
import { TabActivityManager } from './tab-activity-manager.js';

test('Native CLI activity: provider audit, turn completion vs generic idle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-test-notif-audit-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      storageDir: dir,
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabClaude = randomUUID();
    const tabCodex = randomUUID();

    // 1. Initial state without signals is unknown
    assert.equal(manager.getTabState(wsId, tabClaude), 'unknown');
    assert.equal(manager.getTabState(wsId, tabCodex), 'unknown');

    // 2. Generic startup idle (without preceding working turn) MUST NOT enter finished
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tabClaude,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabClaude), 'idle');
    assert.equal(store.list(wsId).length, 0); // No notification for generic startup idle!

    // 3. Claude Code: working -> idle with verified provider is a true turn completion
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tabClaude,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'turn-1',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabClaude), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tabClaude,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'turn-1',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabClaude), 'finished');
    assert.equal(store.list(wsId).length, 1);
    assert.equal(store.list(wsId)[0]?.state, 'finished');

    // 4. Codex (statusSource: false): working -> idle does NOT emit verified turn completion
    // Codex does not have real-time turn tracking; generic idle cannot be treated as completion!
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tabCodex,
      sessionId: randomUUID() as any,
      provider: 'codex',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabCodex), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tabCodex,
      sessionId: randomUUID() as any,
      provider: 'codex',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    // Codex transitions to idle, NOT finished!
    assert.equal(manager.getTabState(wsId, tabCodex), 'idle');
    assert.equal(store.list(wsId).length, 1); // No false finished alert for Codex!

    // 5. Uninspected finished state on Claude tab persists
    assert.equal(manager.getTabState(wsId, tabClaude), 'finished');

    // 6. User inspects tab -> acknowledges
    await manager.acknowledgeTab(wsId, tabClaude);
    assert.equal(manager.getTabState(wsId, tabClaude), 'idle');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Shell OSC 133: strict exit codes, non-0/malformed/missing handling and safe hook setup', async () => {
  const parser = new ShellIntegrationParser();

  // 1. Initial state is unknown
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.isIntegrationEstablished(), false);

  // 2. Arbitrary PTY output is NOT treated as completion or start
  parser.feed('user@host:~$ ls -la\r\ntotal 0\r\n');
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.isIntegrationEstablished(), false);

  // 3. Prompt start sequence (OSC 133 ; A) establishes integration
  parser.feed(ShellSequences.promptStart);
  assert.equal(parser.isIntegrationEstablished(), true);
  assert.equal(parser.getState(), 'idle');

  // 4. Command start (OSC 133 ; C) -> working
  parser.feed(ShellSequences.commandStart);
  assert.equal(parser.getState(), 'working');

  // 5. Missing exit code (\x1b]133;D\x07) MUST NOT be treated as 0: must become unknown
  parser.feed('\x1b]133;D\x07');
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.getLastExitCode(), null);

  // 6. Malformed or nonnumeric exit code (\x1b]133;D;foo\x07) MUST NOT be treated as 0
  parser.feed(ShellSequences.commandStart);
  assert.equal(parser.getState(), 'working');
  parser.feed('\x1b]133;D;foo\x07');
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.getLastExitCode(), null);

  // 7. Strictly valid exit code 0 -> finished
  parser.feed(ShellSequences.commandStart);
  parser.feed(ShellSequences.commandExit(0));
  assert.equal(parser.getState(), 'finished');
  assert.equal(parser.getLastExitCode(), 0);

  // 8. Strictly valid non-zero exit code -> failed
  parser.acknowledge();
  parser.feed(ShellSequences.commandStart);
  parser.feed(ShellSequences.commandExit(1));
  assert.equal(parser.getState(), 'failed');
  assert.equal(parser.getLastExitCode(), 1);

  // 9. Safe shell integration setup verification
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-shell-hooks-'));
  try {
    const { bashScriptPath, zshScriptPath } = await installShellIntegrationSafely(tempDir);
    const bashScript = await readFile(bashScriptPath, 'utf8');
    const zshScript = await readFile(zshScriptPath, 'utf8');

    // Does not overwrite user configuration; chains safely
    assert.ok(bashScript.includes('PROMPT_COMMAND='));
    assert.ok(bashScript.includes('__maw_osc133_precmd'));
    assert.ok(zshScript.includes('precmd_functions+='));
    assert.ok(zshScript.includes('preexec_functions+='));

    // Check generators match
    assert.equal(generateBashIntegrationScript(), bashScript);
    assert.equal(generateZshIntegrationScript(), zshScript);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Browser activity provider: authorization, token authentication, and signal verification', () => {
  const provider = new ChatGPTActivityProvider();

  // 1. Limitations are explicitly reported
  const report = provider.limitationReport();
  assert.ok(report.includes('No Public Webhook / Completion API'));
  assert.ok(report.includes('Private APIs Forbidden'));
  assert.ok(report.includes('Authentication Required'));

  // 2. Without authorized bridge, completion cannot be proven
  assert.equal(provider.canProveCompletion(), false);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');

  // 3. Arbitrary unauthenticated caller CANNOT report verified signal or set finished
  const unauthResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    signalType: 'extension-bridge',
    state: 'finished',
    notes: 'Fake finished by unauthenticated caller',
  });
  assert.equal(unauthResult, false);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');

  // 4. Caller with wrong token is rejected
  provider.registerAuthorizedBridge('authorized-ext-01', 'secret-bridge-token-xyz');
  assert.equal(provider.canProveCompletion(), true);

  const badTokenResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    bridgeId: 'authorized-ext-01',
    authToken: 'wrong-token',
    signalType: 'extension-bridge',
    state: 'finished',
  });
  assert.equal(badTokenResult, false);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');

  // 5. Authorized caller with correct token successfully updates state
  const authWorkingResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    bridgeId: 'authorized-ext-01',
    authToken: 'secret-bridge-token-xyz',
    signalType: 'extension-bridge',
    state: 'working',
  });
  assert.equal(authWorkingResult, true);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'working');

  // 6. Authorized completion signal transitions to finished
  const authFinishedResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    bridgeId: 'authorized-ext-01',
    authToken: 'secret-bridge-token-xyz',
    signalType: 'extension-bridge',
    state: 'finished',
  });
  assert.equal(authFinishedResult, true);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'finished');

  // 7. Acknowledging tab resets to idle
  provider.acknowledgeTab('tab-chatgpt-1');
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'idle');
});

test('Durable task states across MAW restart: in-flight -> unknown, uninspected finished preserved, closed tab protection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-durable-restart-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store.initialize();

    const manager1 = new TabActivityManager({
      notificationStore: store,
      storageDir: dir,
    });
    await manager1.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabFinishedUninspected = randomUUID();
    const tabInFlight = randomUUID();
    const tabAcknowledged = randomUUID();
    const tabClosed = randomUUID();

    // Setup tab 1: finished, not acknowledged
    await manager1.handleCliActivity({
      workspaceId: wsId,
      tabId: tabFinishedUninspected,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-1',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager1.getTabState(wsId, tabFinishedUninspected), 'finished');

    // Setup tab 2: in-flight working
    await manager1.handleCliActivity({
      workspaceId: wsId,
      tabId: tabInFlight,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-2',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager1.getTabState(wsId, tabInFlight), 'working');

    // Setup tab 3: finished and acknowledged
    await manager1.handleCliActivity({
      workspaceId: wsId,
      tabId: tabAcknowledged,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-3',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    await manager1.acknowledgeTab(wsId, tabAcknowledged);
    assert.equal(manager1.getTabState(wsId, tabAcknowledged), 'idle');

    // Setup tab 4: closed
    await manager1.handleCliActivity({
      workspaceId: wsId,
      tabId: tabClosed,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-4',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    await manager1.closeTab(wsId, tabClosed);

    const initialNotificationsCount = store.list(wsId).length;

    // Simulate server restart: new store and manager instances reading from disk
    const store2 = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store2.initialize();

    const manager2 = new TabActivityManager({
      notificationStore: store2,
      storageDir: dir,
    });
    await manager2.initialize();

    // Verification 1: Uninspected Finished state must remain Finished
    assert.equal(manager2.getTabState(wsId, tabFinishedUninspected), 'finished');

    // Verification 2: In-flight task without recovery signal becomes Unknown rather than falsely Finished
    assert.equal(manager2.getTabState(wsId, tabInFlight), 'unknown');

    // Verification 3: Previously acknowledged task stays idle
    assert.equal(manager2.getTabState(wsId, tabAcknowledged), 'idle');

    // Verification 4: Duplicate signal for previously acknowledged task does NOT create duplicate alert
    await manager2.handleCliActivity({
      workspaceId: wsId,
      tabId: tabAcknowledged,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-3',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(store2.list(wsId).length, initialNotificationsCount); // Deduplicated!

    // Verification 5: Closed tab does NOT generate stale completion alert
    await manager2.handleCliActivity({
      workspaceId: wsId,
      tabId: tabClosed,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      taskId: 'task-4',
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(store2.list(wsId).length, initialNotificationsCount); // No alert for closed tab!
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
