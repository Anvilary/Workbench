import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import type { WorkspaceId, RuntimeSessionId } from '@agent-workbench/shared';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('working and needs-input do not notify; a verified completion notifies once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'long-running-test-'));
  const notifFile = path.join(dir, 'notifications.json');
  const activityFile = path.join(dir, 'activity.json');

  try {
    const store = new AgencyNotificationStore(notifFile);
    await store.initialize();

    // Use 100ms threshold for test
    const manager = new TabActivityManager({
      notificationStore: store,
      filePath: activityFile,
      longRunningThresholdMs: 100,
    });
    await manager.initialize();

    const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
    const tabId = '22222222-2222-4222-8222-222222222222';
    const sessId = '33333333-3333-4333-8333-333333333333' as RuntimeSessionId;

    // Test 1: Task finishes before threshold -> NO long-running notification
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: sessId,
      provider: 'claude-code',
      tabName: 'Short CLI Run',
      taskId: 'short-1',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    // Finishes quickly after 20ms
    await pause(20);
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: sessId,
      provider: 'claude-code',
      tabName: 'Short CLI Run',
      taskId: 'short-1',
      nextActivity: 'finished',
      completionEvidence: 'native-turn',
      lifecycle: 'running',
    });
    // Wait past the threshold
    await pause(120);
    let notifications = store.list();
    // Only the 'finished' completion notification exists, no 'long-running' notification
    const longRunningNotifs = notifications.filter(n => n.deduplicationKey?.startsWith('long-running:'));
    assert.equal(longRunningNotifs.length, 0, 'Short task must not produce long-running notification');

    // Continuous work updates the tab and does not notify, including after the old threshold.
    const tab2 = '44444444-4444-4444-8444-444444444444';
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tab2,
      sessionId: sessId,
      provider: 'codex',
      tabName: 'Long Codex Run',
      taskId: 'codex-turn-1',
      nextActivity: 'working',
      lifecycle: 'running',
    });
    await pause(150);
    assert.equal(manager.getTabState(wsId, tab2), 'working');
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tab2,
      sessionId: sessId,
      provider: 'codex',
      tabName: 'Long Codex Run',
      taskId: 'codex-turn-1',
      nextActivity: 'awaiting-user',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tab2), 'needs-input');
    notifications = store.list();
    assert.equal(notifications.filter(n => n.tabId === tab2).length, 0, 'Working and needs-input must not notify');
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tab2,
      sessionId: sessId,
      provider: 'codex',
      tabName: 'Long Codex Run',
      taskId: 'codex-turn-1',
      nextActivity: 'finished',
      completionEvidence: 'native-turn',
      lifecycle: 'running',
    });
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId: tab2,
      sessionId: sessId,
      provider: 'codex',
      tabName: 'Long Codex Run',
      taskId: 'codex-turn-1',
      nextActivity: 'finished',
      completionEvidence: 'native-turn',
      lifecycle: 'running',
    });
    notifications = store.list();
    const completed = notifications.filter(n => n.deduplicationKey === `cli-turn:${wsId}:${tab2}:codex-turn-1`);
    assert.equal(completed.length, 1, 'Verified completion notifies once');
    assert.equal(completed[0]!.state, 'finished');

    manager.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
