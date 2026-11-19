import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [downloadEvent, setDownloadEvent] = useState(null);
  const [allEvents, setAllEvents] = useState([]);

  useEffect(() => {
    const bridge = window.mawChatGpt;
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
    const bridge = window.mawChatGpt;
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
        MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        MAW_DESKTOP_DATA_DIR: data,
        MAW_DOWNLOAD_AUTO_SAVE: '1',
      },
    });

    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:maw-chatgpt').protocol.handle('https', (req) => {
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

    // Wait briefly for failure to settle
    await new Promise(r => setTimeout(r, 600));
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
      await win.webContents.executeJavaScript(`window.mawChatGpt.command({ type: 'browser-action', id: '${tabId}', action: 'reload' })`);
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
      await win.webContents.executeJavaScript(`window.mawChatGpt.command({ type: 'update', id: '${tabId}', url: 'https://chatgpt.com/' })`);
    }, id);

    // Give time for any unexpected backward navigation to settle
    await new Promise(r => setTimeout(r, 600));

    // Verify no backward navigation occurred: live URL remains at the conversation URL
    assert.equal((await nativeState()).url, 'https://chatgpt.com/c/active-conversation', 'Live URL must remain on current page without backward navigation');

    // Now send the updated checkpoint once the server confirms it
    await desktop.evaluate(async ({ BrowserWindow }, tabId) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Workbench'));
      await win.webContents.executeJavaScript(`window.mawChatGpt.command({ type: 'update', id: '${tabId}', url: 'https://chatgpt.com/c/active-conversation' })`);
    }, id);

    await new Promise(r => setTimeout(r, 300));
    assert.equal((await nativeState()).url, 'https://chatgpt.com/c/active-conversation', 'Live URL remains steady after checkpoint update');
  } finally {
    if (desktop) await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
});
