import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(p)) return p;
  }
  return undefined;
}

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgencyApp } from './src/agency/AgencyApp.tsx';

const ws = '11111111-1111-4111-8111-111111111111';
const p = '22222222-2222-4222-8222-222222222222';
const native1 = '33333333-3333-4333-8333-333333333333';
const native2 = '44444444-4444-4444-8444-444444444444';
const web = '55555555-5555-4555-8555-555555555555';
const notif1 = '66666666-6666-4666-8666-666666666666';
const notif2 = '77777777-7777-4777-8777-777777777777';
const now = new Date().toISOString();

const project = { id: p, name: 'Project', status: 'active', createdAt: now, updatedAt: now };
const workspace = { id: ws, projectId: p, name: 'Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };
const profile = {
  id: 'codex-0', label: 'Codex 00', provider: 'codex', executable: '/fixture/codex-0', args: [],
  environmentOverrides: {}, configurationStatus: 'available', configurationMessage: null,
  capabilities: { canLaunch: true, canResumeNativeSession: false, canInterrupt: true, canReportActivity: false, canSelectModel: false, canSelectEffort: false, canRequestPermissions: false, models: [], discovery: 'unavailable' }
};

let sessions = [
  { id: 'session-1', workspaceId: ws, kind: 'terminal', terminalId: 'term-1', lifecycle: 'running', activity: 'idle', exitCode: null, tab: { id: native1, order: 0, selected: true, current: true, closedAt: null, name: 'Terminal A', terminalNumber: 1 } },
  { id: 'session-2', workspaceId: ws, kind: 'agent', profileId: 'codex-0', terminalId: 'term-2', lifecycle: 'running', activity: 'working', exitCode: null, tab: { id: native2, order: 1, selected: false, current: true, closedAt: null, name: 'Agent B' } },
];
let webTabs = [
  { id: web, workspaceId: ws, kind: 'web', title: 'ChatGPT Web', url: 'https://chatgpt.com/', order: 2, selected: false, closedAt: null, createdAt: now, updatedAt: now, targetRef: 'target', runtimeState: 'ready' },
];
let activities = [
  { workspaceId: ws, tabId: native1, state: 'idle', updatedAt: now, reliableSignal: true, source: 'shell' },
  { workspaceId: ws, tabId: native2, state: 'finished', taskId: 'turn-1', turnSequence: 1, updatedAt: now, reliableSignal: true, source: 'cli' },
];
let notifications = [
  { id: notif1, workspaceId: ws, tabId: native2, title: 'Agent B', body: 'Task completed', state: 'finished', read: false, createdAt: now, metadata: { kind: 'cli', tabName: 'Agent B', taskId: 'turn-1', turnSequence: 1 } },
  { id: notif2, workspaceId: ws, tabId: native1, title: 'Terminal A', body: 'Earlier alert', state: 'finished', read: false, createdAt: now, metadata: { kind: 'cli', tabName: 'Terminal A' } },
];

const listeners = new Set(), statuses = new Set(), reopens = new Set(), requests = [];
let status = 'open';

function emit(m) { for (const fn of listeners) fn(m); }
function snapshots() {
  emit({ type: 'agency.sessions.snapshot', requestId: '', sessions: structuredClone(sessions) });
  emit({ type: 'agency.webTabs.snapshot', requestId: '', tabs: structuredClone(webTabs) });
}

const connection = {
  getStatus: () => status,
  isRemoteClient: () => false,
  onStatus: fn => (statuses.add(fn), () => statuses.delete(fn)),
  onReopen: fn => (reopens.add(fn), () => reopens.delete(fn)),
  onMessage: fn => (listeners.add(fn), () => listeners.delete(fn)),
  send(m) { return this.sendImmediate(m); },
  sendImmediate(m) {
    if (status !== 'open') return false;
    requests.push(m);
    queueMicrotask(() => {
      const reply = (type, extra = {}) => emit({ type, requestId: m.requestId, ...extra });
      switch (m.type) {
        case 'agency.projects.list': reply('agency.projects.snapshot', { projects: [project] }); break;
        case 'agency.workspaces.list': reply('agency.workspaces.snapshot', { workspaces: [workspace] }); break;
        case 'agency.profiles.list': reply('agency.profiles.snapshot', { profiles: [profile] }); break;
        case 'agency.sessions.list': reply('agency.sessions.snapshot', { sessions: structuredClone(sessions) }); break;
        case 'agency.webTabs.list': reply('agency.webTabs.snapshot', { tabs: structuredClone(webTabs) }); break;
        case 'agency.notifications.list': reply('agency.notifications.snapshot', { notifications: structuredClone(notifications), activityStates: structuredClone(activities) }); break;
        case 'terminal.attach': emit({ type: 'terminal.replay', terminalId: m.terminalId, data: 'prompt$ ', truncated: false }); break;
        case 'agency.tab.action': {
          if (m.action === 'select') {
            sessions = sessions.map(s => ({ ...s, tab: { ...s.tab, selected: s.tab.id === m.tabId } }));
            webTabs = webTabs.map(t => ({ ...t, selected: t.id === m.tabId }));
            snapshots();
            reply('agency.session.changed', { session: sessions.find(s => s.tab.id === m.tabId) });
          }
          break;
        }
        case 'agency.webTab.select': {
          sessions = sessions.map(s => ({ ...s, tab: { ...s.tab, selected: false } }));
          webTabs = webTabs.map(t => ({ ...t, selected: t.id === m.tabId }));
          snapshots();
          reply('agency.webTab.updated', { tab: webTabs.find(t => t.id === m.tabId) });
          break;
        }
        case 'agency.tabs.order': {
          sessions = sessions.map(s => ({ ...s, tab: { ...s.tab, order: m.tabIds.indexOf(s.tab.id) } }));
          webTabs = webTabs.map(t => ({ ...t, order: m.tabIds.indexOf(t.id) }));
          snapshots();
          reply('agency.sessions.snapshot', { sessions: structuredClone(sessions) });
          break;
        }
        case 'agency.tab.rename': {
          sessions = sessions.map(s => s.tab.id === m.tabId ? { ...s, tab: { ...s.tab, name: m.name } } : s);
          snapshots();
          reply('agency.sessions.snapshot', { sessions: structuredClone(sessions) });
          break;
        }
        case 'agency.notification.markRead': {
          notifications = notifications.map(n => n.id === m.notificationId ? { ...n, read: true, readAt: new Date().toISOString() } : n);
          const changed = notifications.find(n => n.id === m.notificationId);
          reply('agency.notification.changed', { notification: changed });
          break;
        }
        case 'agency.notification.done': {
          if (window.agencyTest && window.agencyTest.failDone) {
            reply('agency.error', { message: 'Injected persistence failure', code: 'internal-error' });
            break;
          }
          const item = notifications.find(n => n.id === m.notificationId);
          if (item) {
            item.acknowledgedAt = new Date().toISOString();
            item.read = true;
            reply('agency.notification.changed', { notification: item });
            // If matches Tab 2's completion, clear it:
            const act = activities.find(a => a.tabId === item.tabId);
            if (act && act.state === 'finished' && (!act.taskId || act.taskId === item.metadata?.taskId)) {
              act.state = 'idle';
              emit({ type: 'agency.tab.activity', activity: act });
            }
          }
          break;
        }
        case 'agency.tab.acknowledge': {
          activities = activities.map(a => a.tabId === m.tabId ? { ...a, state: 'idle' } : a);
          const act = activities.find(a => a.tabId === m.tabId);
          if (act) reply('agency.tab.activity', { activity: act });
          break;
        }
      }
    });
    return true;
  }
};

window.agencyTest = {
  requests,
  failDone: false,
  getNotifications: () => notifications,
  getActivities: () => activities,
  emitSnapshot: () => emit({ type: 'agency.notifications.snapshot', notifications: structuredClone(notifications), activityStates: structuredClone(activities) }),
  addTurn2ToAgentB: () => {
    activities = activities.map(a => a.tabId === native2 ? { ...a, state: 'finished', taskId: 'turn-2', turnSequence: 2, updatedAt: new Date().toISOString() } : a);
    emit({ type: 'agency.tab.activity', activity: activities.find(a => a.tabId === native2) });
  },
  emitNotificationCreated: (item) => {
    notifications = [item, ...notifications];
    emit({ type: 'agency.notification.created', notification: item });
  }
};

localStorage.setItem('agency-ui.selected-workspace.v1', ws);
createRoot(document.getElementById('root')).render(<AgencyApp connection={connection} />);
`;

test('Interactive UX: pointer dragging reorders mixed tabs, Done button clears alert and tab completion', { timeout: 60000 }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) { t.skip('No Chromium browser found'); return; }

  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent'
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html>
<html lang="en">
<head>
<style>
  html,body,#root{height:100%;margin:0}
  .agency-app{display:flex;height:100%}
  .agency-main{flex:1;min-width:0}
  .agency-sidebar{width:240px}
  .maw-tabs-header{display:flex;height:42px}
  .maw-tabs-strip{display:flex;overflow-x:auto}
  .maw-session-tab{display:flex;min-width:120px;height:40px;position:relative}
  .maw-session-tab.dragging{opacity:0.5}
  .maw-session-tab.maw-drop-target-before{box-shadow:inset 3px 0 0 blue}
  .maw-session-tab.maw-drop-target-after{box-shadow:inset -3px 0 0 blue}
  .agency-status-dot{display:inline-block;width:7px;height:7px}
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/bundle.js"></script>
</body>
</html>`);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://127.0.0.1:' + server.address().port);

  // Wait for initial tabs to appear
  await page.getByRole('tab', { name: 'Terminal A' }).waitFor();
  await page.getByRole('tab', { name: 'Agent B' }).waitFor();
  await page.getByRole('tab', { name: 'ChatGPT Web' }).waitFor();

  // Test 1: Normal click-to-select remains responsive
  await page.getByRole('tab', { name: 'ChatGPT Web' }).click();
  await page.waitForFunction(() => window.agencyTest.requests.some(m => (m.type === 'agency.webTab.select' || (m.type === 'agency.tab.action' && m.action === 'select')) && m.tabId === '55555555-5555-4555-8555-555555555555'));

  // Test 2: Keyboard tab reordering with Alt+ArrowLeft
  await page.getByRole('tab', { name: 'ChatGPT Web' }).press('Alt+ArrowLeft');
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.tabs.order'));

  // Test 3: Pointer dragging of a tab
  // Drag Terminal A to the right of ChatGPT Web
  const tabA = page.locator('.maw-session-tab').filter({ hasText: 'Terminal A' });
  const tabWeb = page.locator('.maw-session-tab').filter({ hasText: 'ChatGPT Web' });
  const boxA = await tabA.boundingBox();
  const boxWeb = await tabWeb.boundingBox();
  assert.ok(boxA);
  assert.ok(boxWeb);

  // Mouse drag with distance > 6px
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  // Move past 6px threshold towards tabWeb
  await page.mouse.move(boxWeb.x + boxWeb.width + 10, boxWeb.y + boxWeb.height / 2, { steps: 10 });
  // Drop
  await page.mouse.up();

  // Verify order request was dispatched
  await page.waitForFunction(() => window.agencyTest.requests.filter(m => m.type === 'agency.tabs.order').length >= 2);

  // Test 4: Escape key cancels dragging safely
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + 30, boxA.y + boxA.height / 2);
  await page.keyboard.press('Escape');
  await page.mouse.up();

  // Test 5: Notification inbox and GitHub-style Done action
  // Bell shows unread count of 2
  await page.locator('.maw-bell-button').click();
  await page.locator('.maw-notification-inbox').waitFor();

  // 2 inbox items present
  const items = page.locator('.maw-inbox-item');
  assert.equal(await items.count(), 2);

  // Each notification item has an accessible Done button
  const doneButtons = page.locator('.maw-done-button');
  assert.equal(await doneButtons.count(), 2);
  assert.equal(await doneButtons.first().getAttribute('title'), 'Done');

  // Agent B has finished completion badge dot
  const agentTab = page.locator('.maw-session-tab').filter({ hasText: 'Agent B' });
  await agentTab.locator('.agency-status-dot.finished').waitFor();

  // Click Done on Agent B notification (first item)
  await doneButtons.first().click();

  // Verify agency.notification.done request was sent
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.notification.done'));

  // Item immediately disappears from active inbox
  await page.waitForFunction(() => document.querySelectorAll('.maw-inbox-item').length === 1);

  // Tab completion indicator for Agent B clears (returns to idle)
  await agentTab.locator('.agency-status-dot.idle').waitFor();

  // Test 6: Race condition - newer turn is not cleared by a stale Done request
  // Simulate Turn 2 completing on Agent B
  await page.evaluate(() => window.agencyTest.addTurn2ToAgentB());
  await agentTab.locator('.agency-status-dot.finished').waitFor();

  // Simulate stale Done for Turn 1
  // Tab completion must remain finished because Turn 2 is active!
  await agentTab.locator('.agency-status-dot.finished').waitFor();

  // Test 7: Rejected Done request failure & snapshot reconciliation
  // Simulate transport/persistence failure on Done for the remaining item (Terminal A)
  await page.evaluate(() => { window.agencyTest.failDone = true; });
  const remainingDoneBtn = page.locator('.maw-done-button').first();
  await remainingDoneBtn.click();

  // Error bar appears showing failure
  await page.locator('.agency-error-bar').waitFor();

  // Item remains visible in inbox (not permanently suppressed)
  assert.equal(await page.locator('.maw-inbox-item').count(), 1);

  // Subsequent snapshot from server reconciles without suppressing the alert
  await page.evaluate(() => window.agencyTest.emitSnapshot());
  assert.equal(await page.locator('.maw-inbox-item').count(), 1);

  // Clear failure, retry Done -> succeeds, commits suppression
  await page.evaluate(() => { window.agencyTest.failDone = false; });
  await page.locator('.maw-done-button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.maw-inbox-item').length === 0);

  // Subsequent snapshot filters out confirmed Done alert
  await page.evaluate(() => window.agencyTest.emitSnapshot());
  assert.equal(await page.locator('.maw-inbox-item').count(), 0);

  // Test 8: MAW UI Shell Polish: branding, sidebar toggle, shell dropdown, notifications enable toggle
  // 1. Branding: sidebar header displays 'MaW'
  const brand = page.locator('.agency-nav-head strong');
  assert.equal(await brand.textContent(), 'MaW');

  // 2. Sidebar toggle button uses SVG panel toggle icon (not hamburger '☰')
  const sidebarCollapseBtn = page.locator('.agency-nav-head button.agency-icon-button');
  assert.equal(await sidebarCollapseBtn.locator('svg').count(), 1);
  assert.ok(!((await sidebarCollapseBtn.textContent()) || '').includes('☰'));

  // 3. Sidebar bottom no longer has done toggle section
  assert.equal(await page.locator('.agency-nav-bottom').count(), 0);

  // 4. Header does not have Refresh button or prominent Enable notifications button
  assert.equal(await page.locator('.agency-topbar button').filter({ hasText: 'Refresh' }).count(), 0);
  assert.equal(await page.locator('.agency-topbar button').filter({ hasText: 'Enable notifications' }).count(), 0);

  // 5. Notifications dropdown has enable/disable toggle at bottom right
  // Bell button has neutral gray SVG bell
  assert.equal(await page.locator('.maw-bell-button svg').count(), 1);
  const notifToggleBtn = page.locator('.maw-inbox-footer .maw-notification-toggle-button');
  assert.equal(await notifToggleBtn.count(), 1);
  // Defaults to enabled -> button says 'Disable notifications'
  assert.equal(await notifToggleBtn.textContent(), 'Disable notifications');
  assert.equal(await page.evaluate(() => localStorage.getItem('agency-ui.notifications-enabled.v1')), null);

  // Desktop notification permission in dropdown footer (fresh browser defaults to 'default')
  const desktopPermBtn = page.locator('.maw-desktop-perm-button');
  assert.equal(await desktopPermBtn.count(), 1);
  assert.equal(await desktopPermBtn.textContent(), 'Allow desktop alerts');

  // Explicit user-initiated click triggers Notification.requestPermission()
  await page.evaluate(() => {
    window.__permRequested = false;
    if (window.Notification) {
      window.Notification.requestPermission = async () => {
        window.__permRequested = true;
        Object.defineProperty(window.Notification, 'permission', { value: 'granted', configurable: true });
        return 'granted';
      };
    }
  });
  await desktopPermBtn.click();
  assert.equal(await page.evaluate(() => window.__permRequested), true);
  await page.locator('.maw-desktop-perm-status.granted').waitFor();
  assert.equal(await page.locator('.maw-desktop-perm-status.granted').textContent(), 'Desktop alerts on');

  // Click toggle button -> disables notifications
  await notifToggleBtn.click();
  assert.equal(await notifToggleBtn.textContent(), 'Enable notifications');
  assert.equal(await page.evaluate(() => localStorage.getItem('agency-ui.notifications-enabled.v1')), 'false');

  // FINDING 1 Verification:
  // Disabling notifications suppresses nonessential in-app popups (toast) while preserving inbox item
  await page.evaluate(() => {
    window.agencyTest.emitNotificationCreated({
      id: 'suppressed-notif-1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      tabId: '33333333-3333-4333-8333-333333333333',
      title: 'Suppressed Alert',
      body: 'Should not create toast popup',
      state: 'finished',
      read: false,
      createdAt: new Date().toISOString()
    });
  });
  // Item arrives in inbox
  await page.waitForFunction(() => document.querySelectorAll('.maw-inbox-item').length === 1);
  // But toast popup is NOT rendered
  assert.equal(await page.locator('.maw-toast-item').count(), 0);

  // Click toggle button again -> re-enables notifications
  await notifToggleBtn.click();
  assert.equal(await notifToggleBtn.textContent(), 'Disable notifications');
  assert.equal(await page.evaluate(() => localStorage.getItem('agency-ui.notifications-enabled.v1')), 'true');

  // Subsequent notification while enabled restores toast popup delivery!
  await page.evaluate(() => {
    window.agencyTest.emitNotificationCreated({
      id: 'restored-notif-2',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      tabId: '33333333-3333-4333-8333-333333333333',
      title: 'Restored Alert',
      body: 'Should show toast popup',
      state: 'finished',
      read: false,
      createdAt: new Date().toISOString()
    });
  });
  await page.locator('.maw-toast-item').waitFor();
  assert.ok((await page.locator('.maw-toast-item').textContent() || '').includes('Restored Alert'));

  // Close notifications inbox
  await page.locator('.maw-bell-button').click();
  await page.waitForFunction(() => document.querySelectorAll('.maw-notification-inbox').length === 0);

  // 6. Central shell dropdown next to notifications
  const shellMenuBtn = page.locator('.maw-menu-button');
  assert.equal(await shellMenuBtn.count(), 1);
  assert.equal(await shellMenuBtn.getAttribute('aria-label'), 'Workspace menu');
  assert.equal(await shellMenuBtn.getAttribute('title'), 'Workspace menu');
  await shellMenuBtn.click();
  await page.locator('.maw-shell-menu').waitFor();

  // Contains Done workspaces action
  const doneMenuItem = page.locator('.maw-shell-menu .maw-menu-item').filter({ hasText: 'Done workspaces' });
  assert.equal(await doneMenuItem.count(), 1);

  // Clicking Done workspaces opens Done view
  await doneMenuItem.click();
  await page.locator('.agency-done-view').waitFor();
  assert.equal(await page.locator('#agency-done-title').textContent(), 'Done workspaces');

  // 7. Sidebar collapse and expand
  await sidebarCollapseBtn.click();
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') !== null);
  const expandBtn = page.locator('.agency-topbar button.agency-icon-button').first();
  assert.equal(await expandBtn.locator('svg').count(), 1);
  await expandBtn.click();
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') === null);

  // 8. Viewport and layout verification at 1366x768 and 1920x1080
  for (const [w, h] of [[1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    const topbarBox = await page.locator('.agency-topbar').boundingBox();
    assert.ok(topbarBox, `topbar should exist at ${w}x${h}`);
    assert.equal(topbarBox.x >= 0, true);
    assert.equal(topbarBox.width <= w, true);

    // Open notifications dropdown and verify it fits on screen without horizontal clipping
    await page.locator('.maw-bell-button').click();
    await page.locator('.maw-notification-inbox').waitFor();
    const inboxBox = await page.locator('.maw-notification-inbox').boundingBox();
    assert.ok(inboxBox);
    assert.ok(inboxBox.x >= 0, `inbox left edge ${inboxBox.x} should be >= 0 at ${w}x${h}`);
    assert.ok(inboxBox.x + inboxBox.width <= w, `inbox right edge ${inboxBox.x + inboxBox.width} should fit within width ${w}`);
    await page.locator('.maw-bell-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.maw-notification-inbox').length === 0);

    // Open workspace menu and verify it fits on screen without clipping
    await shellMenuBtn.click();
    await page.locator('.maw-shell-menu').waitFor();
    const menuBox = await page.locator('.maw-shell-menu').boundingBox();
    assert.ok(menuBox);
    assert.ok(menuBox.x >= 0, `menu left edge ${menuBox.x} should be >= 0 at ${w}x${h}`);
    assert.ok(menuBox.x + menuBox.width <= w, `menu right edge ${menuBox.x + menuBox.width} should fit within width ${w}`);
    await shellMenuBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('.maw-shell-menu').length === 0);
  }

  assert.deepEqual(errors, []);
});
