import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [downloadEvent, setDownloadEvent] = useState(null);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge) return;

    return bridge.subscribe((state) => {
      if (state.type.startsWith('download-')) {
        setDownloadEvent(state);
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
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function eventually(check, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for condition');
}

test('FEATURE 10: ChatGPT file download lifecycle in real Electron', { timeout: 60000 }, async () => {
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
  const downloadsDir = path.join(data, 'Downloads');

  let desktop;
  try {
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: require('electron'),
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
        if (url.pathname === '/sample.pdf') {
          return new Response('%PDF-1.4 sample content', {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="chatgpt-report.pdf"',
            },
          });
        }
        return new Response('<!doctype html><title>ChatGPT</title><a id="dl-link" href="https://chatgpt.com/sample.pdf" download="chatgpt-report.pdf">Download PDF</a>', {
          headers: { 'Content-Type': 'text/html' },
        });
      });
    });

    const page = await desktop.firstWindow();
    await page.click('#btn-start');

    const attached = () => desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).length
    );
    await eventually(async () => (await attached()) === 1);
    await eventually(() => desktop.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents)?.webContents;
      return contents?.getURL() === 'https://chatgpt.com/' && !contents.isLoading();
    }));

    // Trigger download in the native view
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents);
      view.webContents.downloadURL('https://chatgpt.com/sample.pdf');
    });

    // Check that download completed and emitted event to renderer
    await eventually(async () => {
      const text = await page.textContent('#event-state');
      return text && text.includes('download-complete');
    });

    const finalEvent = JSON.parse((await page.textContent('#event-state')) || '{}');
    assert.equal(finalEvent.type, 'download-complete');
    assert.equal(finalEvent.filename, 'chatgpt-report.pdf');
    assert.equal(finalEvent.id, id);
    assert.ok(finalEvent.savePath, 'Must report savePath');

    // Verify file content on disk
    const savedContent = await readFile(finalEvent.savePath, 'utf8');
    assert.equal(savedContent, '%PDF-1.4 sample content');
    // Clean up test downloaded file
    await rm(finalEvent.savePath, { force: true });
  } finally {
    if (desktop) await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
});
