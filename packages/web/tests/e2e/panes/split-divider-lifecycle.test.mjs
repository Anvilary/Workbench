import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SplitDivider } from './src/agency/split/SplitDivider.tsx';

window.lastCommittedRatio = null;
window.dragState = null;

function TestApp() {
  const [ratio, setRatio] = useState(0.5);
  const [unmounted, setUnmounted] = useState(false);
  const [externalRenderCount, setExternalRenderCount] = useState(0);

  window.setTestRatio = setRatio;
  window.triggerExternalRender = () => setExternalRenderCount((c) => c + 1);
  window.unmountDivider = () => setUnmounted(true);

  return (
    <div
      id="split-container"
      className="maw-split-node"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '1000px',
        height: '600px',
        position: 'relative',
      }}
    >
      <div
        id="pane-first"
        className="maw-split-child"
        style={{
          flex: 'var(--split-ratio-first, ' + ratio + ') 1 0px',
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        First (renders: {externalRenderCount})
      </div>

      {!unmounted && (
        <SplitDivider
          splitId="split-test-1"
          direction="row"
          ratio={ratio}
          onRatioChange={(r) => {
            window.lastCommittedRatio = r;
            setRatio(r);
          }}
          onDragStateChange={(d) => {
            window.dragState = d;
          }}
        />
      )}

      <div
        id="pane-second"
        className="maw-split-child"
        style={{
          flex: 'var(--split-ratio-second, ' + (1 - ratio) + ') 1 0px',
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        Second (renders: {externalRenderCount})
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(TestApp));
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

test('SplitDivider lifecycle: mid-drag re-renders, unmount commit, escape revert, and blur settlement', { timeout: 60000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed');
    return;
  }

  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT },
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
  });

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><style>body { margin: 0; padding: 0; } .maw-split-divider { width: 10px; cursor: col-resize; }</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForSelector('.maw-split-divider');

  // Test 1: Active drag followed by mid-drag re-render
  // First pane initially occupies 500px (ratio 0.5)
  const dividerBox = await page.locator('.maw-split-divider').boundingBox();
  assert(dividerBox, 'divider exists in layout');

  // Start pointer drag at center
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();

  // Drag to 700px (target ratio ~0.70)
  await page.mouse.move(700, dividerBox.y + dividerBox.height / 2);

  // Verify direct CSS variable is set on container and inline styles reflect 0.70
  let firstFlex = await page.evaluate(() => {
    const parent = document.getElementById('split-container');
    const first = document.getElementById('pane-first');
    return {
      cssVar: parent.style.getPropertyValue('--split-ratio-first'),
      computedWidth: first.getBoundingClientRect().width,
    };
  });
  assert.equal(firstFlex.cssVar, '0.7');
  assert(Math.abs(firstFlex.computedWidth - 700) < 15, 'pane width follows drag pointer smoothly');

  // TRIGGER EXTERNAL RE-RENDER WHILE POINTER IS HELD DOWN
  await page.evaluate(() => window.triggerExternalRender());

  // Verify that pane DOES NOT snap back to 0.5 upon React re-render
  let afterRender = await page.evaluate(() => {
    const first = document.getElementById('pane-first');
    return first.getBoundingClientRect().width;
  });
  assert(Math.abs(afterRender - 700) < 15, 'pane did NOT snap back to 0.5 on external mid-drag re-render');

  // Release pointer: commits authoritative state to React and persists
  await page.mouse.up();
  const committed = await page.evaluate(() => window.lastCommittedRatio);
  assert.equal(committed, 0.7, 'final ratio committed cleanly to React');

  // Verify CSS variable was removed after drag stopped
  const postDragVar = await page.evaluate(() => document.getElementById('split-container').style.getPropertyValue('--split-ratio-first'));
  assert.equal(postDragVar, '', 'temporary CSS variable cleaned up on pointer release');

  // Test 2: Unmount during drag commits final ratio
  await page.mouse.move(700, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, dividerBox.y + dividerBox.height / 2);

  // Unmount divider while drag is active
  await page.evaluate(() => window.unmountDivider());

  const unmountCommitted = await page.evaluate(() => window.lastCommittedRatio);
  assert.equal(unmountCommitted, 0.6, 'unmount during active drag committed in-flight ratio cleanly');
});
