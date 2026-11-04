import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

// 12 distinct UUIDs for multi-tab test (more than the old hardcoded 8 limit)
const tabIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
];

const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge) return;
    return bridge.subscribe((state) => {
      setEvents((prev) => [...prev, state]);
    });
  }, []);

  return (
    <div>
      <div id="events-count">{events.length}</div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function eventually(check, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for condition');
}

test('resource-aware resident tab pool: creates >8 tabs, evicts LRU background views to budget, protects attached views, and transparently restores', { timeout: 90000 }, async () => {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
    } else {
      res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-resource-pool-test-'));
  let desktop;

  try {
    // Launch Electron with MAW_MAX_RESIDENT_VIEWS=5 to test pool eviction deterministically
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: {
        ...process.env,
        MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        MAW_DESKTOP_DATA_DIR: dataDir,
        MAW_MAX_RESIDENT_VIEWS: '5',
      },
    });

    // Intercept synthetic pages so tests run without live network requests
    await desktop.evaluate(({ session }) => {
      for (const partition of ['persist:maw-chatgpt', 'persist:maw-perplexity', 'persist:maw-github']) {
        session.fromPartition(partition).protocol.handle('https', (req) =>
          new Response(`<!doctype html><title>${req.url}</title><div>Mock page for ${req.url}</div>`, {
            headers: { 'Content-Type': 'text/html' },
          })
        );
      }
    });

    const page = await desktop.firstWindow();
    await page.waitForSelector('#events-count');

    // Helper to count resident tab WebContents
    const getResidentTabCount = async () => {
      return desktop.evaluate(({ webContents, session }) => {
        const partitions = [
          session.fromPartition('persist:maw-chatgpt'),
          session.fromPartition('persist:maw-perplexity'),
          session.fromPartition('persist:maw-github'),
        ];
        return webContents.getAllWebContents().filter((c) => partitions.includes(c.session)).length;
      });
    };

    // Helper to get attached views count in contentView
    const getAttachedCount = async () => {
      return desktop.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win ? win.contentView.children.length : 0;
      });
    };

    // 1. Open 12 tabs: 2 protected ChatGPT tabs (opened first, oldest), then 10 ordinary GitHub tabs
    for (let i = 0; i < tabIds.length; i++) {
      const id = tabIds[i];
      const provider = i < 2 ? 'chatgpt' : 'github';
      const url =
        provider === 'chatgpt'
          ? `https://chatgpt.com/c/mock-${i}`
          : `https://github.com/mock-repo-${i}`;

      const res = await page.evaluate(
        async ({ id, url, provider }) => {
          try {
            await window.mawChatGpt.command({ type: 'open', id, url, provider });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },
        { id, url, provider }
      );

      assert.equal(res.ok, true, `Opening tab ${i + 1} (${id}) must not throw: ${res.error}`);
    }

    // 2. Verify rolling resident pool bound: resident tabs must be capped at budget (5)
    await eventually(async () => {
      const count = await getResidentTabCount();
      return count <= 5;
    });

    const residentCount = await getResidentTabCount();
    assert.ok(
      residentCount <= 5,
      `Resident tabs (${residentCount}) must not exceed pool budget (5)`
    );

    // 3. Attach two visible panes (tabs 10 and 11) in layout
    const v = { width: 1280, height: 860 };
    await page.evaluate(
      ({ id1, id2, v }) => {
        window.mawChatGpt.command({
          type: 'layout',
          views: [
            { id: id1, bounds: { x: 0, y: 0, width: 600, height: 800 } },
            { id: id2, bounds: { x: 620, y: 0, width: 600, height: 800 } },
          ],
          viewport: v,
        });
      },
      { id1: tabIds[10], id2: tabIds[11], v }
    );

    await eventually(async () => (await getAttachedCount()) === 2);
    assert.equal(await getAttachedCount(), 2, 'Two views attached to contentView');

    // 4. Open tabs 0, 1, 2 again in the background. Attached views (tabs 10 & 11) must NOT be evicted!
    for (let i = 0; i < 3; i++) {
      const provider = i < 2 ? 'chatgpt' : 'github';
      const url = provider === 'chatgpt' ? `https://chatgpt.com/c/mock-${i}` : `https://github.com/mock-repo-${i}`;
      await page.evaluate(
        async ({ id, url, provider }) => {
          await window.mawChatGpt.command({ type: 'open', id, url, provider });
        },
        { id: tabIds[i], url, provider }
      );
    }

    // Wait a brief moment for pool reconciliations
    await new Promise((r) => setTimeout(r, 200));

    // Attached views must still be 2 (protected from eviction!)
    assert.equal(
      await getAttachedCount(),
      2,
      'Attached views must never be evicted by background tab pool'
    );

    // Total resident count still bounded by budget (or safeAttached if greater)
    const countAfterBackground = await getResidentTabCount();
    assert.ok(
      countAfterBackground <= 5,
      `Resident count (${countAfterBackground}) must remain within budget`
    );

    // 5. Transparent restoration: reopen tab 4 (which was evicted earlier)
    const restoreRes = await page.evaluate(
      async ({ id }) => {
        try {
          await window.mawChatGpt.command({
            type: 'open',
            id,
            url: 'https://github.com/mock-repo-4',
            provider: 'github',
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      { id: tabIds[4] }
    );
    assert.equal(restoreRes.ok, true, 'Restoring suspended tab must succeed');

    // 6. Retain and Close cleanup: retain only tabs 4, 10, 11
    await page.evaluate(
      async ({ keepIds }) => {
        await window.mawChatGpt.command({ type: 'retain', ids: keepIds });
      },
      { keepIds: [tabIds[4], tabIds[10], tabIds[11]] }
    );

    await new Promise((r) => setTimeout(r, 150));

    // Resident count should now be at most 3
    const finalResidentCount = await getResidentTabCount();
    assert.ok(
      finalResidentCount <= 3,
      `Retain should prune unused tabs down to kept count (actual: ${finalResidentCount})`
    );
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
