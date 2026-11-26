// Regression test suite for MAW Terminal UX Hotfix:
// 1. Duplicate paste prevention (real browser events, Ctrl+Shift+V, Ctrl+V, native paste, consecutive pastes, multiline, isolation)
// 2. Terminal history notification UX (boundary detection, 1-line dismissal, no alternate-screen, no pane overflow, narrow layouts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const webRoot = WEB_ROOT;

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalView } from './src/features/terminals/TerminalView.tsx';

window.terminals = {};
const origOpen = Terminal.prototype.open;
Terminal.prototype.open = function (element) {
  const res = origOpen.call(this, element);
  return res;
};

window.clipboardStore = '';
window.clipboardCalls = [];
window.sent = [];

// Mock desktop Electron clipboard bridge
window.workbench = {
  command: async (cmd) => {
    window.clipboardCalls.push(cmd);
    if (cmd.type === 'write-clipboard-text') {
      window.clipboardStore = cmd.text;
      return { ok: true };
    }
    if (cmd.type === 'read-clipboard-text') {
      return { ok: true, text: window.clipboardStore };
    }
    return { ok: true };
  },
  subscribe: () => () => {},
};

const listeners = new Set();
const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(message) { window.sent.push(message); return true; },
  sendImmediate(message) { window.sent.push(message); return true; },
};
window.emit = (message) => { for (const fn of listeners) fn(message); };

function TestApp() {
  const [pane1Width, setPane1Width] = useState(400);
  const [pane1Active, setPane1Active] = useState(true);
  const [pane2Active, setPane2Active] = useState(false);
  const [pasteOnCtrlV1, setPasteOnCtrlV1] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  window.setPane1Width = setPane1Width;
  window.setPane1Active = setPane1Active;
  window.setPane2Active = setPane2Active;
  window.setPasteOnCtrlV1 = setPasteOnCtrlV1;

  return (
    <div id="split-container" style={{ display: 'flex', width: '900px', height: '500px', position: 'relative' }}>
      <div
        id="pane-1"
        style={{
          width: pane1Width + 'px',
          height: '100%',
          position: 'relative',
          overflow: 'hidden',
          borderRight: '2px solid #444',
        }}
      >
        <TerminalView
          terminalId="term-1"
          connection={connection}
          active={pane1Active}
          theme="dark"
          pasteOnCtrlV={pasteOnCtrlV1}
          enableAgencyShortcuts={true}
          onTerminalInstance={(t) => { if (t) window.terminals['term-1'] = t; }}
        />
      </div>
      <div
        id="pane-2"
        style={{
          flex: 1,
          height: '100%',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <TerminalView
          terminalId="term-2"
          connection={connection}
          active={pane2Active}
          theme="dark"
          enableAgencyShortcuts={true}
          onTerminalInstance={(t) => { if (t) window.terminals['term-2'] = t; }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(React.createElement(TestApp));
`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  return undefined;
}

test('MAW hotfix: duplicate paste prevention and terminal history notification UX', { timeout: 120000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium executable not found');
    return;
  }

  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: webRoot },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><style>
      html,body,#root{height:100%;margin:0;padding:0;background:#12141a}
      .terminal-surface{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
      .terminal-surface-hidden{visibility:hidden}
    </style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminals && window.terminals['term-1'] && window.terminals['term-2']);

  // ==========================================
  // TASK 1: PASTE REGRESSION TESTS
  // ==========================================

  // Focus Terminal 1
  await page.evaluate(() => {
    window.terminals['term-1'].focus();
  });
  await page.waitForTimeout(50);

  // 1. One Ctrl+Shift+V paste produces exactly one input (Real browser keyboard event)
  await page.evaluate(() => {
    window.sent = [];
    window.clipboardStore = 'unique-cmd-1234';
  });

  // Use real browser event via Playwright keyboard API
  await page.keyboard.press('Control+Shift+KeyV');
  await page.waitForTimeout(100);

  const ctrlShiftVInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.terminalId === 'term-1')
  );
  assert.equal(ctrlShiftVInputs.length, 1, 'One physical Ctrl+Shift+V keypress produces exactly ONE input');
  assert.equal(ctrlShiftVInputs[0].data, 'unique-cmd-1234');

  // 2. Native paste does not duplicate custom paste handling
  await page.evaluate(() => {
    window.sent = [];
    const term = window.terminals['term-1'];
    const target = term.textarea;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'native-pasted-data');
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(100);

  const nativePasteInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.terminalId === 'term-1')
  );
  assert.equal(nativePasteInputs.length, 1, 'Native paste event produces exactly ONE input');
  assert.equal(nativePasteInputs[0].data, 'native-pasted-data');

  // 3. Two deliberate consecutive pastes both succeed
  await page.evaluate(() => {
    window.sent = [];
    window.clipboardStore = 'repeated-paste';
  });

  await page.keyboard.press('Control+Shift+KeyV');
  await page.waitForTimeout(60);
  await page.keyboard.press('Control+Shift+KeyV');
  await page.waitForTimeout(100);

  const consecutiveInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.terminalId === 'term-1')
  );
  assert.equal(consecutiveInputs.length, 2, 'Two consecutive physical pastes both succeed without suppression');
  assert.equal(consecutiveInputs[0].data, 'repeated-paste');
  assert.equal(consecutiveInputs[1].data, 'repeated-paste');

  // 4. Multiline content remains intact with normalized line endings
  await page.evaluate(() => {
    window.sent = [];
    window.clipboardStore = 'echo line1\r\necho line2\necho line3';
  });
  await page.keyboard.press('Control+Shift+KeyV');
  await page.waitForTimeout(100);

  const multilineInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.terminalId === 'term-1')
  );
  assert.equal(multilineInputs.length, 1, 'Multiline paste produces exactly one input event');
  assert.equal(
    multilineInputs[0].data,
    'echo line1\recho line2\recho line3',
    'Multiline text preserves all lines with terminal carriage return normalization'
  );

  // 5. One Ctrl+V paste produces one input where supported (pasteOnCtrlV = true)
  await page.evaluate(() => {
    window.setPasteOnCtrlV1(true);
    window.sent = [];
    const term = window.terminals['term-1'];
    term.focus();
    // Simulate paste event as triggered by browser on Ctrl+V
    const dt = new DataTransfer();
    dt.setData('text/plain', 'ctrl-v-content');
    term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(100);

  const ctrlVInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.terminalId === 'term-1')
  );
  assert.equal(ctrlVInputs.length, 1, 'Ctrl+V where supported produces exactly ONE input');
  assert.equal(ctrlVInputs[0].data, 'ctrl-v-content');

  // 6. Inactive terminals never receive keyboard-origin paste
  await page.evaluate(() => {
    window.setPane1Active(false);
    window.setPane2Active(true);
    window.sent = [];
    window.clipboardStore = 'secret-for-active-only';
  });
  await page.waitForTimeout(50);

  // Try to dispatch paste event and key event directly to inactive terminal 1 textarea
  await page.evaluate(() => {
    const term1 = window.terminals['term-1'];
    const dt = new DataTransfer();
    dt.setData('text/plain', 'leaked-to-inactive');
    term1.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    term1.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
    }));
  });
  await page.waitForTimeout(100);

  const inactiveInputs = await page.evaluate(() =>
    window.sent.filter((m) => m.terminalId === 'term-1')
  );
  assert.equal(inactiveInputs.length, 0, 'Inactive terminal 1 received zero input from keyboard/paste');

  // Reactivate terminal 1
  await page.evaluate(() => {
    window.setPane1Active(true);
    window.setPane2Active(false);
    window.terminals['term-1'].focus();
  });
  await page.waitForTimeout(50);

  // ==========================================
  // TASK 2: HISTORY NOTIFICATION UX TESTS
  // ==========================================

  // Fill Terminal 1 with enough lines to have scrollback
  await page.evaluate(() => {
    const term = window.terminals['term-1'];
    const lines = Array.from({ length: 60 }, (_, i) => 'History line ' + i).join('\r\n') + '\r\n';
    term.write(lines);
  });
  await page.waitForTimeout(100);

  // Initially at bottom, notification should not be visible
  let promptVisible = await page.locator('#pane-1 .terminal-history-prompt').isVisible();
  assert.equal(promptVisible, false, 'History notification not visible when at bottom of terminal');

  // 1. Boundary notification appears at top of scrollback
  await page.evaluate(() => {
    const term = window.terminals['term-1'];
    term.scrollToTop();
  });
  await page.waitForSelector('#pane-1 .terminal-history-prompt', { state: 'visible', timeout: 5000 });

  promptVisible = await page.locator('#pane-1 .terminal-history-prompt').isVisible();
  assert.equal(promptVisible, true, 'History notification appears when scrolled to top boundary (viewportY === 0)');

  const promptText = await page.locator('#pane-1 .terminal-history-prompt').textContent();
  assert.ok(promptText.includes('Top of live scrollback reached'), 'Displays boundary text');
  assert.ok(promptText.includes('Open Persistent History'), 'Displays action button');

  // 2. Scrolling down one line dismisses it immediately
  await page.evaluate(() => {
    const term = window.terminals['term-1'];
    term.scrollToLine(1); // viewportY becomes 1 (1 line away from top)
  });
  await page.waitForSelector('#pane-1 .terminal-history-prompt', { state: 'hidden', timeout: 5000 });
  promptVisible = await page.locator('#pane-1 .terminal-history-prompt').isVisible();
  assert.equal(promptVisible, false, 'Scrolling down even 1 line immediately dismisses notification');

  // 3. Scrolling back to top shows it again
  await page.evaluate(() => {
    const term = window.terminals['term-1'];
    term.scrollToTop();
  });
  await page.waitForSelector('#pane-1 .terminal-history-prompt', { state: 'visible', timeout: 5000 });
  promptVisible = await page.locator('#pane-1 .terminal-history-prompt').isVisible();
  assert.equal(promptVisible, true, 'Scrolling back to top shows notification again');

  // 4. Notification never exceeds its parent pane and does not overlap adjacent pane
  const bounds = await page.evaluate(() => {
    const pane1 = document.getElementById('pane-1').getBoundingClientRect();
    const pane2 = document.getElementById('pane-2').getBoundingClientRect();
    const prompt = document.querySelector('#pane-1 .terminal-history-prompt').getBoundingClientRect();
    return {
      pane1: { left: pane1.left, right: pane1.right, top: pane1.top, bottom: pane1.bottom },
      pane2: { left: pane2.left, right: pane2.right },
      prompt: { left: prompt.left, right: prompt.right, top: prompt.top, bottom: prompt.bottom },
    };
  });

  assert.ok(bounds.prompt.left >= bounds.pane1.left, 'Prompt left edge is inside Pane 1');
  assert.ok(bounds.prompt.right <= bounds.pane1.right, 'Prompt right edge is inside Pane 1');
  assert.ok(bounds.prompt.top >= bounds.pane1.top, 'Prompt top edge is inside Pane 1');
  assert.ok(bounds.prompt.bottom <= bounds.pane1.bottom, 'Prompt bottom edge is inside Pane 1');
  assert.ok(bounds.prompt.right <= bounds.pane2.left, 'Prompt does not overlap adjacent Pane 2');

  // 5. The history button remains usable in narrow layouts (220px width)
  await page.evaluate(() => {
    window.setPane1Width(220);
  });
  await page.waitForTimeout(100);

  // Verify within bounds in narrow layout
  const narrowBounds = await page.evaluate(() => {
    const pane1 = document.getElementById('pane-1').getBoundingClientRect();
    const pane2 = document.getElementById('pane-2').getBoundingClientRect();
    const prompt = document.querySelector('#pane-1 .terminal-history-prompt').getBoundingClientRect();
    return {
      pane1: { left: pane1.left, right: pane1.right },
      pane2: { left: pane2.left },
      prompt: { left: prompt.left, right: prompt.right, width: prompt.width },
    };
  });

  assert.ok(narrowBounds.prompt.left >= narrowBounds.pane1.left, 'Narrow layout: prompt left edge is inside Pane 1');
  assert.ok(narrowBounds.prompt.right <= narrowBounds.pane1.right, 'Narrow layout: prompt right edge is inside Pane 1');
  assert.ok(narrowBounds.prompt.right <= narrowBounds.pane2.left, 'Narrow layout: prompt does not overlap Pane 2');

  // Click the history button in narrow layout to verify usability
  const openHistBtn = page.locator('#pane-1 .terminal-history-prompt button');
  assert.equal(await openHistBtn.isVisible(), true);
  await openHistBtn.click();
  await page.waitForTimeout(50);

  // 6. Alternate-screen applications do not incorrectly trigger it
  // Reset width, enter alternate screen mode
  await page.evaluate(() => {
    window.setPane1Width(400);
    const term = window.terminals['term-1'];
    term.write('\\x1b[?1049h'); // Enter alternate buffer
    term.write('TUI application screen line 1\\r\\nTUI application screen line 2');
  });
  await page.waitForTimeout(100);

  // In alternate screen, prompt should not be visible even if scrolled or at top
  const altPromptVisible = await page.locator('#pane-1 .terminal-history-prompt').isVisible();
  assert.equal(altPromptVisible, false, 'Alternate-screen application does not trigger boundary prompt');

  // Exit alternate screen
  await page.evaluate(() => {
    const term = window.terminals['term-1'];
    term.write('\\x1b[?1049l'); // Leave alternate buffer
  });
  await page.waitForTimeout(100);
});
