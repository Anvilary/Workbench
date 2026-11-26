import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || (fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron'));
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [downloadEvent, setDownloadEvent] = useState(null);
  const [allEvents, setAllEvents] = useState([]);

  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;

    return bridge.subscribe((state) => {
      setAllEvents((prev) => [...prev, state]);
      if (state.type.startsWith('download-')) {
        setDownloadEvent(state);
      }
      if (state.type === 'layout-needed') {
        const v = { width: window.innerWidth, height: window.innerHeight };
        bridge.command({
          type: 'layout',
          views: [{ id: '${id}', bounds: { x: 0, y: 0, width: v.width, height: v.height } }],
          viewport: v,
        });
      }
    });
  }, []);

  const start = () => {
    const bridge = window.workbench;
    if (!bridge) return;
    const v = { width: window.innerWidth, height: window.innerHeight };
    bridge.command({ type: 'open', id: '${id}', url: 'https://chatgpt.com/' });
    bridge.command({
      type: 'layout',
      views: [{ id: '${id}', bounds: { x: 0, y: 0, width: v.width, height: v.height } }],
      viewport: v,
    });
  };

  return (
    <div>
      <button id="btn-start" onClick={start}>Start</button>
      <div id="event-state">{downloadEvent ? JSON.stringify(downloadEvent) : 'none'}</div>
      <div id="all-events">{JSON.stringify(allEvents)}</div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function eventually(check, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for condition');
}

test('FEATURE 10: ChatGPT file download lifecycle in real Electron with click navigation', { timeout: 90000 }, async () => {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle.outputFiles[0].text);
    } else {
      response.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-download-smoke-'));

  let desktop;
  try {
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: {
        ...process.env,
        HOME: data,
        WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        WORKBENCH_DESKTOP_DATA_DIR: data,
        WORKBENCH_DOWNLOAD_AUTO_SAVE: '1',
      },
    });

    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:workbench-chatgpt').protocol.handle('https', (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/direct.pdf') {
          return new Response('%PDF-1.4 direct content', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="chatgpt-direct.pdf"',
            },
          });
        }
        if (url.pathname === '/popup.pdf') {
          return new Response('%PDF-1.4 popup content', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="chatgpt-popup.pdf"',
            },
          });
        }
        if (url.pathname === '/redirect-target.pdf') {
          return new Response('%PDF-1.4 redirect content', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="chatgpt-redirect.pdf"',
            },
          });
        }
        if (url.pathname === '/redirect-download') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://files.oaiusercontent.com/redirect-target.pdf' },
          });
        }
        if (url.pathname === '/inline.pdf') {
          return new Response('%PDF-1.4 inline content', {
            headers: { 'Content-Type': 'application/pdf' },
          });
        }
        if (url.pathname === '/failing.pdf') {
          return Response.error();
        }
        if (url.hostname === 'chatgpt.com' && url.pathname === '/report.pdf') {
          return new Response('%PDF-1.4 chatgpt.com report content', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="chatgpt-report.pdf"',
            },
          });
        }
        if (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/c/')) {
          return new Response('<!doctype html><title>ChatGPT - Active Conversation</title><p>Active chat</p>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response(`<!doctype html>
          <title>ChatGPT</title>
          <a id="dl-direct" href="https://files.oaiusercontent.com/direct.pdf" download="chatgpt-direct.pdf">Direct</a>
          <a id="dl-chatgpt-report" href="https://chatgpt.com/report.pdf" download="chatgpt-report.pdf">ChatGPT Report</a>
          <a id="dl-popup" href="https://files.oaiusercontent.com/popup.pdf" target="_blank">Popup</a>
          <a id="dl-redirect" href="https://chatgpt.com/redirect-download">Redirect</a>
          <a id="dl-inline" href="https://files.oaiusercontent.com/inline.pdf">Inline</a>
          <a id="dl-fail" href="https://files.oaiusercontent.com/failing.pdf">Fail</a>
          <a id="dl-unauthorized" href="https://untrusted.example.com/untrusted.pdf" download="untrusted.pdf">Unauthorized</a>
        `, {
          headers: { 'Content-Type': 'text/html' },
        });
      });
    });

    const page = await desktop.firstWindow();
    await page.click('#btn-start');

    const getChatView = () => desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      return win?.contentView?.children?.find((v) => v.webContents);
    });

    await eventually(async () => {
      const count = await desktop.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
        return win?.contentView?.children?.filter((v) => v.webContents)?.length;
      });
      return count === 1;
    });

    await eventually(() => desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const contents = win?.contentView?.children?.find((v) => v.webContents)?.webContents;
      return contents?.getURL() === 'https://chatgpt.com/' && !contents.isLoading();
    }));

    // Helper to get native view state
    const nativeState = () => desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win?.contentView?.children?.find((v) => v.webContents);
      return {
        url: view?.webContents?.getURL(),
        isLoading: view?.webContents?.isLoading(),
      };
    });

    // 1. Direct attachment download via user click
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-direct').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('chatgpt-direct.pdf');
    });

    let event1 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event1.type, 'download-complete');
    assert.equal(event1.filename, 'chatgpt-direct.pdf');
    const directContent = await readFile(event1.savePath, 'utf8');
    assert.equal(directContent, '%PDF-1.4 direct content');
    await rm(event1.savePath, { force: true });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'Tab URL must stay chatgpt.com');

    // 1b. Direct attachment download from https://chatgpt.com/report.pdf (exercising chatUrl allowlist in will-download)
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-chatgpt-report').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('chatgpt-report.pdf');
    });

    let eventChatGpt = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(eventChatGpt.type, 'download-complete');
    assert.equal(eventChatGpt.filename, 'chatgpt-report.pdf');
    const chatGptContent = await readFile(eventChatGpt.savePath, 'utf8');
    assert.equal(chatGptContent, '%PDF-1.4 chatgpt.com report content');
    await rm(eventChatGpt.savePath, { force: true });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'Tab URL must stay chatgpt.com');

    // 2. Popup-initiated download via user click
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-popup').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('chatgpt-popup.pdf');
    });

    let event2 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event2.type, 'download-complete');
    assert.equal(event2.filename, 'chatgpt-popup.pdf');
    const popupContent = await readFile(event2.savePath, 'utf8');
    assert.equal(popupContent, '%PDF-1.4 popup content');
    await rm(event2.savePath, { force: true });
    // Verify no popup window remains open
    const winCountAfterPopup = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.equal(winCountAfterPopup, 1, 'Popup window must be closed after popup download');

    // 3. Redirect through allowed file-delivery host
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-redirect').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('chatgpt-redirect.pdf');
    });

    let event3 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event3.type, 'download-complete');
    assert.equal(event3.filename, 'chatgpt-redirect.pdf');
    const redirectContent = await readFile(event3.savePath, 'utf8');
    assert.equal(redirectContent, '%PDF-1.4 redirect content');
    await rm(event3.savePath, { force: true });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'Tab URL must stay chatgpt.com on redirect');

    // 4. Inline PDF response (navigation to file delivery URL without attachment header)
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-inline').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('inline.pdf');
    });

    let event4 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event4.type, 'download-complete');
    assert.equal(event4.filename, 'inline.pdf');
    const inlineContent = await readFile(event4.savePath, 'utf8');
    assert.equal(inlineContent, '%PDF-1.4 inline content');
    await rm(event4.savePath, { force: true });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'Main frame must not be replaced by inline PDF');

    // 5. Save As cancellation
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      view.webContents.session.once('will-download', (_e, item) => {
        setImmediate(() => item.cancel());
      });
      await view.webContents.executeJavaScript(`document.getElementById('dl-direct').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-cancelled');
    });

    let event5 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event5.type, 'download-cancelled');
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'URL remains chatgpt.com on cancel');

    // 6. Download failure followed by another download
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-fail').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-failed');
    });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'URL remains chatgpt.com on failure');

    // Second download succeeds immediately after
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      await view.webContents.executeJavaScript(`document.getElementById('dl-direct').click()`);
    });

    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete') && text.includes('chatgpt-direct.pdf');
    });

    let event6 = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(event6.type, 'download-complete');
    assert.equal(event6.filename, 'chatgpt-direct.pdf');
    await rm(event6.savePath, { force: true });
    assert.equal((await nativeState()).url, 'https://chatgpt.com/', 'URL remains chatgpt.com after retry');

    // 7. Verify did-stop-loading cannot mark a failed navigation successful
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chatgpt.com/error', true);
      view.webContents.emit('did-stop-loading');
    });
    await eventually(async () => {
      const events = (await page.textContent('#all-events')) || '[]';
      const parsed = JSON.parse(events);
      const last = parsed.filter(state => ['error', 'ready', 'loading'].includes(state.type)).at(-1);
      return last?.type === 'error' && last.message?.includes('failed to load (-105)');
    });
    // Verify no 'ready' event followed the error
    const eventsAfterStop = JSON.parse((await page.textContent('#all-events')) || '[]');
    assert.equal(eventsAfterStop.filter(state => ['error', 'ready', 'loading'].includes(state.type)).at(-1)?.type, 'error');

    // 8. Verify recovery via reload
    await desktop.evaluate(async ({ BrowserWindow }, tabId) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      await win.webContents.executeJavaScript(`window.workbench.command({ type: 'browser-action', id: '${tabId}', action: 'reload' })`);
    }, id);
    await eventually(async () => {
      const events = (await page.textContent('#all-events')) || '[]';
      const parsed = JSON.parse(events);
      const last = parsed.filter(state => ['error', 'ready', 'loading'].includes(state.type)).at(-1);
      return last?.type === 'ready';
    });

    // Verify view is still attached and usable
    assert.equal((await nativeState()).isLoading, false);

    // 9. Navigation reconciliation: in-page navigation must not navigate backward when delayed checkpoint sends old URL
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      const view = win.contentView.children.find((v) => v.webContents);
      // Simulate live in-page navigation (e.g. user opening conversation /c/active-conversation)
      await view.webContents.executeJavaScript(`window.history.pushState({}, '', '/c/active-conversation')`);
    });

    // Wait for committed event to propagate to the frontend
    await eventually(async () => {
      const events = (await page.textContent('#all-events')) || '[]';
      const parsed = JSON.parse(events);
      return parsed.some(e => e.type === 'committed' && e.url === 'https://chatgpt.com/c/active-conversation');
    });

    assert.equal((await nativeState()).url, 'https://chatgpt.com/c/active-conversation', 'Live URL must update to new path');

    // Send an unrelated tab update with the OLD persisted URL (checkpoint delayed)
    await desktop.evaluate(async ({ BrowserWindow }, tabId) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      await win.webContents.executeJavaScript(`window.workbench.command({ type: 'update', id: '${tabId}', url: 'https://chatgpt.com/' })`);
    }, id);

    // Give time for any unexpected backward navigation to settle
    await new Promise(r => setTimeout(r, 600));

    // Verify no backward navigation occurred: live URL remains at the conversation URL
    assert.equal((await nativeState()).url, 'https://chatgpt.com/c/active-conversation', 'Live URL must remain on current page without backward navigation');

    // Now send the updated checkpoint once the server confirms it
    await desktop.evaluate(async ({ BrowserWindow }, tabId) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      await win.webContents.executeJavaScript(`window.workbench.command({ type: 'update', id: '${tabId}', url: 'https://chatgpt.com/c/active-conversation' })`);
    }, id);

    await new Promise(r => setTimeout(r, 300));
    assert.equal((await nativeState()).url, 'https://chatgpt.com/c/active-conversation', 'Live URL remains steady after checkpoint update');
  } finally {
    if (desktop) await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
});

const multiProviderFixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;
    window.__openTab = (id, provider, url) => {
      const v = { width: window.innerWidth, height: window.innerHeight };
      bridge.command({ type: 'open', id, provider, url });
      bridge.command({
        type: 'layout',
        views: [{ id, bounds: { x: 0, y: 0, width: v.width, height: v.height } }],
        viewport: v,
      });
    };
    return bridge.subscribe((state) => {
      setEvents((prev) => [...prev, state]);
      if (state.type === 'layout-needed' && state.id) {
        const v = { width: window.innerWidth, height: window.innerHeight };
        bridge.command({
          type: 'layout',
          views: [{ id: state.id, bounds: { x: 0, y: 0, width: v.width, height: v.height } }],
          viewport: v,
        });
      }
    });
  }, []);

  return <div id="all-events">{JSON.stringify(events)}</div>;
}

createRoot(document.getElementById('root')).render(<App />);
`;

test('Download reliability: native Save As dialog, remembered directory across restarts, Perplexity, GitHub, General Web, Blob, redirects, duplicates, popups, and failures', { timeout: 120000 }, async () => {
  const bundle = await build({
    stdin: { contents: multiProviderFixture, resolveDir: path.join(here, '../web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle.outputFiles[0].text);
    } else {
      response.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const data = await mkdtemp(path.join(tmpdir(), 'maw-download-reliability-'));
  const downloadsDir = path.join(data, 'Downloads');
  const researchDir = path.join(data, 'Documents', 'Research');
  const configDir = path.join(data, '.config');
  const userDataDir = path.join(data, 'desktop-profile');
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(researchDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });

  const pplxId = '11111111-1111-4111-8111-111111111111';
  const ghId = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';

  // Deliberately omit WORKBENCH_DOWNLOAD_AUTO_SAVE to verify native Save As is the interactive default
  const launchEnv = {
    ...process.env,
    HOME: data,
    XDG_CONFIG_HOME: configDir,
    WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
    WORKBENCH_DESKTOP_DATA_DIR: userDataDir,
    WORKBENCH_EXTERNAL_POLICY: 'deny',
  };
  delete launchEnv.WORKBENCH_DOWNLOAD_AUTO_SAVE;

  const installFixturesAndDialogDriver = async (app) => {
    await app.evaluate(({ session }) => {
      globalThis.dialogObservations = [];
      globalThis.dialogScript = [];

      for (const part of ['persist:workbench-perplexity', 'persist:workbench-github', 'persist:workbench-browser']) {
        const sess = session.fromPartition(part);
        sess.on('will-download', (event, item) => {
          if (event.defaultPrevented) {
            globalThis.dialogObservations.push({
              partition: part,
              rejected: true,
              url: item.getURL(),
              savePathBeforeDialog: item.getSavePath(),
              dialogOptions: typeof item.getSaveDialogOptions === 'function' ? item.getSaveDialogOptions() : null,
            });
            return;
          }
          const dialogOptions = typeof item.getSaveDialogOptions === 'function' ? item.getSaveDialogOptions() : null;
          const obs = {
            partition: part,
            rejected: false,
            filename: item.getFilename(),
            savePathBeforeDialog: item.getSavePath(),
            dialogOptions,
          };
          globalThis.dialogObservations.push(obs);
          const step = globalThis.dialogScript.shift() || { action: 'confirm-default' };
          if (step.action === 'cancel') {
            item.cancel();
          } else if (step.action === 'choose-path') {
            item.setSavePath(step.targetPath);
          } else if (dialogOptions?.defaultPath) {
            item.setSavePath(dialogOptions.defaultPath);
          }
        });
      }

      // Perplexity partition fixture
      const pplx = session.fromPartition('persist:workbench-perplexity');
      pplx.protocol.handle('https', (req) => {
        const u = new URL(req.url);
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/export.md') {
          return new Response('# Perplexity Direct Export\n', {
            headers: {
              'Content-Type': 'text/markdown',
              'Content-Disposition': 'attachment; filename="perplexity-direct.md"',
            },
          });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/redirect-export') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn.perplexity.ai/redirect-report.pdf' },
          });
        }
        if (u.hostname === 'cdn.perplexity.ai' && u.pathname === '/redirect-report.pdf') {
          return new Response('%PDF-1.4 pplx redirect', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="perplexity-redirect.pdf"',
            },
          });
        }
        if (u.hostname === 'cdn.perplexity.ai' && u.pathname === '/inline-export.md') {
          return new Response('# CDN Inline Export', {
            headers: { 'Content-Type': 'text/markdown' },
          });
        }
        if (u.hostname === 'cdn.perplexity.ai' && u.pathname === '/popup-direct.pdf') {
          return new Response('%PDF-1.4 pplx popup direct', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="popup-direct.pdf"',
            },
          });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/popup-page') {
          return new Response(`<!doctype html>
            <title>Perplexity Export Popup</title>
            <script>
              setTimeout(() => {
                const a = document.createElement('a');
                a.href = 'https://www.perplexity.ai/popup-attachment.pdf';
                a.download = 'popup-window.pdf';
                document.body.appendChild(a);
                a.click();
              }, 30);
            </script>
          `, { headers: { 'Content-Type': 'text/html' } });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/popup-attachment.pdf') {
          return new Response('%PDF-1.4 pplx popup window', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="popup-window.pdf"',
            },
          });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/report-v1.pdf') {
          return new Response('first-report-bytes', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="report.pdf"',
            },
          });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/report-v2.pdf') {
          return new Response('second-report-bytes', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="report.pdf"',
            },
          });
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/failing-export.pdf') {
          return Response.error();
        }
        if (u.hostname === 'www.perplexity.ai' && u.pathname === '/unsafe-redirect') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://untrusted.example.com/blocked.pdf' },
          });
        }
        if (u.hostname === 'untrusted.example.com') {
          return new Response('unauthorized-payload', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="blocked.pdf"',
            },
          });
        }
        return new Response(`<!doctype html>
          <title>Perplexity</title>
          <a id="dl-direct" href="https://www.perplexity.ai/export.md" download="perplexity-direct.md">Direct</a>
          <a id="dl-redirect" href="https://www.perplexity.ai/redirect-export">Redirect</a>
          <a id="dl-cdn-inline" href="https://cdn.perplexity.ai/inline-export.md">CDN Inline</a>
          <a id="dl-popup-direct" href="https://cdn.perplexity.ai/popup-direct.pdf" target="_blank">Popup Direct</a>
          <button id="dl-popup-window">Popup Window</button>
          <a id="dl-dup-1" href="https://www.perplexity.ai/report-v1.pdf" download="report.pdf">Dup 1</a>
          <a id="dl-dup-2" href="https://www.perplexity.ai/report-v2.pdf" download="report.pdf">Dup 2</a>
          <a id="dl-fail" href="https://www.perplexity.ai/failing-export.pdf?token=secret-url-token" download="failing-export.pdf">Fail</a>
          <a id="dl-unsafe-redirect" href="https://www.perplexity.ai/unsafe-redirect" download="blocked.pdf">Unsafe Redirect</a>
          <a id="dl-untrusted" href="https://untrusted.example.com/blocked.pdf" download="blocked.pdf">Untrusted</a>
          <button id="dl-blob">Blob</button>
          <button id="dl-bad-blob">Bad Blob</button>
          <script>
            document.getElementById('dl-blob').addEventListener('click', () => {
              const blob = new Blob(['# Perplexity Blob Export\\n'], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'perplexity-blob.md';
              document.body.appendChild(a);
              a.click();
            });
            document.getElementById('dl-popup-window').addEventListener('click', () => {
              window.open('https://www.perplexity.ai/popup-page', '_blank', 'width=500,height=600');
            });
            document.getElementById('dl-bad-blob').addEventListener('click', () => {
              window.open('blob:https://evil.example.com/11111111-1111-1111-1111-111111111111', '_blank');
            });
          </script>
        `, { headers: { 'Content-Type': 'text/html' } });
      });

      // GitHub partition fixture
      const gh = session.fromPartition('persist:workbench-github');
      gh.protocol.handle('https', (req) => {
        const u = new URL(req.url);
        if (u.hostname === 'github.com' && u.pathname === '/owner/repo/releases/download/v1.0/tool.tar.gz') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://objects.githubusercontent.com/tool.tar.gz' },
          });
        }
        if (u.hostname === 'objects.githubusercontent.com' && u.pathname === '/tool.tar.gz') {
          return new Response('github-release-bytes', {
            headers: {
              'Content-Type': 'application/gzip',
              'Content-Disposition': 'attachment; filename="tool.tar.gz"',
            },
          });
        }
        return new Response(`<!doctype html>
          <title>GitHub</title>
          <a id="gh-release" href="https://github.com/owner/repo/releases/download/v1.0/tool.tar.gz">Release</a>
          <button id="gh-blob">GH Blob</button>
          <script>
            document.getElementById('gh-blob').addEventListener('click', () => {
              const blob = new Blob(['github-blob-bytes'], { type: 'text/plain' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'github-blob.txt';
              document.body.appendChild(a);
              a.click();
            });
          </script>
        `, { headers: { 'Content-Type': 'text/html' } });
      });

      // General web ('other') partition fixture
      const other = session.fromPartition('persist:workbench-browser');
      other.protocol.handle('https', (req) => {
        const u = new URL(req.url);
        if (u.hostname === 'docs.example.org' && u.pathname === '/guide.pdf') {
          return new Response('%PDF-1.4 general web guide', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="guide.pdf"',
            },
          });
        }
        return new Response(`<!doctype html>
          <title>Example Docs</title>
          <a id="other-direct" href="https://docs.example.org/guide.pdf" download="guide.pdf">Guide</a>
          <button id="other-blob">Other Blob</button>
          <script>
            document.getElementById('other-blob').addEventListener('click', () => {
              const blob = new Blob(['other-blob-bytes'], { type: 'text/plain' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'other-blob.txt';
              document.body.appendChild(a);
              a.click();
            });
          </script>
        `, { headers: { 'Content-Type': 'text/html' } });
      });
    });
  };

  let desktop;
  try {
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: launchEnv,
    });

    let page = await desktop.firstWindow();
    await page.waitForFunction(() => typeof window.__openTab === 'function');
    await installFixturesAndDialogDriver(desktop);

    const getEvents = async () => JSON.parse((await page.textContent('#all-events')) || '[]');
    const waitForEvent = async (predicate) => {
      let found = null;
      await eventually(async () => {
        const all = await getEvents();
        found = all.find(predicate) || null;
        return !!found;
      });
      return found;
    };
    const queueDialog = (step) => desktop.evaluate((_electron, s) => globalThis.dialogScript.push(s), step);
    const popLastObservation = () => desktop.evaluate(() => globalThis.dialogObservations.at(-1));

    const clickInPartition = (partition, selector) => desktop.evaluate(async ({ webContents, session }, { part, sel }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition(part));
      await c.executeJavaScript(`document.querySelector(${JSON.stringify(sel)}).click()`);
    }, { part: partition, sel: selector });

    // --- 1. Perplexity scenarios ---
    await page.evaluate(({ id }) => window.__openTab(id, 'perplexity', 'https://www.perplexity.ai/'), { id: pplxId });
    await eventually(() => desktop.evaluate(({ webContents, session }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:workbench-perplexity'));
      return c?.getURL() === 'https://www.perplexity.ai/' && !c.isLoading();
    }));

    // 1a. First download opens Save As in ~/Downloads; user chooses ~/Documents/Research
    const researchFile = path.join(researchDir, 'perplexity-direct.md');
    await queueDialog({ action: 'choose-path', targetPath: researchFile });
    await clickInPartition('persist:workbench-perplexity', '#dl-direct');
    const evDirect = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.savePath === researchFile);
    const obsDirect = await popLastObservation();
    assert.equal(obsDirect.savePathBeforeDialog, '', 'Default mode must open Save As rather than auto-saving');
    assert.equal(obsDirect.dialogOptions.defaultPath, path.join(downloadsDir, 'perplexity-direct.md'), 'First download opens in Downloads');
    assert.equal(evDirect.savePath, researchFile);
    assert.equal(await readFile(researchFile, 'utf8'), '# Perplexity Direct Export\n');

    // 1b. Perplexity Blob download defaults Save As to remembered ~/Documents/Research
    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-blob');
    const evBlob = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'perplexity-blob.md');
    const obsBlob = await popLastObservation();
    assert.equal(obsBlob.dialogOptions.defaultPath, path.join(researchDir, 'perplexity-blob.md'), 'Next download remembers previous directory');
    assert.equal(path.dirname(evBlob.savePath), researchDir);
    assert.equal(await readFile(evBlob.savePath, 'utf8'), '# Perplexity Blob Export\n');

    // 1c. Cancelled Save As preserves remembered directory (~/Documents/Research)
    await queueDialog({ action: 'cancel' });
    await clickInPartition('persist:workbench-perplexity', '#dl-cdn-inline');
    await waitForEvent(e => e.id === pplxId && e.type === 'download-cancelled' && e.filename === 'inline-export.md');
    const obsCancel = await popLastObservation();
    assert.equal(obsCancel.dialogOptions.defaultPath, path.join(researchDir, 'inline-export.md'));

    // 1d. Failed download preserves remembered directory and does not leak query tokens
    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-fail');
    const evFail = await waitForEvent(e => e.id === pplxId && e.type === 'download-failed' && e.filename === 'failing-export.pdf');
    assert.equal(JSON.stringify(evFail).includes('secret-url-token'), false, 'Failure event must not leak URL query tokens');

    // 1e. Restart Electron with the same userData profile and verify remembered directory persists
    await desktop.close();
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: launchEnv,
    });
    page = await desktop.firstWindow();
    await page.waitForFunction(() => typeof window.__openTab === 'function');
    await installFixturesAndDialogDriver(desktop);
    await page.evaluate(({ id }) => window.__openTab(id, 'perplexity', 'https://www.perplexity.ai/'), { id: pplxId });
    await eventually(() => desktop.evaluate(({ webContents, session }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:workbench-perplexity'));
      return c?.getURL() === 'https://www.perplexity.ai/' && !c.isLoading();
    }));

    // User saves renamed file back in ~/Downloads via Save As
    const renamedPath = path.join(downloadsDir, 'custom-renamed.pdf');
    await queueDialog({ action: 'choose-path', targetPath: renamedPath });
    await clickInPartition('persist:workbench-perplexity', '#dl-redirect');
    const evRedirect = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'custom-renamed.pdf');
    const obsAfterRestart = await popLastObservation();
    assert.equal(obsAfterRestart.dialogOptions.defaultPath, path.join(researchDir, 'perplexity-redirect.pdf'), 'Remembered directory must survive restart');
    assert.equal(evRedirect.savePath, renamedPath);
    assert.equal(await readFile(renamedPath, 'utf8'), '%PDF-1.4 pplx redirect');

    // Now switch remembered directory to a temp folder, delete it, and verify safe fallback to ~/Downloads
    const transientDir = path.join(data, 'TransientFolder');
    await mkdir(transientDir, { recursive: true });
    await queueDialog({ action: 'choose-path', targetPath: path.join(transientDir, 'inline-export.md') });
    await clickInPartition('persist:workbench-perplexity', '#dl-cdn-inline');
    await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'inline-export.md');
    await rm(transientDir, { recursive: true, force: true });

    // 1f. Duplicate filenames in fallback ~/Downloads (report.pdf and report (1).pdf)
    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-dup-1');
    const evDup1 = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'report.pdf');
    const obsDup1 = await popLastObservation();
    assert.equal(obsDup1.dialogOptions.defaultPath, path.join(downloadsDir, 'report.pdf'), 'Deleted remembered folder falls back safely to Downloads');
    assert.equal(await readFile(evDup1.savePath, 'utf8'), 'first-report-bytes');

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-dup-2');
    const evDup2 = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'report (1).pdf');
    assert.equal(path.dirname(evDup2.savePath), downloadsDir);
    assert.equal(await readFile(evDup2.savePath, 'utf8'), 'second-report-bytes');
    assert.equal(await readFile(evDup1.savePath, 'utf8'), 'first-report-bytes', 'First report.pdf must not be overwritten');

    // 1g. Popup downloads (target=_blank delivery + window.open popup)
    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-popup-direct');
    const evPopupDirect = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'popup-direct.pdf');
    assert.equal(path.dirname(evPopupDirect.savePath), downloadsDir);
    assert.equal(await readFile(evPopupDirect.savePath, 'utf8'), '%PDF-1.4 pplx popup direct');

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-perplexity', '#dl-popup-window');
    const evPopupWindow = await waitForEvent(e => e.id === pplxId && e.type === 'download-complete' && e.filename === 'popup-window.pdf');
    assert.equal(path.dirname(evPopupWindow.savePath), downloadsDir);
    assert.equal(await readFile(evPopupWindow.savePath, 'utf8'), '%PDF-1.4 pplx popup window');
    await eventually(async () => (await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1);

    // 1h. Rejected downloads never open Save As, leave existing files untouched, and emit download-failed
    const sentinelPath = path.join(downloadsDir, 'blocked.pdf');
    await writeFile(sentinelPath, 'keep-intact');
    await desktop.evaluate(({ webContents, session }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:workbench-perplexity'));
      c.downloadURL('blob:https://evil.example.com/11111111-1111-1111-1111-111111111111');
      c.downloadURL('https://untrusted.example.com/blocked.pdf');
    });
    await waitForEvent(e => e.id === pplxId && e.type === 'download-failed' && e.reason === 'blocked' && e.filename === 'blocked.pdf');
    const obsRejected = await popLastObservation();
    assert.equal(obsRejected.rejected, true);
    assert.equal(obsRejected.dialogOptions?.defaultPath || '', '', 'Rejected download must not configure Save As dialog');
    await clickInPartition('persist:workbench-perplexity', '#dl-bad-blob');
    await clickInPartition('persist:workbench-perplexity', '#dl-unsafe-redirect');
    await clickInPartition('persist:workbench-perplexity', '#dl-untrusted');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep-intact');
    const filesInDownloads = await readdir(downloadsDir);
    assert.equal(filesInDownloads.some(f => f.startsWith('blocked (')), false);

    // --- 2. GitHub scenarios ---
    await page.evaluate(({ id }) => window.__openTab(id, 'github', 'https://github.com/owner/repo'), { id: ghId });
    await eventually(() => desktop.evaluate(({ webContents, session }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:workbench-github'));
      return c?.getURL() === 'https://github.com/owner/repo' && !c.isLoading();
    }));

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-github', '#gh-release');
    const evGhRelease = await waitForEvent(e => e.id === ghId && e.type === 'download-complete' && e.filename === 'tool.tar.gz');
    assert.equal(path.dirname(evGhRelease.savePath), downloadsDir);
    assert.equal(await readFile(evGhRelease.savePath, 'utf8'), 'github-release-bytes');

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-github', '#gh-blob');
    const evGhBlob = await waitForEvent(e => e.id === ghId && e.type === 'download-complete' && e.filename === 'github-blob.txt');
    assert.equal(path.dirname(evGhBlob.savePath), downloadsDir);
    assert.equal(await readFile(evGhBlob.savePath, 'utf8'), 'github-blob-bytes');

    // --- 3. General Web Page ('other') scenarios ---
    await page.evaluate(({ id }) => window.__openTab(id, 'other', 'https://docs.example.org/guide'), { id: otherId });
    await eventually(() => desktop.evaluate(({ webContents, session }) => {
      const c = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:workbench-browser'));
      return c?.getURL() === 'https://docs.example.org/guide' && !c.isLoading();
    }));

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-browser', '#other-direct');
    const evOtherDirect = await waitForEvent(e => e.id === otherId && e.type === 'download-complete' && e.filename === 'guide.pdf');
    assert.equal(path.dirname(evOtherDirect.savePath), downloadsDir);
    assert.equal(await readFile(evOtherDirect.savePath, 'utf8'), '%PDF-1.4 general web guide');

    await queueDialog({ action: 'confirm-default' });
    await clickInPartition('persist:workbench-browser', '#other-blob');
    const evOtherBlob = await waitForEvent(e => e.id === otherId && e.type === 'download-complete' && e.filename === 'other-blob.txt');
    assert.equal(path.dirname(evOtherBlob.savePath), downloadsDir);
    assert.equal(await readFile(evOtherBlob.savePath, 'utf8'), 'other-blob-bytes');
  } finally {
    if (desktop) await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
});
