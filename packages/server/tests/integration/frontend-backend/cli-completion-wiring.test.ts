import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId, RuntimeSessionId } from '@anvilary/workbench-shared';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';

test('CLI completion wiring: verified providers (claude-code, opencode, antigravity) produce notifications via status-transition', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-wiring-test-'));
  try {
    for (const provider of ['claude-code', 'opencode', 'antigravity']) {
      const store = new AgencyNotificationStore(path.join(dir, `${provider}-notifs.json`));
      await store.initialize();
      const manager = new TabActivityManager({
        notificationStore: store,
        filePath: path.join(dir, `${provider}-activity.json`),
      });
      await manager.initialize();

      const wsId = randomUUID() as WorkspaceId;
      const tabId = randomUUID();
      const sessionId = randomUUID() as RuntimeSessionId;

      // 1. Initial idle before any work must not notify
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
      assert.equal(store.list(wsId).length, 0, `${provider} startup idle must not notify`);

      // 2. Agent begins working
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
      assert.equal(store.list(wsId).length, 0, `${provider} working must not notify`);

      // 3. Agent finishes turn (working -> idle transition with status-transition evidence)
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        tabName: `Agent ${provider}`,
        nextActivity: 'idle',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(manager.getTabState(wsId, tabId), 'finished', `${provider} must enter finished state`);
      const notifs = store.list(wsId);
      assert.equal(notifs.length, 1, `${provider} must produce exactly one notification`);
      assert.equal(notifs[0]?.state, 'finished');
      assert.equal(notifs[0]?.title, `Agent ${provider}`);

      // 4. Replay of same turn MUST deduplicate and not create second notification
      await manager.handleCliActivity({
        workspaceId: wsId,
        tabId,
        sessionId,
        provider,
        tabName: `Agent ${provider}`,
        nextActivity: 'idle',
        lifecycle: 'running',
        completionEvidence: 'status-transition',
      });
      assert.equal(store.list(wsId).length, 1, `${provider} duplicate turn event must be deduplicated`);

      // 5. User acknowledgement returns state to idle
      await manager.acknowledgeTab(wsId, tabId);
      assert.equal(manager.getTabState(wsId, tabId), 'idle');

      // 6. User stopping agent mid-task must NOT report finished
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
      assert.notEqual(manager.getTabState(wsId, tabId), 'finished', 'Stopping agent must not finish');
      // Still only the 1 notification from earlier turn
      assert.equal(store.list(wsId).length, 1, 'Stopping agent must not create completion notification');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI completion wiring: unverified providers or generic CLIs do not produce completion notifications', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-unverified-test-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'unverified-notifs.json'));
    await store.initialize();
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: path.join(dir, 'unverified-activity.json'),
    });
    await manager.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessionId = randomUUID() as RuntimeSessionId;

    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId,
      provider: 'custom-unknown-agent',
      nextActivity: 'working',
      lifecycle: 'running',
      completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'working');

    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId,
      provider: 'custom-unknown-agent',
      nextActivity: 'idle',
      lifecycle: 'running',
      completionEvidence: 'status-transition',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'idle');
    assert.equal(store.list(wsId).length, 0, 'Unverified provider must not emit completion notification');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
