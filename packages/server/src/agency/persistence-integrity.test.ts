import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgencyLayoutStore } from './agency-layout-store.js';
import { AgencyNotificationStore } from './agency-notification-store.js';
import { TabActivityManager } from './tab-activity-manager.js';

test('versioned Agency metadata refuses future schemas without overwriting a valid backup', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-schema-preservation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fixtures = [
    {
      name: 'layout',
      file: path.join(dir, 'layouts.json'),
      snapshot: (version: number) => ({ version, layouts: [] }),
      load: (file: string) => new AgencyLayoutStore(file).load(),
    },
    {
      name: 'notification',
      file: path.join(dir, 'notifications.json'),
      snapshot: (version: number) => ({ version, notifications: [] }),
      load: (file: string) => new AgencyNotificationStore(file).load(),
    },
    {
      name: 'activity',
      file: path.join(dir, 'activity.json'),
      snapshot: (version: number) => ({ version, records: [] }),
      load: (file: string) => new TabActivityManager({
        filePath: file,
        notificationStore: new AgencyNotificationStore(path.join(dir, 'notifications-dependency.json')),
      }).load(),
    },
  ];

  for (const { name, file, snapshot, load } of fixtures) {
    await t.test(name, async () => {
      const future = JSON.stringify(snapshot(99));
      const supported = JSON.stringify(snapshot(1));
      await writeFile(file, future);
      await writeFile(file + '.bak', supported);
      await assert.rejects(load(file), /Unsupported .* version/i);
      assert.equal(await readFile(file, 'utf8'), future, 'future primary remains untouched');
      assert.equal(await readFile(file + '.bak', 'utf8'), supported, 'valid backup remains untouched');

      // The backup must also refuse an unsupported schema after primary corruption.
      await writeFile(file, 'not JSON');
      await writeFile(file + '.bak', future);
      await assert.rejects(load(file), /Unsupported .* version/i);
      assert.equal(await readFile(file, 'utf8'), 'not JSON');
      assert.equal(await readFile(file + '.bak', 'utf8'), future);
    });
  }
  assert.equal((await readdir(dir)).some(filename => filename.includes('.corrupt-')), false);
});

test('layout metadata recovers from backup instead of silently omitting malformed records', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-layout-record-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layouts.json');
  const wsId = '11111111-1111-4111-8111-111111111111';
  const validLayout = {
    version: 1,
    workspaceId: wsId,
    tree: { type: 'pane', id: 'pane-1', tabIds: [], selectedTabId: null },
    focusedPaneId: 'pane-1',
    maximizedPaneId: null,
    updatedAt: '2026-10-31T00:00:00.000Z',
  };

  await writeFile(file + '.bak', JSON.stringify({ version: 1, layouts: [validLayout] }));
  await writeFile(file, JSON.stringify({ version: 1, layouts: [validLayout, { broken: true }] }));

  const recovered = await new AgencyLayoutStore(file).load();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.workspaceId, wsId);
  assert.deepEqual(recovered[0], validLayout);
  assert.equal((await readdir(dir)).some(filename => filename.includes('.corrupt-')), true);
  assert.equal((await readFile(file + '.bak', 'utf8')).includes(wsId), true);
});
