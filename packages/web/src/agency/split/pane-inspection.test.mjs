import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fixture, html, workspaceId, tabA, tabB } from './pane-inspection-fixture.mjs';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
}

async function setup(t, web = false) {
  const executablePath = browserExecutable();
  assert.ok(executablePath, 'Chromium is required for the pane inspection regression');
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto('http://127.0.0.1:' + server.address().port + (web ? '/?web' : '/'));
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelectorAll('.maw-split-pane').length === 2);
  if (!web) await page.waitForFunction(() => window.terminals.length === 2);
  await frames(page);
  return page;
}

const frames = (page, count = 4) => page.evaluate(async (count) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
}, count);
const focus = (page, side) => page.locator('#pane-container-' + side + ' .maw-pane-header').click({ position: { x: 4, y: 4 } });
const ackIds = page => page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge').map(m => m.tabId));
const consistent = async (page, side, id) => {
  try {
    await page.waitForFunction(({ side, id, ws }) =>
      document.querySelector('.maw-split-pane.is-focused')?.id === 'pane-container-' + side && window.inspection.state.selected[ws] === id,
    { side, id, ws: workspaceId });
  } catch (error) {
    const state = await page.evaluate(() => ({ focus: document.querySelector('.maw-split-pane.is-focused')?.id, selected: window.inspection.state.selected, requests: window.inspection.requests.filter(m => m.type.startsWith('agency.')) }));
    throw new Error(JSON.stringify(state), { cause: error });
  }
};

test('visible running CLIs retain background completion until the completed pane is inspected', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => window.inspection.finish(id), tabB);
  await frames(page);
  assert.deepEqual(await ackIds(page), []);
  assert.equal(await page.locator('.maw-session-pane:visible').count(), 2);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  await consistent(page, 'right', tabB);
  assert.deepEqual(await ackIds(page), [tabB]);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabA), 'working');
  assert.equal(await page.evaluate(() => window.inspection.frontend.unread), 1, 'inspection keeps inbox read state independent');
  for (let i = 0; i < 5; i++) { await focus(page, 'left'); await focus(page, 'right'); }
  await frames(page);
  assert.deepEqual(await ackIds(page), [tabB]);
  assert.equal(await page.evaluate(() => window.disposed), 0);
  assert.equal(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'terminal.attach').length), 2);
  assert.equal(await page.evaluate(() => window.inspection.requests.some(m => m.type === 'terminal.detach' || m.action === 'resume' || m.action === 'close' || m.type === 'agency.session.create')), false);
});

test('rapid focus changes serialize asynchronous selection and suppress stale inspections', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => { window.inspection.finish(id); window.inspection.delay(true); }, tabB);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.pending.length === 1);
  await focus(page, 'left');
  await page.evaluate(() => window.inspection.resolve());
  await page.waitForFunction(() => window.inspection.pending[0]?.message.tabId === '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(await ackIds(page), []);
  assert.equal(await page.locator('.maw-split-pane.is-focused').getAttribute('id'), 'pane-container-left');
  await page.evaluate(() => { window.inspection.delay(false); window.inspection.resolve(); });
  await consistent(page, 'left', tabA);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  assert.deepEqual(await ackIds(page), [tabB]);
});

test('a second visible pane cannot overwrite display readiness for the inspected pane', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => window.inspection.finish(id), tabA);
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  assert.deepEqual(await ackIds(page), [tabA]);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabB), 'working');
  // A pointer released outside its pane must not suppress a later keyboard focus.
  await page.locator('#pane-container-right').dispatchEvent('pointerdown', { bubbles: true });
  await page.locator('body').dispatchEvent('pointerup', { bubbles: true });
  await page.locator('#pane-container-left').focus();
  await consistent(page, 'left', tabA);
  await page.locator('#pane-container-right').focus();
  await consistent(page, 'right', tabB);
  assert.deepEqual(await ackIds(page), [tabA]);
});

test('in-flight acknowledgement is not duplicated or overtaken by later selections', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => { window.inspection.delayAck(true); window.inspection.finish(id); }, tabB);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.pendingAcks.length === 1);
  await focus(page, 'left'); await focus(page, 'right');
  await frames(page);
  assert.deepEqual(await ackIds(page), [tabB]);
  assert.equal(await page.evaluate(ws => window.inspection.state.selected[ws], workspaceId), tabB);
  await page.evaluate(() => { window.inspection.delayAck(false); window.inspection.resolveAck(); });
  await frames(page);
  assert.deepEqual(await ackIds(page), [tabB]);
  await consistent(page, 'right', tabB);
});

test('selection and acknowledgement failures preserve completion and allow a deliberate retry', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => { window.inspection.finish(id); window.inspection.fail(); }, tabB);
  await focus(page, 'right');
  await page.getByRole('alert').filter({ hasText: 'Selection rejected' }).waitFor();
  await consistent(page, 'left', tabA);
  assert.deepEqual(await ackIds(page), []);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabB), 'finished');
  await page.evaluate(() => window.inspection.failAck());
  await focus(page, 'right');
  await page.getByRole('alert').filter({ hasText: 'Acknowledgement rejected' }).waitFor();
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabB), 'finished');
  await focus(page, 'left'); await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.frontend.activities.some(a => a.state === 'idle'));
  assert.deepEqual(await ackIds(page), [tabB, tabB], 'only an explicit retry follows the failed acknowledgement');
});

test('workspace changes, reconnect snapshots and application reload retain pending and acknowledged state', { timeout: 30000 }, async t => {
  const page = await setup(t);
  await page.evaluate(id => { window.inspection.finish(id); window.inspection.delay(true); }, tabB);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.pending.length === 1);
  await page.evaluate(() => window.inspection.switchWorkspace());
  await page.getByRole('tab', { name: /CLI 3/ }).waitFor();
  await page.evaluate(() => { window.inspection.delay(false); window.inspection.resolve(); });
  await frames(page);
  assert.deepEqual(await ackIds(page), []);
  await page.evaluate(() => window.inspection.switchWorkspace());
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  await focus(page, 'left');
  await page.evaluate(id => window.inspection.finish(id, 'turn-2'), tabB);
  await page.evaluate(() => window.inspection.online(false));
  await frames(page);
  await page.evaluate(() => window.inspection.online(true));
  await frames(page);
  assert.deepEqual(await ackIds(page), [tabB]);
  await page.reload(); await page.locator('#start').click(); await frames(page);
  assert.deepEqual(await ackIds(page), []);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabB), 'finished');
  assert.equal(await page.evaluate(() => window.inspection.frontend.unread), 2);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  await page.reload(); await page.locator('#start').click(); await frames(page);
  assert.deepEqual(await ackIds(page), []);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabB), 'idle');
});

test('two visible ChatGPT panes report independently and retain view identities on focus changes', { timeout: 30000 }, async t => {
  const page = await setup(t, true);
  await page.waitForFunction(() => window.inspection.nativeCommands.filter(m => m.type === 'layout').at(-1)?.views.length === 2);
  await page.evaluate(id => window.inspection.finish(id), tabB);
  await frames(page);
  assert.deepEqual(await ackIds(page), []);
  await focus(page, 'right');
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  for (let i = 0; i < 4; i++) { await focus(page, 'left'); await focus(page, 'right'); }
  await frames(page);
  assert.deepEqual(await ackIds(page), [tabB]);
  const commands = await page.evaluate(() => window.inspection.nativeCommands);
  assert.deepEqual(commands.filter(m => m.type === 'open').map(m => m.id).sort(), [tabA, tabB]);
  assert.equal(commands.some(m => ['close', 'navigate', 'reload'].includes(m.type)), false);
  const firstBoth = commands.findIndex(m => m.type === 'layout' && m.views.length === 2);
  assert.equal(commands.slice(firstBoth).filter(m => m.type === 'layout').every(m => m.views.length === 2), true);
  await consistent(page, 'right', tabB);
});
