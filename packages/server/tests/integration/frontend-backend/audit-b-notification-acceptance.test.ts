import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId, RuntimeSessionId } from '@anvilary/workbench-shared';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';

test('AUDIT B: Native completion signals for Claude, Codex, AGY, OpenCode across all state transitions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'audit-b-notif-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;

    // Test each verified provider: claude-code, opencode, antigravity (status-transition)
    for (const provider of ['claude-code', 'opencode', 'antigravity']) {
      const tabId = randomUUID();
      const sessionId = randomUUID() as RuntimeSessionId;

      // 1. Initial idle: must NOT notify
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        nextActivity: 'idle',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'idle');

      // 2. Waiting for input: nextActivity='awaiting-user'
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        nextActivity: 'awaiting-user',
        lifecycle: 'running',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'needs-input');
      // Waiting for input must not generate a completion notification
      assert.equal(store.list(wsId).filter(n => n.tabId === tabId).length, 0, 'needs-input must not emit completion');

      // 3. Working
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        nextActivity: 'working',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'working');
      assert.equal(store.list(wsId).filter(n => n.tabId === tabId).length, 0, 'working must not notify');

      // 4. Completed turn (working -> idle with status-transition evidence)
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        tabName: `${provider} Agent`,
        nextActivity: 'idle',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'finished');
      const tabNotifs = store.list(wsId).filter(n => n.tabId === tabId);
      assert.equal(tabNotifs.length, 1, `${provider} must emit exactly 1 finished notification`);
      assert.equal(tabNotifs[0]?.state, 'finished');
      assert.equal(tabNotifs[0]?.title, `${provider} Agent`);

      // 5. Repeated completion signals (deduplication check)
      for (let rep = 0; rep < 5; rep++) {
        await manager.handleCliActivity({
          workspaceId: wsId,
          tabId,
          sessionId,
          provider,
          tabName: `${provider} Agent`,
          nextActivity: 'idle',
          lifecycle: 'running',
          completionEvidence: 'status-transition',
        });
      }
      assert.equal(store.list(wsId).filter(n => n.tabId === tabId).length, 1, 'Repeated completion signals must be deduplicated');

      // 6. User acknowledgement clears finished badge to idle
      await manager.acknowledgeTab(wsId, tabId);
      assert.equal(manager.getTabState(wsId, tabId), 'idle');

      // 7. Interrupted / cancelled turn: lifecycle='stopping'
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        nextActivity: 'working',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'working');

      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        nextActivity: 'idle',
        lifecycle: 'stopping',
        completionEvidence: 'status-transition',
      });
      assert.notEqual(manager.getTabState(wsId, tabId), 'finished', 'Cancelled agent must not enter finished state');
      assert.equal(manager.getTabState(wsId, tabId), 'unknown');
      // No extra notification created
      assert.equal(store.list(wsId).filter(n => n.tabId === tabId).length, 1, 'Cancelled turn must not create notification');

      // 8. Failed turn: lifecycle='failed'
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        tabName: `${provider} Agent`,
        nextActivity: 'idle',
        lifecycle: 'failed',
        exitCode: 1,
      });
      assert.equal(manager.getTabState(wsId, tabId), 'failed');
      const failNotifs = store.list(wsId).filter(n => n.tabId === tabId && n.state === 'failed');
      assert.equal(failNotifs.length, 1, 'Failed turn must create exactly 1 failed notification');
    }

    // 9. Codex native-turn path verification
    const codexTabId = randomUUID();
    const codexSessionId = randomUUID() as RuntimeSessionId;
    const codexTaskId = 'codex-turn-xyz-1';

    // Codex starts working
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: codexTabId,
      sessionId: codexSessionId,
      provider: 'codex',
      taskId: codexTaskId,
      nextActivity: 'working',
      lifecycle: 'running',
      completionEvidence: 'native-turn',
    });
    assert.equal(manager.getTabState(wsId, codexTabId), 'working');

    // Codex native turn finishes
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: codexTabId,
      sessionId: codexSessionId,
      provider: 'codex',
      taskId: codexTaskId,
      tabName: 'Codex Agent',
      nextActivity: 'finished',
      lifecycle: 'running',
      completionEvidence: 'native-turn',
    });
    assert.equal(manager.getTabState(wsId, codexTabId), 'finished');
    const codexNotifs = store.list(wsId).filter(n => n.tabId === codexTabId);
    assert.equal(codexNotifs.length, 1);
    assert.equal(codexNotifs[0]?.state, 'finished');

    // 10. Multiple concurrently completing agents (10 concurrent agents)
    const concurrentAgents = Array.from({ length: 10 }, (_, i) => ({
      tabId: randomUUID(),
      sessionId: randomUUID() as RuntimeSessionId,
      provider: i % 2 === 0 ? 'claude-code' : 'antigravity',
      name: `Agent ${i}`,
    }));

    // Start all working
    await Promise.all(concurrentAgents.map(a =>
      manager.handleCliActivity({
        workspaceId: wsId,
        tabId: a.tabId,
        sessionId: a.sessionId,
        provider: a.provider,
        nextActivity: 'working',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      })
    ));

    // Finish all simultaneously
    await Promise.all(concurrentAgents.map(a =>
      manager.handleCliActivity({
        workspaceId: wsId,
        tabId: a.tabId,
        sessionId: a.sessionId,
        provider: a.provider,
        tabName: a.name,
        nextActivity: 'idle',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      })
    ));

    for (const a of concurrentAgents) {
      assert.equal(manager.getTabState(wsId, a.tabId), 'finished');
      const notifs = store.list(wsId).filter(n => n.tabId === a.tabId);
      assert.equal(notifs.length, 1, `Concurrent agent ${a.name} must produce exactly 1 notification`);
    }

    // 11. Reconnect & Persistence integrity:
    // Create new store and manager from the same files on disk
    const reloadedStore = new AgencyNotificationStore(path.join(dir, 'notifs.json'));
    await reloadedStore.initialize();
    const reloadedManager = new TabActivityManager({
      notificationStore: reloadedStore,
      filePath: path.join(dir, 'activity.json'),
    });
    await reloadedManager.initialize();

    // Verify uninspected finished states remain finished after restart
    for (const a of concurrentAgents) {
      assert.equal(reloadedManager.getTabState(wsId, a.tabId), 'finished', 'Uninspected finished tab must persist across restart');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
