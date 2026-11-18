// Browser regression for the lazily loaded xterm WebGL addon (Opt-C).
// Run: node --test packages/web/src/terminal-webgl.test.mjs
// Real TerminalView in real Chromium with code splitting: the default renderer never downloads the WebGL
// chunk and still shows PTY output; ?renderer=webgl downloads it on demand without errors (WebGL or the
// fallback); a terminal unmounted while the chunk is still loading never receives the late addon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  return undefined;
}

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalView } from './src/TerminalView.tsx';
const listeners = new Set();
const connection = {
  getStatus: () => 'open', onStatus: () => () => {}, onReopen: () => () => {},
  onMessage: fn => (listeners.add(fn), () => listeners.delete(fn)),
  send(m) { return this.sendImmediate(m); },
  sendImmediate(m) {
    window.sent.push(m.type);
    if (m.type === 'terminal.attach') queueMicrotask(() => { for (const fn of listeners) fn({ type: 'terminal.replay', terminalId: 'term', data: 'PTY-OUTPUT-OK\\r\\n', truncated: false }); });
    return true;
  },
};
window.sent = [];
function Harness() {
  const [mounted, setMounted] = useState(true);
  window.unmountTerminal = () => setMounted(false);
  return <div style={{ width: 800, height: 400 }}>{mounted && <TerminalView terminalId="term" connection={connection} active theme="dark" />}</div>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

test('xterm WebGL addon is fetched only on opt-in, works or falls back, and never attaches after unmount', { timeout: 120000 }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) { t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE'); return; }
  const result = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT, sourcefile: 'entry.tsx' },
    bundle: true, splitting: true, format: 'esm', write: false, outdir: '/out', jsx: 'automatic', logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  const files = new Map(result.outputFiles.map(file => [file.path.replace(/^\/out/, ''), file.text]));
  const webglChunk = [...files.entries()].find(([, text]) => text.includes('WebglAddon') || text.includes('webgl2'))?.[0];
  const entry = [...files.keys()].find(name => name.startsWith('/entry') || name.startsWith('/stdin'));
  assert.ok(entry && webglChunk && webglChunk !== entry, 'WebGL addon is a separate chunk');
  let delay = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (files.has(url.pathname)) {
      res.setHeader('Content-Type', 'text/javascript');
      setTimeout(() => res.end(files.get(url.pathname)), url.pathname === webglChunk ? delay : 0);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Software WebGL (SwiftShader) so the real WebGL path, not only the fallback, is exercised headlessly.
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

  async function open(search) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const logs = []; page.on('console', message => logs.push(message.text()));
    const requested = []; page.on('request', request => requested.push(new URL(request.url()).pathname));
    await page.goto(base + '/' + search);
    return { page, errors, requested, logs };
  }

  // Default renderer: output visible, no WebGL download.
  const plain = await open('');
  await plain.page.getByText('PTY-OUTPUT-OK').waitFor();
  await plain.page.waitForTimeout(500);
  assert.ok(!plain.requested.includes(webglChunk));
  assert.deepEqual(plain.errors, []);

  // Opt-in: chunk fetched; WebGL renders (canvas) or the default renderer is kept; output intact.
  const gl = await open('?renderer=webgl');
  await gl.page.waitForFunction(() => window.sent.includes('terminal.attach'));
  await gl.page.waitForFunction(chunk => performance.getEntriesByType('resource').some(e => e.name.endsWith(chunk)), webglChunk);
  await gl.page.waitForTimeout(500);
  assert.deepEqual(gl.errors, []);
  const usesCanvas = await gl.page.evaluate(() => document.querySelectorAll('.xterm canvas').length > 0);
  const webgl2 = await gl.page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  // Where the browser offers WebGL2 the addon MUST be active (this caught a lazy-import interop bug);
  // otherwise the default renderer must keep showing the output.
  if (webgl2) assert.ok(usesCanvas, 'WebGL renderer active when WebGL2 is available');
  else assert.ok((await gl.page.evaluate(() => document.querySelector('.xterm')?.textContent ?? '')).includes('PTY-OUTPUT-OK'));
  assert.ok(!gl.logs.some(line => line.includes('WebGL no disponible')), gl.logs.join('\n'));
  console.log('# webgl renderer active in headless Chromium: ' + usesCanvas);

  // Unmount while the WebGL chunk is still loading: no error, nothing attached to the disposed terminal.
  delay = 1500;
  const page = await browser.newPage();
  const lateErrors = []; page.on('pageerror', error => lateErrors.push(error.message));
  const lateLogs = []; page.on('console', message => lateLogs.push(message.text()));
  const requestStarted = page.waitForRequest(request => new URL(request.url()).pathname === webglChunk);
  const responseDone = page.waitForResponse(response => new URL(response.url()).pathname === webglChunk);
  await page.goto(base + '/?renderer=webgl');
  await requestStarted;                                   // addon requested, response still pending
  await page.evaluate(() => window.unmountTerminal());    // terminal disposed before the addon arrives
  await responseDone;
  await page.waitForTimeout(300);
  const late = { page, errors: lateErrors };
  assert.ok(!lateLogs.some(line => line.includes('WebGL')), 'late addon never touched the disposed terminal: ' + lateLogs.join(' | '));
  assert.deepEqual(late.errors, []);
  assert.equal(await late.page.evaluate(() => document.querySelectorAll('.xterm').length), 0);
});
