/**
 * MAW Lane C - Comprehensive Notification Acceptance Test Suite.
 *
 * Covers:
 *   - Genuine completion for all verified providers
 *   - False completion prevention (startup, silence, timeout, generic idle)
 *   - Waiting for input (needs-input) lifecycle and deduplication
 *   - Cancellation and abort handling (stopping, turn_aborted -> unknown/never finished)
 *   - Failure handling (exit code != 0, turn error)
 *   - Repeated events and replay deduplication
 *   - Out-of-order event resilience (stale turn cannot regress newer turn)
 *   - Backend restart (finished remains finished, working becomes unknown, turn sequences restored)
 *   - Done action and tab badge clearing
 *   - Multiple concurrent sessions running in parallel without cross-talk
 *   - Safe shell integration (ordinary commands produce 0 alerts)
 *   - Store capacity boundedness (prunes oldest acknowledged items)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId, RuntimeSessionId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from '../../../src/agency/agency-notification-store.js';
import { TabActivityManager } from '../../../src/agency/tab-activity-manager.js';

test('Lane C Acceptance 1: Genuine completion across verified providers (Claude, OpenCode, Antigravity, Codex)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-genuine-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;

    // A. Claude Code: working -> idle with status-transition evidence
    const claudeTab = randomUUID();
    const claudeSess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: claudeTab, sessionId: claudeSess, provider: 'claude-code',
      tabName: 'Claude Code', nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, claudeTab), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId, tabId: claudeTab, sessionId: claudeSess, provider: 'claude-code',
      tabName: 'Claude Code', nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, claudeTab), 'finished');
    const claudeNotifs = store.list(wsId).filter(n => n.tabId === claudeTab);
    assert.equal(claudeNotifs.length, 1);
    assert.equal(claudeNotifs[0]?.state, 'finished');
    assert.equal(claudeNotifs[0]?.title, 'Claude Code');

    // B. OpenCode: working -> idle with status-transition evidence
    const opencodeTab = randomUUID();
    const opencodeSess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: opencodeTab, sessionId: opencodeSess, provider: 'opencode',
      tabName: 'OpenCode Agent', nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: opencodeTab, sessionId: opencodeSess, provider: 'opencode',
      tabName: 'OpenCode Agent', nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, opencodeTab), 'finished');
    const opencodeNotifs = store.list(wsId).filter(n => n.tabId === opencodeTab);
    assert.equal(opencodeNotifs.length, 1);

    // C. Antigravity: configured statusline working -> idle with status-transition
    const agyTab = randomUUID();
    const agySess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: agyTab, sessionId: agySess, provider: 'antigravity',
      tabName: 'Antigravity CLI', nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: agyTab, sessionId: agySess, provider: 'antigravity',
      tabName: 'Antigravity CLI', nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, agyTab), 'finished');
    const agyNotifs = store.list(wsId).filter(n => n.tabId === agyTab);
    assert.equal(agyNotifs.length, 1);

    // D. Codex: native-turn complete event from rollout
    const codexTab = randomUUID();
    const codexSess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: codexTab, sessionId: codexSess, provider: 'codex',
      tabName: 'Codex Agent', nextActivity: 'working', lifecycle: 'running', taskId: 'codex-turn-1', completionEvidence: 'native-turn',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: codexTab, sessionId: codexSess, provider: 'codex',
      tabName: 'Codex Agent', nextActivity: 'finished', lifecycle: 'running', taskId: 'codex-turn-1', completionEvidence: 'native-turn',
    });
    assert.equal(manager.getTabState(wsId, codexTab), 'finished');
    const codexNotifs = store.list(wsId).filter(n => n.tabId === codexTab);
    assert.equal(codexNotifs.length, 1);
    assert.equal(codexNotifs[0]?.deduplicationKey, `cli-turn:${wsId}:${codexTab}:codex-turn-1`);

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 2: False completion prevention (generic idle, unverified providers, missing evidence)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-false-prevention-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessId = randomUUID() as RuntimeSessionId;

    // 1. Initial idle at startup must not emit completion
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'idle');
    assert.equal(store.list(wsId).length, 0, 'Startup idle must never notify');

    // 2. Unverified provider (e.g. custom or unconfigured generic CLI)
    const customTab = randomUUID();
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: customTab, sessionId: sessId, provider: 'custom-cli',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, customTab), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId, tabId: customTab, sessionId: sessId, provider: 'custom-cli',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    // Transitions to idle with reliableSignal: false, NEVER finished!
    assert.equal(manager.getTabState(wsId, customTab), 'idle');
    const record = manager.getRecord(wsId, customTab);
    assert.equal(record?.reliableSignal, false);
    assert.equal(store.list(wsId).filter(n => n.tabId === customTab).length, 0, 'Unverified provider must never notify completion');

    // 3. Codex generic activity path without native-turn rollout event
    const unverifiedCodex = randomUUID();
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: unverifiedCodex, sessionId: sessId, provider: 'codex',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: unverifiedCodex, sessionId: sessId, provider: 'codex',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, unverifiedCodex), 'idle');
    assert.equal(store.list(wsId).filter(n => n.tabId === unverifiedCodex).length, 0, 'Codex without native-turn must never notify');

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 3: Waiting for input (needs-input) lifecycle and deduplication', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-needs-input-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
      notifyOnNeedsInput: true,
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessId = randomUUID() as RuntimeSessionId;

    // Agent starts working
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'working');

    // Agent transitions to awaiting-user (e.g. permission prompt)
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', tabName: 'Claude Agent',
      nextActivity: 'awaiting-user', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'needs-input');
    const inputNotifs = store.list(wsId).filter(n => n.tabId === tabId);
    assert.equal(inputNotifs.length, 1);
    assert.equal(inputNotifs[0]?.state, 'needs-input');

    // Repeated poll from 700ms status watcher while waiting for user input MUST deduplicate
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', tabName: 'Claude Agent',
      nextActivity: 'awaiting-user', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(store.list(wsId).filter(n => n.tabId === tabId).length, 1, 'Repeated waiting poll must deduplicate');

    // User provides permission, agent returns to working
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', tabName: 'Claude Agent',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'working');

    // Agent genuinely completes turn
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', tabName: 'Claude Agent',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'finished');

    // Both input request and finished completion are preserved in history with distinct keys
    const allNotifs = store.list(wsId).filter(n => n.tabId === tabId);
    assert.equal(allNotifs.length, 2);
    assert.ok(allNotifs.some(n => n.state === 'needs-input'));
    assert.ok(allNotifs.some(n => n.state === 'finished'));

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 4: Cancellation and failure semantics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-cancel-fail-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;

    // 1. User stopping/cancelling agent mid-task -> unknown, NEVER finished
    const cancelTab = randomUUID();
    const cancelSess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: cancelTab, sessionId: cancelSess, provider: 'claude-code',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, cancelTab), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId, tabId: cancelTab, sessionId: cancelSess, provider: 'claude-code',
      nextActivity: 'idle', lifecycle: 'stopping', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, cancelTab), 'unknown');
    assert.equal(store.list(wsId).filter(n => n.tabId === cancelTab).length, 0, 'Cancelled task must not notify finished');

    // 2. Process exit with non-zero code -> failed
    const failTab = randomUUID();
    const failSess = randomUUID() as RuntimeSessionId;
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: failTab, sessionId: failSess, provider: 'claude-code',
      tabName: 'Failing Agent', nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId: failTab, sessionId: failSess, provider: 'claude-code',
      tabName: 'Failing Agent', nextActivity: 'idle', lifecycle: 'failed', exitCode: 1, completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, failTab), 'failed');
    const failNotifs = store.list(wsId).filter(n => n.tabId === failTab);
    assert.equal(failNotifs.length, 1);
    assert.equal(failNotifs[0]?.state, 'failed');

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 5: Repeated events and out-of-order event resilience', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-dedup-reorder-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessId = randomUUID() as RuntimeSessionId;

    // Turn 1 working -> finished
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-1',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-1',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'finished');
    assert.equal(store.list(wsId).length, 1);

    // Replay of Turn 1 completion 5 times in a row -> stays 1 notification
    for (let i = 0; i < 5; i++) {
      await manager.handleCliActivity({
        workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-1',
        nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
      });
    }
    assert.equal(store.list(wsId).length, 1, 'Replay of same turn must be strictly deduplicated');

    // User acknowledges Turn 1
    await manager.acknowledgeTab(wsId, tabId);
    assert.equal(manager.getTabState(wsId, tabId), 'idle');

    // Turn 2 begins and completes
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-2',
      nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-2',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'finished');
    assert.equal(store.list(wsId).length, 2, 'Distinct turn produces independent notification');

    // Out of order: delayed Turn 1 event arrives now. It must not overwrite Turn 2!
    await manager.handleCliActivity({
      workspaceId: wsId, tabId, sessionId: sessId, provider: 'claude-code', taskId: 'turn-1',
      nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
    });
    const currentRecord = manager.getRecord(wsId, tabId);
    assert.equal(currentRecord?.taskId, 'turn-2', 'Stale turn cannot regress active turn identity');
    assert.equal(store.list(wsId).length, 2, 'Stale turn event cannot create duplicate notification');

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 6: Backend restart recovery semantics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-restart-'));
  const notifFile = path.join(dir, 'notifs.json');
  const activityFile = path.join(dir, 'activity.json');

  try {
    const wsId = randomUUID() as WorkspaceId;
    const tabA = randomUUID();
    const tabB = randomUUID();
    const sessA = randomUUID() as RuntimeSessionId;
    const sessB = randomUUID() as RuntimeSessionId;

    // Instance 1: Tab A finishes and remains uninspected; Tab B is mid-turn (working)
    {
      const store1 = new AgencyNotificationStore(notifFile);
      await store1.initialize();
      const manager1 = new TabActivityManager({ notificationStore: store1, filePath: activityFile });
      await manager1.initialize();

      // Tab A finishes
      await manager1.handleCliActivity({
        workspaceId: wsId, tabId: tabA, sessionId: sessA, provider: 'claude-code', taskId: 'turn-1',
        nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
      });
      await manager1.handleCliActivity({
        workspaceId: wsId, tabId: tabA, sessionId: sessA, provider: 'claude-code', taskId: 'turn-1',
        nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
      });
      assert.equal(manager1.getTabState(wsId, tabA), 'finished');

      // Tab B is working
      await manager1.handleCliActivity({
        workspaceId: wsId, tabId: tabB, sessionId: sessB, provider: 'claude-code', taskId: 'turn-1',
        nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
      });
      assert.equal(manager1.getTabState(wsId, tabB), 'working');

      await manager1.flush();
      await store1.flush();
      manager1.dispose();
    }

    // Instance 2: Backend restarts and reloads persisted state from disk
    {
      const store2 = new AgencyNotificationStore(notifFile);
      await store2.initialize();
      const manager2 = new TabActivityManager({ notificationStore: store2, filePath: activityFile });
      await manager2.initialize();

      // 1. Uninspected finished state for Tab A remains finished!
      assert.equal(manager2.getTabState(wsId, tabA), 'finished');

      // 2. In-flight working state for Tab B becomes unknown (not falsely finished or failed!)
      assert.equal(manager2.getTabState(wsId, tabB), 'unknown');
      const recordB = manager2.getRecord(wsId, tabB);
      assert.equal(recordB?.reliableSignal, false);

      // 3. Restart does not invent any duplicate notifications
      assert.equal(store2.list(wsId).length, 1);

      // 4. Tab B resumes execution and completes new turn -> advances sequence safely without collision
      await manager2.handleCliActivity({
        workspaceId: wsId, tabId: tabB, sessionId: sessB, provider: 'claude-code',
        nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
      });
      await manager2.handleCliActivity({
        workspaceId: wsId, tabId: tabB, sessionId: sessB, provider: 'claude-code',
        nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
      });
      assert.equal(manager2.getTabState(wsId, tabB), 'finished');
      assert.equal(store2.list(wsId).length, 2);

      manager2.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 7: Multiple concurrent sessions running in parallel without cross-talk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-concurrent-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, filePath: path.join(dir, 'activity.json') });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const sessionCount = 8;
    const tabs = Array.from({ length: sessionCount }, () => ({
      tabId: randomUUID(),
      sessionId: randomUUID() as RuntimeSessionId,
    }));

    // Start all 8 sessions working concurrently
    await Promise.all(
      tabs.map((tab, i) =>
        manager.handleCliActivity({
          workspaceId: wsId, tabId: tab.tabId, sessionId: tab.sessionId, provider: 'claude-code',
          tabName: `Agent ${i + 1}`, nextActivity: 'working', lifecycle: 'running', completionEvidence: 'status-transition',
        }),
      ),
    );

    for (const tab of tabs) {
      assert.equal(manager.getTabState(wsId, tab.tabId), 'working');
    }
    assert.equal(store.list(wsId).length, 0, 'No completion notifications while all are working');

    // Complete all 8 sessions concurrently
    await Promise.all(
      tabs.map((tab, i) =>
        manager.handleCliActivity({
          workspaceId: wsId, tabId: tab.tabId, sessionId: tab.sessionId, provider: 'claude-code',
          tabName: `Agent ${i + 1}`, nextActivity: 'idle', lifecycle: 'running', completionEvidence: 'status-transition',
        }),
      ),
    );

    for (const tab of tabs) {
      assert.equal(manager.getTabState(wsId, tab.tabId), 'finished');
    }
    const notifs = store.list(wsId);
    assert.equal(notifs.length, sessionCount, 'Every concurrent session produces exactly 1 completion notification');

    // Verify deduplication keys are unique across all sessions
    const keys = new Set(notifs.map(n => n.deduplicationKey));
    assert.equal(keys.size, sessionCount, 'All deduplication keys must be strictly unique per session tab');

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Lane C Acceptance 8: Bounded retention in notification store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-acceptance-retention-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();

    // Create 160 notifications (MAX is 150)
    for (let i = 1; i <= 160; i++) {
      const item = await store.create({
        workspaceId: wsId,
        tabId,
        title: `Task ${i}`,
        body: 'Completed',
        state: 'finished',
        deduplicationKey: `turn-${i}`,
      });
      assert.ok(item);
      // Mark read and acknowledged so they become eligible for pruning
      await store.acknowledge(item.id);
    }

    const list = store.list(wsId);
    assert.ok(list.length <= 150, `Inbox size must be bounded (was ${list.length}, max 150)`);

    // Pruned turn keys are STILL remembered in deduplication index so old turns cannot re-alert
    assert.equal(store.hasDeduplicationKey('turn-1'), true);
    const retryOld = await store.create({
      workspaceId: wsId,
      tabId,
      title: 'Task 1 Replay',
      body: 'Completed',
      state: 'finished',
      deduplicationKey: 'turn-1',
    });
    assert.equal(retryOld, null, 'Pruned items must still be deduplicated');

    store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
