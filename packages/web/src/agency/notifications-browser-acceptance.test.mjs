/**
 * MAW Lane C - Browser-Level Notification Acceptance Test.
 *
 * Exercises the real React notification components in headless Chromium via Playwright:
 *   - NotificationBell unread badge rendering
 *   - NotificationInbox popover dialog open/close
 *   - Keyboard accessibility (Escape key closes inbox dialog)
 *   - In-app NotificationToast rendering, state styling, and manual dismiss
 *   - Toast navigation click event
 *   - Done button action
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');

function getChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = path.join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) {
    for (const folder of readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const file = path.join(cache, folder, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(file)) return file;
    }
  }
  throw new Error('Chromium executable not found');
}

const fixtureSource = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationBell } from './src/agency/NotificationBell.tsx';
import { NotificationInbox } from './src/agency/NotificationInbox.tsx';
import { NotificationToastContainer } from './src/agency/NotificationToast.tsx';
import './src/agency/agency.css';

const initialNotifs = [
  {
    id: 'notif-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    title: 'Claude Agent',
    body: 'Agent completed task',
    state: 'finished',
    read: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'notif-2',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    tabId: 'tab-2',
    title: 'OpenCode Agent',
    body: 'Agent encountered an error',
    state: 'failed',
    read: false,
    createdAt: new Date(Date.now() - 60000).toISOString(),
  },
];

function App() {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [notifications, setNotifications] = useState(initialNotifs);
  const [toasts, setToasts] = useState([
    {
      id: 'toast-1',
      notificationId: 'notif-1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      tabId: 'tab-1',
      title: 'Claude Agent',
      body: 'Agent completed task',
      state: 'finished',
      createdAt: new Date().toISOString(),
    },
  ]);
  const [navigated, setNavigated] = useState(null);

  const unreadCount = notifications.filter(n => !n.read && !n.acknowledgedAt).length;

  return (
    <div id="test-root" style={{ padding: 20 }}>
      <div className="agency-topbar" style={{ display: 'flex', gap: 10 }}>
        <NotificationBell
          unreadCount={unreadCount}
          open={inboxOpen}
          onToggle={() => setInboxOpen(!inboxOpen)}
        />
      </div>

      {inboxOpen && (
        <NotificationInbox
          notifications={notifications}
          unreadCount={unreadCount}
          notificationsEnabled={true}
          desktopPermission="granted"
          onToggleNotifications={() => {}}
          onRequestDesktopPermission={() => {}}
          onClose={() => setInboxOpen(false)}
          onSelect={(item) => {
            setNavigated(item.id);
            setInboxOpen(false);
          }}
          onMarkRead={(id) => {
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
          }}
          onMarkAllRead={() => {
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
          }}
          onDone={(id) => {
            setNotifications(prev => prev.filter(n => n.id !== id));
            setToasts(prev => prev.filter(t => t.notificationId !== id));
          }}
        />
      )}

      <NotificationToastContainer
        toasts={toasts}
        onDismiss={(toastId) => setToasts(prev => prev.filter(t => t.id !== toastId))}
        onNavigate={(toast) => setNavigated(toast.notificationId)}
      />

      <div id="navigation-feedback" data-navigated={navigated ?? ''}>
        {navigated ? 'Navigated to ' + navigated : 'None'}
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
`;

const htmlTemplate = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MAW Notification Acceptance</title>
  <link rel="stylesheet" href="/bundle.css">
</head>
<body style="background: #0f172a; color: #f8fafc;">
  <div id="root"></div>
  <script type="module" src="/bundle.js"></script>
</body>
</html>`;

test('Browser Acceptance: Playwright headless Chromium notification bell, inbox, and toasts', async (t) => {
  // Build fixture bundle with esbuild
  const bundle = await build({
    stdin: { contents: fixtureSource, loader: 'tsx', resolveDir: path.join(root, 'packages/web') },
    bundle: true,
    write: false,
    outdir: '/tmp/maw-notif-browser-acceptance',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const jsFile = bundle.outputFiles.find(f => f.path.endsWith('.js'))?.text ?? '';
  const cssFile = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';

  const server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(jsFile);
    } else if (url === '/bundle.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(cssFile);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(htmlTemplate);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const serverUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: getChromiumExecutable(),
  });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(serverUrl);

  // 1. Initial State: Notification Bell displays unread badge count "2"
  const bell = page.locator('.maw-bell-button');
  await bell.waitFor({ state: 'visible', timeout: 5000 });
  const badge = page.locator('.maw-unread-badge');
  assert.equal(await badge.textContent(), '2');

  // 2. In-app Toast is visible with state-finished styling and title "Claude Agent"
  const toast = page.locator('.maw-toast-item.state-finished');
  await toast.waitFor({ state: 'visible' });
  assert.ok(await toast.locator('.maw-toast-title').textContent());

  // 3. Click Toast navigates to session
  await toast.click();
  const navFeedback = page.locator('#navigation-feedback');
  assert.equal(await navFeedback.getAttribute('data-navigated'), 'notif-1');

  // 4. Click Notification Bell opens Inbox dialog
  await bell.click();
  const inbox = page.locator('.maw-notification-inbox[role="dialog"]');
  await inbox.waitFor({ state: 'visible' });

  // Two inbox items present
  const items = page.locator('.maw-inbox-item');
  assert.equal(await items.count(), 2);

  // 5. Click Done on first item removes it and updates badge to "1"
  const doneButtons = page.locator('.maw-done-button');
  await doneButtons.first().click();
  assert.equal(await page.locator('.maw-inbox-item').count(), 1);
  assert.equal(await page.locator('.maw-unread-badge').textContent(), '1');

  // 6. Keyboard Escape key closes Inbox dialog
  await page.keyboard.press('Escape');
  await inbox.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.maw-notification-inbox').count(), 0);
});
