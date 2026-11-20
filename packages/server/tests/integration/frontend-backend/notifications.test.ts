import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import {
  generateBashIntegrationScript,
  generateZshIntegrationScript,
  installShellIntegrationSafely,
  ShellIntegrationParser,
  ShellSequences,
} from '../../../src/features/terminals/shell-integration.js';
import {
  ChatGPTActivityProvider,
  generateStrongBridgeToken,
} from '../../../src/features/notifications/browser-activity-provider.js';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';

test('Native CLI activity: consecutive turns, replay deduplication, tab isolation, and unverified provider safety', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-test-notif-audit-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      storageDir: dir,
    });
    await manager.initialize();

    const wsId1 = randomUUID() as WorkspaceId;
    const wsId2 = randomUUID() as WorkspaceId;
    const tab1 = randomUUID();
    const tab2 = randomUUID();
    const tabCodex = randomUUID();

    // 1. Initial state is unknown
    assert.equal(manager.getTabState(wsId1, tab1), 'unknown');
    assert.equal(manager.getTabState(wsId2, tab2), 'unknown');
    assert.equal(manager.getTabState(wsId1, tabCodex), 'unknown');

    // 2. Generic startup idle without working turn MUST NOT enter finished
    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tab1), 'idle');
    assert.equal(store.list(wsId1).length, 0);

    // 3. Turn 1 on Tab 1: working -> idle transitions to finished
    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tab1), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tab1), 'finished');

    const notifsAfterTurn1 = store.list(wsId1);
    assert.equal(notifsAfterTurn1.length, 1);
    assert.equal(notifsAfterTurn1[0]?.deduplicationKey, `cli-turn:${wsId1}:${tab1}:turn-1`);

    // 4. Replay of Turn 1 event: MUST NOT generate duplicate notification!
    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(store.list(wsId1).length, 1); // Deduplicated!

    // 5. User acknowledges Turn 1 -> returns to idle
    await manager.acknowledgeTab(wsId1, tab1);
    assert.equal(manager.getTabState(wsId1, tab1), 'idle');

    // 6. Turn 2 on Tab 1: produces a distinct, independently identifiable turn-2 event
    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tab1), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tab1), 'finished');

    const notifsAfterTurn2 = store.list(wsId1);
    assert.equal(notifsAfterTurn2.length, 2);
    assert.equal(notifsAfterTurn2[0]?.deduplicationKey, `cli-turn:${wsId1}:${tab1}:turn-2`);

    // 7. Isolation: Tab 2 in Workspace 2 has independent sequence
    await manager.handleCliActivity({
      workspaceId: wsId2,
      tabId: tab2,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    await manager.handleCliActivity({
      workspaceId: wsId2,
      tabId: tab2,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(store.list(wsId2).length, 1);
    assert.equal(store.list(wsId2)[0]?.deduplicationKey, `cli-turn:${wsId2}:${tab2}:turn-1`);

    // 8. Unverified Codex/AGY activity remains Unknown or Idle without fabricated completion events
    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tabCodex,
      sessionId: randomUUID() as any,
      provider: 'codex',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId1, tabCodex), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId1,
      tabId: tabCodex,
      sessionId: randomUUID() as any,
      provider: 'codex',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    // Codex does NOT enter finished! Transitions to idle without completion alert
    assert.equal(manager.getTabState(wsId1, tabCodex), 'idle');
    assert.equal(store.list(wsId1).length, 2); // No new notification!

    // 9. Restart recovery preserves turn sequence: subsequent turn becomes turn-3
    const managerRestarted = new TabActivityManager({
      notificationStore: store,
      storageDir: dir,
    });
    await managerRestarted.initialize();

    await managerRestarted.acknowledgeTab(wsId1, tab1); // Acknowledge turn-2
    await managerRestarted.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    await managerRestarted.handleCliActivity({
      workspaceId: wsId1,
      tabId: tab1,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    const notifsAfterRestart = store.list(wsId1);
    assert.equal(notifsAfterRestart.length, 3);
    assert.equal(notifsAfterRestart[0]?.deduplicationKey, `cli-turn:${wsId1}:${tab1}:turn-3`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Functional Bash & Zsh shell integration with real interactive process', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-shell-real-'));
  try {
    const { bashScriptPath, zshScriptPath } = await installShellIntegrationSafely(tempDir);
    const bashScript = await readFile(bashScriptPath, 'utf8');
    const zshScript = await readFile(zshScriptPath, 'utf8');

    // Safe generation checks
    assert.equal(bashScript, generateBashIntegrationScript());
    assert.equal(zshScript, generateZshIntegrationScript());
    assert.ok(bashScript.includes('PS0='));
    assert.ok(bashScript.includes('133;C'));
    assert.ok(bashScript.includes('133;D'));
    assert.ok(zshScript.includes('precmd_functions+='));
    assert.ok(zshScript.includes('preexec_functions+='));

    // Execute real interactive bash process with the generated script
    const bashProcess = spawn('bash', ['--noprofile', '--rcfile', bashScriptPath, '-i'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    let stdoutData = '';
    bashProcess.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    // Send commands to interactive bash
    bashProcess.stdin.write('echo bash_cmd_success\n');
    bashProcess.stdin.write('sh -c "exit 33"\n');
    bashProcess.stdin.write('exit\n');

    await new Promise<void>((resolve) => {
      bashProcess.on('close', () => resolve());
    });

    // Verify sequences produced by real interactive bash
    assert.ok(stdoutData.includes('133;D;0'), 'Bash emitted exit 0');
    assert.ok(stdoutData.includes('133;D;33'), 'Bash emitted exit 33');

    // Feed to parser
    const parser = new ShellIntegrationParser();
    parser.feed(stdoutData);
    assert.ok(parser.isIntegrationEstablished());

    // Parser exit code safety
    parser.feed(ShellSequences.commandStart);
    parser.feed('\x1b]133;D\x07'); // Missing code -> unknown
    assert.equal(parser.getState(), 'unknown');

    parser.feed(ShellSequences.commandStart);
    parser.feed('\x1b]133;D;invalid\x07'); // Nonnumeric code -> unknown
    assert.equal(parser.getState(), 'unknown');

    parser.feed(ShellSequences.commandStart);
    parser.feed(ShellSequences.commandExit(0)); // Exit 0 -> finished
    assert.equal(parser.getState(), 'finished');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Browser bridge: strong token requirement, tab binding, and unauthorized rejection', () => {
  const provider = new ChatGPTActivityProvider();

  // 1. Initial state without signals is unknown
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');
  assert.equal(provider.canProveCompletion(), false);

  // 2. Default credentials eliminated; registration requires strong token (>=16 chars)
  assert.throws(
    () => provider.registerAuthorizedBridge('ext-1', 'short', ['tab-chatgpt-1']),
    /minimum 16 characters/,
  );
  assert.throws(
    () => provider.registerAuthorizedBridge('ext-1', 'valid-strong-token-12345', []),
    /allowedTabIds/,
  );

  // 3. Register authorized bridge with strong token and bound allowed tab
  const strongToken = generateStrongBridgeToken();
  assert.ok(strongToken.length >= 32);
  provider.registerAuthorizedBridge('authorized-ext', strongToken, ['tab-chatgpt-1']);
  assert.equal(provider.canProveCompletion(), true);

  // 4. Submission for unrelated tab (tab-chatgpt-other) is REJECTED
  const unrelatedResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-other',
    bridgeId: 'authorized-ext',
    authToken: strongToken,
    signalType: 'extension-bridge',
    state: 'finished',
  });
  assert.equal(unrelatedResult, false);
  assert.equal(provider.getActivity('tab-chatgpt-other'), 'unknown');

  // 5. Submission with invalid token is REJECTED
  const badTokenResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    bridgeId: 'authorized-ext',
    authToken: 'wrong-secret-token',
    signalType: 'extension-bridge',
    state: 'finished',
  });
  assert.equal(badTokenResult, false);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');

  // 6. Authorized submission for bound tab succeeds
  const validResult = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    bridgeId: 'authorized-ext',
    authToken: strongToken,
    signalType: 'extension-bridge',
    state: 'finished',
  });
  assert.equal(validResult, true);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'finished');

  provider.acknowledgeTab('tab-chatgpt-1');
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'idle');
});

test('Durable persistence: atomic writes, 0o600 permissions, failure recovery, and queue continuity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-persist-recovery-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store.initialize();

    const activityFile = path.join(dir, 'agency-tab-activity.json');
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: activityFile,
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();

    // 1. Initial successful write
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    await manager.flush();

    // Verify private file permissions (0o600)
    const fileStats = await stat(activityFile);
    assert.equal(fileStats.mode & 0o777, 0o600);

    // 2. Simulate write failure: make directory read-only
    await chmod(dir, 0o500);

    // Attempted write MUST fail visibly (reject promise)
    await assert.rejects(
      async () => {
        await manager.handleCliActivity({
          workspaceId: wsId,
          tabId,
          sessionId: randomUUID() as any,
          provider: 'claude-code',
          previousActivity: 'working',
      completionEvidence: 'status-transition',
          nextActivity: 'idle',
          lifecycle: 'running',
        });
      },
      /EACCES|permission denied/i,
    );

    // 3. Restore directory permissions: write queue MUST recover and subsequent write MUST succeed
    await chmod(dir, 0o700);

    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: randomUUID() as any,
      provider: 'claude-code',
      previousActivity: 'working',
      completionEvidence: 'status-transition',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    await manager.flush();

    // Verify recovery: state persisted cleanly after queue recovery
    const managerRecovered = new TabActivityManager({
      notificationStore: store,
      filePath: activityFile,
    });
    await managerRecovered.initialize();
    assert.equal(managerRecovered.getTabState(wsId, tabId), 'finished');
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
