import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from './agency-notification-store.js';
import { TabActivityManager } from './tab-activity-manager.js';

for (const kind of ['notifications', 'activity'] as const) test(`${kind}: recovered primary cannot poison backup on the next write`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-round2-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, kind + '.json');
  const workspaceId = randomUUID() as WorkspaceId, tabId = randomUUID();
  const notifications = new AgencyNotificationStore(kind === 'notifications' ? file : path.join(root, 'inbox.json'));
  await notifications.initialize();
  const open = async () => {
    if (kind === 'notifications') { const store = new AgencyNotificationStore(file); await store.initialize(); return store; }
    const manager = new TabActivityManager({ notificationStore: notifications, filePath: file });
    await manager.initialize(); t.after(() => manager.dispose()); return manager;
  };
  const mutate = async (store: AgencyNotificationStore | TabActivityManager, n: number) => {
    if (store instanceof AgencyNotificationStore) await store.create({ workspaceId, tabId, title: 'Fixture', body: 'done', state: 'finished', deduplicationKey: 'turn-' + n });
    else await store.ensureTab({ workspaceId, tabId: n === 1 ? tabId : randomUUID(), source: 'cli' });
  };
  const original = await open(); await mutate(original, 1); await mutate(original, 2);
  const backup = JSON.parse(await readFile(file + '.bak', 'utf8'));
  await writeFile(file, '{broken primary');
  const recovered = await open(); await mutate(recovered, 3);
  // A second interrupted write must still leave a validated recovery copy.
  await writeFile(file, '{second broken primary');
  const twice = await open();
  if (twice instanceof AgencyNotificationStore) assert.equal(twice.list()[0]?.deduplicationKey, backup.notifications[0].deduplicationKey);
  else assert.ok(twice.getRecord(workspaceId, tabId));
});

for (const kind of ['notifications', 'activity'] as const) test(`${kind}: both corrupt refuse startup and retain evidence; missing primary restores backup`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-round2-corruption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, kind + '.json');
  const notifications = new AgencyNotificationStore(path.join(root, 'inbox.json')); await notifications.initialize();
  const open = async () => {
    const store = kind === 'notifications' ? new AgencyNotificationStore(file) : new TabActivityManager({ notificationStore: notifications, filePath: file });
    if (store instanceof TabActivityManager) t.after(() => store.dispose());
    await store.initialize();
    return store;
  };
  await writeFile(file, '{primary broken'); await writeFile(file + '.bak', '{backup broken');
  await assert.rejects(open(), AggregateError);
  assert.equal(await readFile(file, 'utf8'), '{primary broken');
  assert.equal(await readFile(file + '.bak', 'utf8'), '{backup broken');
  await rm(file);
  const backup = JSON.stringify(kind === 'notifications' ? { version: 1, notifications: [] } : { version: 1, records: [], pendingNotifications: [] });
  await writeFile(file + '.bak', backup);
  await open();
  assert.equal(await readFile(file + '.bak', 'utf8'), backup, 'recovery must retain the only validated copy');
});
