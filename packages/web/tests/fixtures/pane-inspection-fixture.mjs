// Shared by Chromium and real Electron tests; all state and native pages are synthetic.
export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const tabA = '33333333-3333-4333-8333-333333333333';
export const tabB = '44444444-4444-4444-8444-444444444444';

export const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WorkspaceView } from './src/features/workspaces/WorkspaceView.tsx';
import { useNotificationStore } from './src/features/notifications/useNotificationStore.ts';
import { NotificationBell } from './src/features/notifications/NotificationBell.tsx';
import { NotificationInbox } from './src/features/notifications/NotificationInbox.tsx';

const ws = '${workspaceId}', other = '66666666-6666-4666-8666-666666666666';
const ids = ['${tabA}', '${tabB}', '77777777-7777-4777-8777-777777777777'];
const web = new URLSearchParams(location.search).has('web');
const mixed = new URLSearchParams(location.search).has('mixed');
const terminalTab = '88888888-8888-4888-8888-888888888888';
const now = '2026-10-31T10:00:00.000Z';
const listeners = new Set();
const requests = [], pending = [], pendingAcks = [], nativeCommands = [];
let delay = false, delayAck = false, fail = false, failAck = false, online = true;
let rerender = () => {};
const initial = {
  selected: { [ws]: ids[0], [other]: ids[2] },
  activities: ids.map((tabId, i) => ({ workspaceId: i < 2 ? ws : other, tabId, state: 'working', updatedAt: now, source: 'cli', reliableSignal: true })),
  notifications: [], layouts: {},
};
const state = JSON.parse(localStorage.getItem('fixture-server') || 'null') || initial;
const persist = () => localStorage.setItem('fixture-server', JSON.stringify(state));
const emit = (message) => { for (const fn of listeners) fn(message); };
function snapshot() {
  emit({ type: 'agency.notifications.snapshot', notifications: structuredClone(state.notifications), activityStates: structuredClone(state.activities) });
}
const connection = {
  getStatus: () => online ? 'open' : 'closed',
  onStatus: () => () => {}, onReopen: () => () => {},
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(message) { requests.push(message); return true; },
  sendImmediate(message) { requests.push(message); return true; },
};
const transport = { onMessage: connection.onMessage };
const request = async (message) => {
  requests.push(message);
  if (!online) throw new Error('Disconnected fixture');
  if (message.type === 'agency.tab.action' || message.type === 'agency.webTab.select') {
    if (message.action && message.action !== 'select') throw new Error('Unexpected lifecycle action');
    if (delay) await new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
    if (fail) { fail = false; throw new Error('Selection rejected'); }
    state.selected[message.workspaceId] = message.tabId;
    persist(); rerender();
  }
  if (message.type === 'agency.tab.acknowledge') {
    if (state.selected[message.workspaceId] !== message.tabId) throw new Error('Inspection of unselected tab');
    if (delayAck) await new Promise((resolve, reject) => pendingAcks.push({ message, resolve, reject }));
    if (failAck) { failAck = false; throw new Error('Acknowledgement rejected'); }
    const record = state.activities.find(a => a.workspaceId === message.workspaceId && a.tabId === message.tabId);
    record.state = 'idle'; record.acknowledgedAt = new Date().toISOString();
    persist(); emit({ type: 'agency.tab.activity', activity: structuredClone(record) });
  }
  return {};
};
const terminalOpen = Terminal.prototype.open;
const terminalDispose = Terminal.prototype.dispose;
window.terminals = []; window.disposed = 0;
Terminal.prototype.open = function(element) { window.terminals.push(this); return terminalOpen.call(this, element); };
Terminal.prototype.dispose = function() { window.disposed++; return terminalDispose.call(this); };
if (web && !window.mawChatGpt) {
  const gptSubscribers = new Set();
  window.mawChatGpt = {
    subscribe(fn) {
      gptSubscribers.add(fn);
      return () => { gptSubscribers.delete(fn); };
    },
    async command(message) {
      nativeCommands.push(message);
      if (message.type === 'open') {
        setTimeout(() => {
          for (const fn of gptSubscribers) fn({ type: 'ready', id: message.id });
        }, 0);
      }
      return { ok: true };
    },
  };
}
function layout(workspaceId) {
  const saved = state.layouts[workspaceId];
  if (saved) return saved;
  const value = {
    workspaceId, version: 1, updatedAt: now, focusedPaneId: 'left', maximizedPaneId: null,
    tree: workspaceId === ws
      ? { type: 'split', id: 'split', direction: 'row', ratio: 0.5,
          first: { type: 'pane', id: 'left', tabIds: [ids[0]], selectedTabId: ids[0] },
          second: { type: 'pane', id: 'right', tabIds: [ids[1]], selectedTabId: ids[1] } }
      : { type: 'pane', id: 'left', tabIds: [ids[2]], selectedTabId: ids[2] },
  };
  if (mixed && workspaceId === ws) value.tree = { type: 'split', id: 'terminal-split', direction: 'column', ratio: 0.7,
    first: value.tree, second: { type: 'pane', id: 'terminal', tabIds: [terminalTab], selectedTabId: terminalTab } };
  return value;
}
function Harness() {
  const [, update] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [workspaceId, setWorkspace] = useState(ws);
  const [connected, setConnected] = useState(true);
  const [inbox, setInbox] = useState(false);
  rerender = () => update(n => n + 1);
  const notifications = useNotificationStore(transport, request);
  useEffect(snapshot, [connected]);
  window.inspection = {
    requests, pending, pendingAcks, nativeCommands, state,
    start: () => setMounted(true),
    switchWorkspace: () => setWorkspace(id => id === ws ? other : ws),
    delay: (value) => { delay = value; },
    delayAck: (value) => { delayAck = value; },
    fail: () => { fail = true; }, failAck: () => { failAck = true; },
    resolve: () => pending.shift().resolve(), resolveAck: () => pendingAcks.shift().resolve(),
    online(value) { online = value; setConnected(value); },
    finish(tabId, version = 'turn-1') {
      const record = state.activities.find(a => a.tabId === tabId);
      record.state = 'finished'; record.updatedAt = version; delete record.acknowledgedAt;
      state.notifications.push({ id: tabId + version, workspaceId: record.workspaceId, tabId, title: 'Finished', body: 'Fixture completion', state: 'finished', read: false, createdAt: now });
      persist(); snapshot();
    },
    replay() { snapshot(); },
    frontend: { activities: [...notifications.activityStates.values()], unread: notifications.unreadCount },
  };
  const sessions = ids.map((id, i) => ({
    id: 'session-' + i, workspaceId: i < 2 ? ws : other, kind: 'agent', profileId: null,
    terminalId: 'term-' + i, lifecycle: 'running', activity: 'working', exitCode: null,
    nativeSessionId: null, selectedModel: null, selectedEffort: null, createdAt: now, updatedAt: now,
    tab: { id, order: i, selected: state.selected[i < 2 ? ws : other] === id, current: true, closedAt: null, name: 'CLI ' + (i + 1), terminalNumber: i + 1 },
  }));
  const webTabs = ids.map((id, i) => ({ id, workspaceId: i < 2 ? ws : other, kind: 'web', title: 'ChatGPT ' + (i + 1), url: 'https://chatgpt.com/', order: i,
    selected: state.selected[i < 2 ? ws : other] === id, closedAt: null, runtimeState: 'client-managed', createdAt: now, updatedAt: now }));
  const mixedSession = { ...sessions[0], id: 'mixed-terminal', kind: 'terminal', terminalId: 'term-mixed',
    tab: { ...sessions[0].tab, id: terminalTab, name: 'Terminal', selected: state.selected[ws] === terminalTab, order: 3 } };
  return <>
    <button id="start" onClick={() => setMounted(true)}>Start fixture</button>
    <NotificationBell unreadCount={notifications.unreadCount} open={inbox} onToggle={() => setInbox(value => !value)} />
    {inbox && <NotificationInbox notifications={notifications.notifications} unreadCount={notifications.unreadCount}
      notificationsEnabled={true} desktopPermission="unsupported" onToggleNotifications={() => {}}
      onRequestDesktopPermission={() => {}} onClose={() => setInbox(false)} onSelect={() => {}}
      onMarkRead={() => {}} onMarkAllRead={() => {}} onDone={() => {}} />}
    {mounted && <WorkspaceView key={workspaceId}
      workspace={{ id: workspaceId, projectId: '22222222-2222-4222-8222-222222222222', name: 'Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now }}
      profiles={[]} sessions={mixed ? [mixedSession] : web ? [] : sessions} webTabs={web ? webTabs : []}
      connection={connection} request={request} sendImmediate={connection.sendImmediate} online={connected} onDone={() => {}}
      savedLayout={layout(workspaceId)}
      onSaveLayout={async (id, value) => { state.layouts[id] = value; persist(); }}
      getTabActivity={notifications.getTabActivity}
      getTabActivityVersion={(id, tabId) => notifications.activityStates.get(id + '::' + tabId)?.updatedAt || ''}
      onAcknowledgeTab={notifications.acknowledgeTab}
    />}
  </>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

export const html = `<!doctype html><html><head><style>
html,body,#root{height:100%;margin:0}
.agency-workspace-view{display:flex;flex-direction:column;height:90%}
.maw-split-workspace-content,.maw-split-container,.maw-split-child{display:flex;flex:1;min-height:0;min-width:0}
.maw-split-pane{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.maw-pane-body{flex:1;display:flex;min-height:0;min-width:0;position:relative}
.maw-session-holder,.maw-session-pane{display:flex;flex:1;flex-direction:column;min-height:0}
.maw-session-holder[hidden],.maw-session-pane[hidden],.maw-terminal-park{display:none!important}
.agency-agent-body{flex:1;position:relative;min-height:0}
.agency-xterm-host,.terminal-surface{position:absolute;inset:0}
.terminal-surface-hidden{visibility:hidden}
.maw-browser-pane{flex:1;display:flex;min-height:0;min-width:0}
.maw-browser-viewer{height:100%;width:100%}
.maw-split-divider-row{width:6px;flex-shrink:0;cursor:col-resize}
.maw-split-divider-column{height:6px;flex-shrink:0;cursor:row-resize}
.agency-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:#090b10bb}
.agency-dialog{width:500px;padding:20px;background:white}
.maw-notification-inbox{position:fixed;z-index:130;top:70px;right:12px;width:340px;padding:16px;background:white}
</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`;
