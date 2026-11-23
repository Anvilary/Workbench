import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  allocateDownloadTarget,
  browserDownloadHandler,
  formatDuplicateFilename,
  readRememberedDownloadDirectory,
  rememberCompletedDownloadPath,
  resolveDefaultDownloadsDirectory,
  resolveDownloadsDirectory,
  sanitizeDownloadFilename,
  writeRememberedDownloadDirectory,
} from '../../../src/browser/downloads.mjs';
import {
  downloadDestinationAllowed,
  downloadOriginAllowed,
} from '../../../src/browser/provider-policy.mjs';

function makeItem({
  origin = 'https://www.perplexity.ai',
  url = 'https://www.perplexity.ai/export.md',
  chain = [url],
  filename = 'export.md',
  totalBytes = 100,
  receivedBytes = 50,
  canResume = true,
} = {}) {
  let savedPath = '';
  let dialogOptions = null;
  let cancelled = false;
  return Object.assign(new EventEmitter(), {
    getInitiatorOrigin: () => origin,
    getURL: () => url,
    getURLChain: () => chain,
    getFilename: () => filename,
    getTotalBytes: () => totalBytes,
    getReceivedBytes: () => receivedBytes,
    canResume: () => canResume,
    setSavePath(target) {
      savedPath = target;
    },
    getSavePath: () => savedPath,
    setSaveDialogOptions(opts) {
      dialogOptions = opts;
    },
    getSaveDialogOptions: () => dialogOptions,
    cancel() {
      cancelled = true;
    },
    wasCancelled: () => cancelled,
  });
}

async function createHarness(t, { provider = 'perplexity', pageUrl = 'https://www.perplexity.ai/', downloadsDir, userDataDir, autoSave } = {}) {
  const contents = Object.assign(new EventEmitter(), { getURL: () => pageUrl });
  const views = new Map([['tab', { webContents: contents }]]);
  const providers = new Map([['tab', provider]]);
  const popupOwners = new Map();
  const popups = new Set();
  const activeDownloads = new Map();
  const reservedPaths = new Set();
  const events = [];
  const readyIds = [];
  let dir = downloadsDir;
  let uDir = userDataDir;
  if (!dir) {
    dir = await mkdtemp(path.join(tmpdir(), 'maw-dl-unit-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
  }
  if (!uDir) {
    uDir = await mkdtemp(path.join(tmpdir(), 'maw-dl-userdata-'));
    t.after(() => rm(uDir, { recursive: true, force: true }));
  }
  const fakeApp = {
    getPath(name) {
      if (name === 'downloads') return dir;
      if (name === 'userData') return uDir;
      return dir;
    },
  };
  const handler = browserDownloadHandler({
    provider,
    views,
    providers,
    popupOwners,
    popups,
    activeDownloads,
    reservedPaths,
    allowedOrigin: (value) => downloadOriginAllowed(provider, value),
    allowedDestination: (value) => downloadDestinationAllowed(provider, value),
    windowForContents: () => null,
    downloadsDirectory: () => resolveDownloadsDirectory(fakeApp),
    rememberDownloadDirectory: (savedFilePath) => rememberCompletedDownloadPath(savedFilePath, { app: fakeApp }),
    ...(autoSave !== undefined ? { autoSave: () => autoSave } : {}),
    send: (evt) => events.push(evt),
    ready: (id) => readyIds.push(id),
  });
  return { handler, dir, userDataDir: uDir, fakeApp, contents, views, providers, popupOwners, popups, activeDownloads, reservedPaths, events, readyIds };
}

test('rejected downloads never alter concurrent download registrations', () => {
  const contents = {};
  const activeDownloads = new Map();
  const handler = browserDownloadHandler({
    provider: 'github', views: new Map([['tab', { webContents: contents }]]), providers: new Map([['tab', 'github']]),
    popupOwners: new Map(), popups: new Set(), activeDownloads,
    allowedOrigin: value => value === 'https://github.com', allowedDestination: value => value === 'https://github.com/file',
    windowForContents: () => null, downloadsDirectory: () => '/tmp', autoSave: () => false, send: () => {}, ready: () => {},
  });
  const item = (origin = 'https://github.com', url = 'https://github.com/file') => Object.assign(new EventEmitter(), {
    getInitiatorOrigin: () => origin, getURL: () => url, getURLChain: () => [url], getFilename: () => 'file.txt', setSaveDialogOptions: () => {},
  });
  const event = { preventDefault() { this.denied = true; } };
  const a = item(), b = item();
  handler(event, a, contents); handler(event, b, contents);
  assert.equal(activeDownloads.get('tab'), 2);
  handler(event, item('https://attacker.com'), contents);
  assert.equal(event.denied, true);
  assert.equal(activeDownloads.get('tab'), 2);
  handler(event, item('https://github.com', 'https://attacker.com/file'), contents);
  assert.equal(activeDownloads.get('tab'), 2);
  a.emit('done', {}, 'cancelled');
  assert.equal(activeDownloads.get('tab'), 1);
  a.emit('done', {}, 'cancelled');
  assert.equal(activeDownloads.get('tab'), 1);
  b.emit('done', {}, 'interrupted');
  assert.equal(activeDownloads.has('tab'), false);
});

test('1. Valid HTTPS download opens native Save As dialog by default and respects user directory and filename changes', async (t) => {
  const { handler, dir, userDataDir, contents, activeDownloads, events, readyIds } = await createHarness(t, { provider: 'perplexity' });
  const customDir = path.join(dir, 'Documents', 'Research');
  await mkdir(customDir, { recursive: true });

  const item = makeItem({
    origin: 'https://www.perplexity.ai',
    url: 'https://www.perplexity.ai/exports/answer.md',
    filename: 'answer.md',
  });
  const event = { preventDefault() { this.denied = true; } };
  handler(event, item, contents);
  assert.equal(event.denied, undefined);
  assert.equal(item.getSavePath(), '', 'must not auto-save by default; native Save As dialog must open');
  assert.deepEqual(item.getSaveDialogOptions(), {
    defaultPath: path.join(dir, 'answer.md'),
    title: 'Save File',
  });
  assert.equal(activeDownloads.get('tab'), 1);
  assert.deepEqual(events[0], { type: 'download-start', id: 'tab', filename: 'answer.md' });

  item.emit('updated', {}, 'progressing');
  assert.deepEqual(events[1], { type: 'download-progress', id: 'tab', filename: 'answer.md', percent: 50 });

  // Simulate user choosing a different directory and renaming the file in Save As
  const userChosenPath = path.join(customDir, 'renamed-notes.md');
  await writeFile(userChosenPath, '# Research Notes');
  item.setSavePath(userChosenPath);
  item.emit('done', {}, 'completed');

  assert.equal(activeDownloads.has('tab'), false);
  assert.deepEqual(events[2], {
    type: 'download-complete',
    id: 'tab',
    filename: 'renamed-notes.md',
    savePath: userChosenPath,
  });
  assert.deepEqual(readyIds, ['tab']);
  assert.equal(readRememberedDownloadDirectory(userDataDir), customDir);
});

test('1b. Explicit autoSave compatibility mode sets savePath directly and remembers directory', async (t) => {
  const { handler, dir, userDataDir, contents, events } = await createHarness(t, { provider: 'perplexity', autoSave: true });
  const item = makeItem({
    origin: 'https://www.perplexity.ai',
    url: 'https://www.perplexity.ai/exports/auto.md',
    filename: 'auto.md',
  });
  const expectedPath = path.join(dir, 'auto.md');
  handler({ preventDefault() {} }, item, contents);
  assert.equal(item.getSavePath(), expectedPath);
  assert.equal(item.getSaveDialogOptions(), null);
  await writeFile(expectedPath, 'auto');
  item.emit('done', {}, 'completed');
  assert.equal(events.at(-1)?.savePath, expectedPath);
  assert.equal(readRememberedDownloadDirectory(userDataDir), dir);
});

test('1c. Remembered download directory persists across restarts, ignores cancel/failure, and falls back when deleted', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'maw-dl-persist-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const defaultDir = path.join(base, 'Downloads');
  const researchDir = path.join(base, 'Documents', 'Research');
  const userDataDir = path.join(base, 'userData');
  await mkdir(defaultDir, { recursive: true });
  await mkdir(researchDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });

  const session1 = await createHarness(t, { provider: 'perplexity', downloadsDir: defaultDir, userDataDir });

  // 1) First download defaults to ~/Downloads; user saves in ~/Documents/Research
  const item1 = makeItem({ filename: 'paper.pdf' });
  session1.handler({ preventDefault() {} }, item1, session1.contents);
  assert.equal(item1.getSaveDialogOptions().defaultPath, path.join(defaultDir, 'paper.pdf'));
  const saved1 = path.join(researchDir, 'paper.pdf');
  await writeFile(saved1, 'pdf-1');
  item1.setSavePath(saved1);
  item1.emit('done', {}, 'completed');

  // 2) Next download defaults to ~/Documents/Research; user cancels
  const item2 = makeItem({ filename: 'cancelled.pdf' });
  session1.handler({ preventDefault() {} }, item2, session1.contents);
  assert.equal(item2.getSaveDialogOptions().defaultPath, path.join(researchDir, 'cancelled.pdf'));
  item2.emit('done', {}, 'cancelled');
  assert.equal(readRememberedDownloadDirectory(userDataDir), researchDir);

  // 3) Failing download preserves ~/Documents/Research
  const item3 = makeItem({ filename: 'failed.pdf' });
  session1.handler({ preventDefault() {} }, item3, session1.contents);
  assert.equal(item3.getSaveDialogOptions().defaultPath, path.join(researchDir, 'failed.pdf'));
  item3.emit('updated', {}, 'interrupted');
  assert.equal(readRememberedDownloadDirectory(userDataDir), researchDir);

  // 4) Simulated restart: new harness on a different provider reads the same userDataDir
  const session2 = await createHarness(t, {
    provider: 'github',
    pageUrl: 'https://github.com/owner/repo',
    downloadsDir: defaultDir,
    userDataDir,
  });
  const item4 = makeItem({
    origin: 'https://github.com',
    url: 'https://objects.githubusercontent.com/archive.zip',
    filename: 'archive.zip',
  });
  session2.handler({ preventDefault() {} }, item4, session2.contents);
  assert.equal(item4.getSaveDialogOptions().defaultPath, path.join(researchDir, 'archive.zip'));
  item4.emit('done', {}, 'cancelled');

  // Check preference file permissions and symlink rejection
  const prefStat = await lstat(path.join(userDataDir, 'download-preferences.json'));
  assert.equal(prefStat.mode & 0o777, 0o600);

  // 5) Delete remembered directory -> graceful fallback to default Downloads directory
  await rm(researchDir, { recursive: true, force: true });
  const item5 = makeItem({
    origin: 'https://github.com',
    url: 'https://objects.githubusercontent.com/fallback.zip',
    filename: 'fallback.zip',
  });
  session2.handler({ preventDefault() {} }, item5, session2.contents);
  assert.equal(item5.getSaveDialogOptions().defaultPath, path.join(defaultDir, 'fallback.zip'));
  item5.emit('done', {}, 'cancelled');

  // Symlink preference file is ignored
  const outsideDir = path.join(base, 'outside');
  await mkdir(outsideDir);
  const linkSource = path.join(base, 'target-prefs.json');
  await writeFile(linkSource, JSON.stringify({ lastDownloadDirectory: outsideDir }));
  await rm(path.join(userDataDir, 'download-preferences.json'));
  await symlink(linkSource, path.join(userDataDir, 'download-preferences.json'));
  assert.equal(readRememberedDownloadDirectory(userDataDir), null);
  assert.equal(writeRememberedDownloadDirectory(userDataDir, outsideDir), false);
});

test('2. Valid Perplexity Blob downloads accepted for www.perplexity.ai and perplexity.ai', async (t) => {
  const { handler, dir, contents, events } = await createHarness(t, { provider: 'perplexity' });
  for (const [origin, filename] of [
    ['https://www.perplexity.ai', 'summary.md'],
    ['https://perplexity.ai', 'citations.csv'],
  ]) {
    const blobUrl = `blob:${origin}/50740af6-1336-4a78-9c98-818e5a1e9b60`;
    const item = makeItem({ origin, url: blobUrl, chain: [blobUrl], filename });
    const event = { preventDefault() { this.denied = true; } };
    handler(event, item, contents);
    assert.equal(event.denied, undefined);
    const expected = path.join(dir, filename);
    assert.equal(item.getSaveDialogOptions().defaultPath, expected);
    await writeFile(expected, 'blob');
    item.setSavePath(expected);
    item.emit('done', {}, 'completed');
  }
  assert.equal(events.filter(e => e.type === 'download-complete').length, 2);
});

test('3. Invalid Blob origins and HTTP-to-blob chains are rejected with failure notification', async (t) => {
  const { handler, contents, events, activeDownloads } = await createHarness(t, { provider: 'perplexity' });
  const cases = [
    { origin: 'https://www.perplexity.ai', url: 'blob:https://evil.com/11111111-1111-1111-1111-111111111111' },
    { origin: 'https://www.perplexity.ai', url: 'blob:https://chatgpt.com/11111111-1111-1111-1111-111111111111' },
    { origin: 'https://www.perplexity.ai', url: 'blob:null/11111111-1111-1111-1111-111111111111' },
    {
      origin: 'https://www.perplexity.ai',
      url: 'blob:https://www.perplexity.ai/11111111-1111-1111-1111-111111111111',
      chain: ['https://www.perplexity.ai/redirect', 'blob:https://www.perplexity.ai/11111111-1111-1111-1111-111111111111'],
    },
  ];
  for (const c of cases) {
    const item = makeItem({ ...c, filename: 'secret.pdf' });
    const event = { preventDefault() { this.denied = true; } };
    handler(event, item, contents);
    assert.equal(event.denied, true);
    assert.equal(item.getSavePath(), '');
    assert.equal(item.getSaveDialogOptions(), null);
  }

  const other = await createHarness(t, { provider: 'other', pageUrl: 'https://docs.example.com/guide' });
  const crossOriginBlob = makeItem({
    origin: 'https://docs.example.com',
    url: 'blob:https://other.example.net/11111111-1111-1111-1111-111111111111',
    filename: 'cross.txt',
  });
  const crossEvent = { preventDefault() { this.denied = true; } };
  other.handler(crossEvent, crossOriginBlob, other.contents);
  assert.equal(crossEvent.denied, true);
  assert.equal(activeDownloads.size, 0);
  assert.equal(events.length, 4);
  assert.ok(events.every(e => e.type === 'download-failed' && e.reason === 'blocked'));
});

test('4. Unauthorized download destinations are rejected', async (t) => {
  const { handler, contents, events } = await createHarness(t, { provider: 'perplexity' });
  for (const badUrl of [
    'https://untrusted.example.com/payload.pdf',
    'https://accounts.google.com/o/oauth2/auth',
    'http://www.perplexity.ai/insecure.pdf',
  ]) {
    const item = makeItem({ origin: 'https://www.perplexity.ai', url: badUrl, filename: 'bad.pdf' });
    const event = { preventDefault() { this.denied = true; } };
    handler(event, item, contents);
    assert.equal(event.denied, true);
  }
  const other = await createHarness(t, { provider: 'other', pageUrl: 'https://example.com/' });
  const loopbackItem = makeItem({ origin: 'https://example.com', url: 'http://127.0.0.1:8080/secret.txt', filename: 'secret.txt' });
  const loopbackEvent = { preventDefault() { this.denied = true; } };
  other.handler(loopbackEvent, loopbackItem, other.contents);
  assert.equal(loopbackEvent.denied, true);
  assert.equal(events.length, 3);
  assert.ok(events.every(e => e.type === 'download-failed' && e.reason === 'blocked'));
});

test('5. Unsafe redirect chains are rejected while trusted Perplexity CDN redirect chains succeed', async (t) => {
  const { handler, dir, contents, events } = await createHarness(t, { provider: 'perplexity' });

  const unsafeItem = makeItem({
    origin: 'https://www.perplexity.ai',
    url: 'https://untrusted.example.com/file.pdf',
    chain: ['https://www.perplexity.ai/export', 'https://untrusted.example.com/file.pdf'],
    filename: 'file.pdf',
  });
  const unsafeEvent = { preventDefault() { this.denied = true; } };
  handler(unsafeEvent, unsafeItem, contents);
  assert.equal(unsafeEvent.denied, true);
  assert.equal(events.at(-1)?.type, 'download-failed');

  const safeItem = makeItem({
    origin: 'https://www.perplexity.ai',
    url: 'https://cdn.perplexity.ai/exports/report.pdf',
    chain: ['https://www.perplexity.ai/export', 'https://cdn.perplexity.ai/exports/report.pdf'],
    filename: 'report.pdf',
  });
  const safeEvent = { preventDefault() { this.denied = true; } };
  handler(safeEvent, safeItem, contents);
  assert.equal(safeEvent.denied, undefined);
  const expected = path.join(dir, 'report.pdf');
  assert.equal(safeItem.getSaveDialogOptions().defaultPath, expected);
  await writeFile(expected, 'pdf');
  safeItem.setSavePath(expected);
  safeItem.emit('done', {}, 'completed');
  assert.equal(events.at(-1)?.type, 'download-complete');
});

test('6. Missing ownership or provider mismatch is rejected without altering state', async (t) => {
  const { handler, contents, providers, activeDownloads, events } = await createHarness(t, { provider: 'perplexity' });

  const unknownContents = Object.assign(new EventEmitter(), { getURL: () => 'https://www.perplexity.ai/' });
  const item1 = makeItem();
  const event1 = { preventDefault() { this.denied = true; } };
  handler(event1, item1, unknownContents);
  assert.equal(event1.denied, true);

  providers.set('tab', 'chatgpt');
  const item2 = makeItem();
  const event2 = { preventDefault() { this.denied = true; } };
  handler(event2, item2, contents);
  assert.equal(event2.denied, true);

  assert.equal(activeDownloads.size, 0);
  assert.equal(events.length, 0);
});

test('7. Download directory resolution prefers OS Downloads, resolves ~/Downloads on Linux fallback, and fails closed when unavailable', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'maw-dl-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const customDownloads = path.join(base, 'CustomDownloads');
  await mkdir(customDownloads);
  assert.equal(
    resolveDefaultDownloadsDirectory({ getPath: (name) => (name === 'downloads' ? customDownloads : base) }),
    customDownloads,
  );

  // When Electron falls back to home because XDG user-dirs is absent, resolve ~/Downloads if present
  const userDownloads = path.join(base, 'Downloads');
  await mkdir(userDownloads);
  assert.equal(
    resolveDownloadsDirectory({ getPath: (name) => (name === 'userData' ? path.join(base, 'missing-ud') : base) }),
    userDownloads,
  );

  // Unavailable directory fails closed without falling back
  const missingDir = path.join(base, 'does-not-exist');
  const missingHarness = await createHarness(t, { downloadsDir: missingDir });
  const itemMissing = makeItem({ filename: 'report.pdf' });
  const eventMissing = { preventDefault() { this.denied = true; } };
  missingHarness.handler(eventMissing, itemMissing, missingHarness.contents);
  assert.equal(eventMissing.denied, true);
  assert.deepEqual(missingHarness.events[0], {
    type: 'download-failed',
    id: 'tab',
    filename: 'report.pdf',
    reason: 'destination-unavailable',
  });

  // Read-only directory fails closed when not running as root
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const roDir = path.join(base, 'readonly');
    await mkdir(roDir, { mode: 0o555 });
    t.after(() => chmod(roDir, 0o755).catch(() => {}));
    const roHarness = await createHarness(t, { downloadsDir: roDir });
    const itemRo = makeItem({ filename: 'report.pdf' });
    const eventRo = { preventDefault() { this.denied = true; } };
    roHarness.handler(eventRo, itemRo, roHarness.contents);
    assert.equal(eventRo.denied, true);
    assert.equal(roHarness.events[0]?.reason, 'destination-unavailable');
  }
});

test('8. Safe filename sanitization strips traversal, absolute paths, control chars, and invalid names', () => {
  assert.equal(sanitizeDownloadFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDownloadFilename('..\\..\\Windows\\System32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeDownloadFilename('/var/tmp/secret.txt'), 'secret.txt');
  assert.equal(sanitizeDownloadFilename('a\u0000b\nc:d*e?f"g<h>i|j.pdf'), 'a_b_c_d_e_f_g_h_i_j.pdf');
  assert.equal(sanitizeDownloadFilename(''), 'download');
  assert.equal(sanitizeDownloadFilename(null), 'download');
  assert.equal(sanitizeDownloadFilename('.'), 'download');
  assert.equal(sanitizeDownloadFilename('..'), 'download');
  assert.equal(sanitizeDownloadFilename('...'), 'download');
  assert.equal(sanitizeDownloadFilename('.pdf'), 'download.pdf');
  assert.equal(sanitizeDownloadFilename('report.pdf...  '), 'report.pdf');
  const longName = sanitizeDownloadFilename(`${'x'.repeat(250)}.pdf`);
  assert.ok(longName.length <= 200);
  assert.ok(longName.endsWith('.pdf'));
});

test('9. Duplicate filename handling preserves existing files and allocates report (1).pdf, report (2).pdf', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dl-dup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, 'report.pdf'), 'original-0');
  await writeFile(path.join(dir, 'report (1).pdf'), 'original-1');
  assert.equal(formatDuplicateFilename('report.pdf', 0), 'report.pdf');
  assert.equal(formatDuplicateFilename('report.pdf', 1), 'report (1).pdf');
  assert.equal(formatDuplicateFilename('report.pdf', 2), 'report (2).pdf');

  const { handler, contents, events } = await createHarness(t, { downloadsDir: dir });
  const item = makeItem({ filename: 'report.pdf' });
  const event = { preventDefault() { this.denied = true; } };
  handler(event, item, contents);
  assert.equal(event.denied, undefined);
  const expected = path.join(dir, 'report (2).pdf');
  assert.equal(item.getSaveDialogOptions().defaultPath, expected);
  await writeFile(expected, 'new-2');
  item.setSavePath(expected);
  item.emit('done', {}, 'completed');

  assert.equal(await readFile(path.join(dir, 'report.pdf'), 'utf8'), 'original-0');
  assert.equal(await readFile(path.join(dir, 'report (1).pdf'), 'utf8'), 'original-1');
  assert.deepEqual(events.at(-1), {
    type: 'download-complete',
    id: 'tab',
    filename: 'report (2).pdf',
    savePath: expected,
  });
});

test('10. Concurrent download collision handling allocates distinct Save As defaults and releases reservations on finish', async (t) => {
  const { handler, dir, contents, reservedPaths, events } = await createHarness(t);
  const items = [0, 1, 2].map(() => makeItem({ filename: 'report.pdf' }));
  for (const item of items) {
    const event = { preventDefault() { this.denied = true; } };
    handler(event, item, contents);
    assert.equal(event.denied, undefined);
  }

  assert.deepEqual(items.map(i => i.getSaveDialogOptions().defaultPath), [
    path.join(dir, 'report.pdf'),
    path.join(dir, 'report (1).pdf'),
    path.join(dir, 'report (2).pdf'),
  ]);
  assert.equal(reservedPaths.size, 3);

  items[1].emit('done', {}, 'cancelled');
  assert.equal(reservedPaths.size, 2);

  const reused = allocateDownloadTarget(dir, 'report.pdf', reservedPaths);
  assert.equal(reused.filename, 'report (1).pdf');
  reservedPaths.delete(reused.targetPath);

  await writeFile(path.join(dir, 'report.pdf'), '0');
  await writeFile(path.join(dir, 'report (2).pdf'), '2');
  items[0].setSavePath(path.join(dir, 'report.pdf'));
  items[2].setSavePath(path.join(dir, 'report (2).pdf'));
  items[0].emit('done', {}, 'completed');
  items[2].emit('done', {}, 'completed');
  assert.equal(reservedPaths.size, 0);
  assert.equal(events.filter(e => e.type === 'download-complete').length, 2);
});

test('11. Download cancellation emits download-cancelled, closes popup, and cleans up bookkeeping', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dl-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tabContents = Object.assign(new EventEmitter(), { getURL: () => 'https://www.perplexity.ai/' });
  const popupContents = Object.assign(new EventEmitter(), { getURL: () => 'https://www.perplexity.ai/popup' });
  let popupClosed = false;
  let popupHidden = false;
  const popup = {
    hide() { popupHidden = true; },
    close() { popupClosed = true; },
    isDestroyed: () => popupClosed,
  };
  const activeDownloads = new Map();
  const reservedPaths = new Set();
  const events = [];
  const handler = browserDownloadHandler({
    provider: 'perplexity',
    views: new Map([['tab', { webContents: tabContents }]]),
    providers: new Map([['tab', 'perplexity']]),
    popupOwners: new Map([[popupContents, 'tab']]),
    popups: new Set([popup]),
    activeDownloads,
    reservedPaths,
    allowedOrigin: (v) => downloadOriginAllowed('perplexity', v),
    allowedDestination: (v) => downloadDestinationAllowed('perplexity', v),
    windowForContents: (c) => (c === popupContents ? popup : null),
    downloadsDirectory: () => dir,
    send: (evt) => events.push(evt),
    ready: () => {},
  });

  const item = makeItem({ filename: 'popup.pdf' });
  handler({ preventDefault() {} }, item, popupContents);
  assert.equal(popupHidden, true);
  assert.equal(activeDownloads.get('tab'), 1);

  item.emit('done', {}, 'cancelled');
  assert.equal(popupClosed, true);
  assert.equal(activeDownloads.has('tab'), false);
  assert.equal(reservedPaths.size, 0);
  assert.deepEqual(events.at(-1), { type: 'download-cancelled', id: 'tab', filename: 'popup.pdf' });
});

test('12. Download failure notification handles interrupted updates (even when canResume is true) without leaking sensitive URLs', async (t) => {
  const { handler, contents, activeDownloads, reservedPaths, events } = await createHarness(t);
  const sensitiveUrl = 'https://www.perplexity.ai/download?token=super-secret-signed-token';
  const item = makeItem({ url: sensitiveUrl, chain: [sensitiveUrl], filename: 'export.pdf', canResume: true });
  handler({ preventDefault() {} }, item, contents);

  item.emit('updated', {}, 'interrupted');
  item.emit('done', {}, 'cancelled');

  assert.equal(item.wasCancelled(), true);
  assert.equal(activeDownloads.has('tab'), false);
  assert.equal(reservedPaths.size, 0);
  const failedEvents = events.filter(e => e.type === 'download-failed');
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].filename, 'export.pdf');
  assert.equal(events.some(e => e.type === 'download-cancelled'), false);
  assert.equal(JSON.stringify(events).includes('super-secret-signed-token'), false);
});

test('13. Active-download bookkeeping cleans up on render-process-gone and destroyed', async (t) => {
  const { handler, contents, activeDownloads, reservedPaths, events } = await createHarness(t);

  const item1 = makeItem({ filename: 'one.pdf' });
  handler({ preventDefault() {} }, item1, contents);
  assert.equal(activeDownloads.get('tab'), 1);
  contents.emit('render-process-gone');
  assert.equal(activeDownloads.has('tab'), false);
  assert.equal(reservedPaths.size, 0);
  assert.equal(events.at(-1)?.type, 'download-failed');

  const item2 = makeItem({ filename: 'two.pdf' });
  handler({ preventDefault() {} }, item2, contents);
  assert.equal(activeDownloads.get('tab'), 1);
  contents.emit('destroyed');
  assert.equal(activeDownloads.has('tab'), false);
  assert.equal(reservedPaths.size, 0);
});
