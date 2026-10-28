import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from './agency-notification-store.js';
import { ShellIntegrationParser, ShellSequences } from './shell-integration.js';
import { ChatGPTActivityProvider } from './browser-activity-provider.js';
import { TabActivityManager } from './tab-activity-manager.js';

test('State model: 5-state transitions and reliable completion enforcement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-test-notif-'));
  try {
    const store = new AgencyNotificationStore(path.join(dir, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store });

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();

    // 1. Initial state without signals is unknown
    assert.equal(manager.getTabState(wsId, tabId), 'unknown');

    // 2. Transition CLI to working
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: randomUUID() as any,
      nextActivity: 'working',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'working');
    assert.equal(store.list(wsId).length, 0);

    // 3. Reliable completion signal: working -> idle transitions to finished
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: randomUUID() as any,
      previousActivity: 'working',
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'finished');

    // Notification created for finished state
    const notifications = store.list(wsId);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.state, 'finished');
    assert.equal(notifications[0]?.read, false);

    // 4. 'finished' state persists even if underlying CLI reports idle again
    await manager.handleCliActivity({
      workspaceId: wsId,
      tabId,
      sessionId: randomUUID() as any,
      nextActivity: 'idle',
      lifecycle: 'running',
    });
    assert.equal(manager.getTabState(wsId, tabId), 'finished');

    // 5. Reading notification in inbox does NOT acknowledge the tab
    await store.markRead(notifications[0]!.id);
    assert.equal(store.get(notifications[0]!.id)?.read, true);
    assert.equal(manager.getTabState(wsId, tabId), 'finished'); // Tab is still finished!

    // 6. User inspects/opens the tab -> acknowledgeTab returns tab to idle
    const record = await manager.acknowledgeTab(wsId, tabId);
    assert.equal(record?.state, 'idle');
    assert.equal(manager.getTabState(wsId, tabId), 'idle');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Shell terminal activity: OSC 133 sequences vs arbitrary output', () => {
  const parser = new ShellIntegrationParser();

  // 1. Without shell integration, state is explicitly unknown
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.isIntegrationEstablished(), false);

  // 2. Arbitrary PTY output is NOT treated as completion or start
  parser.feed('user@host:~$ ls -la\r\ntotal 0\r\n');
  assert.equal(parser.getState(), 'unknown');
  assert.equal(parser.isIntegrationEstablished(), false);

  // 3. Prompt start sequence (OSC 133 ; A)
  parser.feed(ShellSequences.promptStart);
  assert.equal(parser.isIntegrationEstablished(), true);
  assert.equal(parser.getState(), 'idle');

  // 4. Command start sequence (OSC 133 ; C)
  parser.feed(ShellSequences.commandStart);
  assert.equal(parser.getState(), 'working');

  // 5. Normal output during execution
  parser.feed('compiling build artifacts...\r\n');
  assert.equal(parser.getState(), 'working');

  // 6. Command exit sequence with code 0 (OSC 133 ; D ; 0) -> reliable completion -> finished
  parser.feed(ShellSequences.commandExit(0));
  assert.equal(parser.getState(), 'finished');
  assert.equal(parser.getLastExitCode(), 0);

  // 7. Finished state persists across prompt start until acknowledged
  parser.feed(ShellSequences.promptStart);
  assert.equal(parser.getState(), 'finished');

  parser.acknowledge();
  assert.equal(parser.getState(), 'idle');

  // 8. Command exit with non-zero code -> failed
  parser.feed(ShellSequences.commandStart);
  assert.equal(parser.getState(), 'working');
  parser.feed(ShellSequences.commandExit(127));
  assert.equal(parser.getState(), 'failed');
  assert.equal(parser.getLastExitCode(), 127);

  // 9. Streaming across split chunks
  const parserSplit = new ShellIntegrationParser();
  parserSplit.feed('\x1b]133;');
  parserSplit.feed('C\x07');
  assert.equal(parserSplit.getState(), 'working');
  parserSplit.feed('\x1b]133;D');
  parserSplit.feed(';0\x1b\\');
  assert.equal(parserSplit.getState(), 'finished');
});

test('ChatGPT provider interface: background execution and limitation reporting', () => {
  const provider = new ChatGPTActivityProvider();

  // 1. Limitations are explicitly reported
  const report = provider.limitationReport();
  assert.ok(report.includes('No Public Webhook / Completion API'));
  assert.ok(report.includes('Private APIs Forbidden'));
  assert.ok(report.includes('Content Scraping Forbidden'));
  assert.ok(report.includes('Network-Idle / Page-Load Insufficient'));
  assert.ok(report.includes('Same-Origin Policy'));

  // 2. Without verified companion bridge, completion cannot be proven
  assert.equal(provider.canProveCompletion(), false);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'unknown');

  // 3. Register verified bridge and receive verified signal
  provider.registerVerifiedBridge('bridge-extension-01');
  assert.equal(provider.canProveCompletion(), true);

  let observedEvent: any = null;
  const unsubscribe = provider.observeTab('tab-chatgpt-1', (event) => {
    observedEvent = event;
  });

  const reported = provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    signalType: 'extension-bridge',
    state: 'working',
    notes: 'Assistant generation started in background',
  });
  assert.equal(reported, true);
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'working');
  assert.equal(observedEvent?.state, 'working');
  assert.equal(observedEvent?.evidence?.verified, true);

  // Verified completion signal
  provider.reportVerifiedSignal({
    tabId: 'tab-chatgpt-1',
    signalType: 'web-notification',
    state: 'finished',
    notes: 'Permitted notification received',
  });
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'finished');

  // Acknowledge tab on inspection
  provider.acknowledgeTab('tab-chatgpt-1');
  assert.equal(provider.getActivity('tab-chatgpt-1'), 'idle');

  unsubscribe();
});

test('AgencyNotificationStore: persistence, backup recovery and deduplication', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-store-test-'));
  const file = path.join(dir, 'agency-notifications.json');

  try {
    const store = new AgencyNotificationStore(file);
    await store.initialize();

    const wsId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();

    // 1. Create notification with deduplication key
    const notif1 = await store.create({
      workspaceId: wsId,
      tabId,
      title: 'Build finished',
      body: 'Compilation completed with exit code 0',
      state: 'finished',
      deduplicationKey: 'build-tab-1',
    });
    assert.ok(notif1);
    assert.equal(store.unreadCount(wsId), 1);

    // 2. Duplicate completion signal with same key within window is ignored
    const notifDuplicate = await store.create({
      workspaceId: wsId,
      tabId,
      title: 'Build finished (repeated)',
      body: 'Repeated event',
      state: 'finished',
      deduplicationKey: 'build-tab-1',
    });
    assert.equal(notifDuplicate, null); // Deduplicated!
    assert.equal(store.unreadCount(wsId), 1);

    // 3. Mark read
    await store.markRead(notif1!.id);
    assert.equal(store.unreadCount(wsId), 0);
    assert.equal(store.get(notif1!.id)?.read, true);

    // 4. Dismiss toast does NOT delete history
    await store.dismiss(notif1!.id);
    assert.equal(store.list(wsId).length, 1);
    assert.ok(store.get(notif1!.id)?.dismissedAt);

    await store.flush();

    // 5. Restore from new instance (simulating server restart)
    const storeAfterRestart = new AgencyNotificationStore(file);
    await storeAfterRestart.initialize();
    const loadedList = storeAfterRestart.list(wsId);
    assert.equal(loadedList.length, 1);
    assert.equal(loadedList[0]?.id, notif1!.id);
    assert.equal(loadedList[0]?.read, true);

    // 6. Test backup recovery on corrupt primary
    await writeFile(file, '{ invalid json');
    const storeFromBackup = new AgencyNotificationStore(file);
    await storeFromBackup.initialize();
    assert.equal(storeFromBackup.list(wsId).length, 1);
    assert.equal(storeFromBackup.list(wsId)[0]?.id, notif1!.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
