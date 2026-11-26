import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

// Interaction-level coverage for the tab close confirmation keyboard contract:
// Enter confirms once, Escape cancels, keys never reach a focused xterm,
// focus is restored, and the open-file branch submits once.
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WorkspaceSessionDialogs } from './src/features/workspaces/WorkspaceSessionDialogs.tsx';

window.events = [];
window.termData = [];
window.windowKeys = [];
window.closeOnConfirm = false;
window.addEventListener('keydown', (event) => window.windowKeys.push(event.key));

const terminalTab = (id) => ({ id, kind: 'native', session: { id: 's-' + id, kind: 'terminal', lifecycle: 'running', tab: { name: 'Shell ' + id } } });
window.terminalTab = terminalTab;

function Harness() {
  const [state, setState] = useState({ closing: null, fileDialog: null, inFlight: false, busy: false, online: true, filePathInput: '' });
  window.setHarness = (patch) => setState((prev) => ({ ...prev, ...patch }));
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'opener', type: 'button' }, 'Opener'),
    React.createElement('div', { id: 'term', style: { width: '400px', height: '200px' } }),
    React.createElement(WorkspaceSessionDialogs, {
      ...state,
      configuringProfileOpen: false,
      error: null,
      profiles: [],
      unsavedTabIds: new Set(),
      onChangeFilePathInput: (value) => setState((prev) => ({ ...prev, filePathInput: value })),
      onDismiss: () => { window.events.push('dismiss'); setState((prev) => ({ ...prev, closing: null, fileDialog: null })); },
      onConfirmClose: (tab) => {
        window.events.push('confirm:' + tab.id);
        if (window.closeOnConfirm) setState((prev) => ({ ...prev, closing: null }));
      },
      onConfirmOpenFile: (filePath) => {
        window.events.push('open:' + filePath);
        return new Promise((resolve) => setTimeout(resolve, 300));
      },
    }),
  );
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
const waitTerm = () => {
  const host = document.getElementById('term');
  if (!host) { requestAnimationFrame(waitTerm); return; }
  const terminal = new Terminal({ cols: 40, rows: 8 });
  terminal.open(host);
  terminal.onData((data) => window.termData.push(data));
  window.terminal = terminal;
};
waitTerm();
`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

async function setup(t) {
  const executablePath = browserExecutable();
  if (!executablePath) return null;
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminal && window.setHarness);
  return { page, errors };
}

const events = (page) => page.evaluate(() => window.events.slice());
const activeId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent || document.activeElement?.tagName);

async function openClose(page, id, patch = {}) {
  await page.evaluate(({ id, patch }) => {
    window.events = [];
    window.termData = [];
    window.windowKeys = [];
    window.setHarness({ closing: window.terminalTab(id), fileDialog: null, inFlight: false, busy: false, online: true, ...patch });
  }, { id, patch });
  await page.waitForSelector('.agency-modal-backdrop');
}

async function closeDialog(page) {
  await page.evaluate(() => window.setHarness({ closing: null, fileDialog: null, inFlight: false, busy: false }));
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });
}

test('tab close confirmation keyboard contract', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) { t.skip('Chromium is not installed'); return; }
  const { page, errors } = ctx;

  // Confirm is the default focused control.
  await page.focus('#opener');
  await openClose(page, 'a');
  assert.equal(await activeId(page), 'Close session');

  // Enter confirms once; a second Enter and a click cannot confirm again.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Close session' }).click();
  assert.deepEqual(await events(page), ['confirm:a']);
  assert.deepEqual(await page.evaluate(() => window.windowKeys), [], 'handled Enter must not reach window listeners');
  await closeDialog(page);

  // A held Enter (repeat=true) never confirms, and the event is consumed.
  await openClose(page, 'b');
  const repeat = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(repeat, true);
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  assert.deepEqual(await events(page), ['confirm:b']);
  await closeDialog(page);

  // Enter while in flight or offline does nothing; Escape while in flight is ignored.
  await openClose(page, 'c', { inFlight: true });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.deepEqual(await events(page), []);
  assert.equal(await page.locator('.agency-modal-backdrop').count(), 1);
  await page.evaluate(() => window.setHarness({ inFlight: false, online: false }));
  await page.keyboard.press('Enter');
  assert.deepEqual(await events(page), []);
  await closeDialog(page);

  // Escape cancels and restores focus to the previously focused element.
  await page.focus('#opener');
  await openClose(page, 'd');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });
  assert.deepEqual(await events(page), ['dismiss']);
  assert.equal(await activeId(page), 'opener');

  // A focused Cancel button keeps native activation: Enter cancels.
  await openClose(page, 'e');
  await page.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });
  assert.deepEqual(await events(page), ['dismiss']);
  assert.deepEqual(await page.evaluate(() => window.windowKeys), [], 'Enter on Cancel must not reach window listeners');

  // Tab and Shift+Tab stay trapped inside the dialog.
  await openClose(page, 'f');
  await page.keyboard.press('Tab');
  assert.equal(await activeId(page), 'Cancel');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await activeId(page), 'Close session');
  await closeDialog(page);

  // Keys are never delivered to a focused xterm while the dialog is open,
  // and completion restores focus to the terminal.
  await page.evaluate(() => window.terminal.focus());
  await page.evaluate(() => { window.closeOnConfirm = true; });
  await openClose(page, 'g');
  await page.evaluate(() => window.terminal.focus());
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });
  assert.deepEqual(await events(page), ['confirm:g']);
  assert.deepEqual(await page.evaluate(() => window.termData), [], 'Enter must not reach the terminal');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true, 'focus returns to the terminal');
  await openClose(page, 'h');
  await page.evaluate(() => window.terminal.focus());
  await page.keyboard.press('Escape');
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.termData), [], 'Escape must not reach the terminal');
  await page.evaluate(() => { window.closeOnConfirm = false; });

  // Sanity: with no dialog open the terminal does receive Enter.
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.termData), ['\r']);

  // The open-file branch keeps native form submission and submits once.
  await page.evaluate(() => { window.events = []; window.setHarness({ fileDialog: { paneId: 'p1' }, filePathInput: 'notes.md' }); });
  await page.waitForSelector('.agency-modal-backdrop');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  assert.deepEqual(await events(page), ['open:notes.md']);
  // Once the attempt settles a retry is allowed again.
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  assert.deepEqual(await events(page), ['open:notes.md', 'open:notes.md']);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });

  assert.deepEqual(errors, []);
});
