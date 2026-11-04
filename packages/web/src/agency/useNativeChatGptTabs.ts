import { useEffect, useRef } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import type { useAgencyStore } from './useAgencyStore.js';
import { nativeWebProvider, nativeWorkspaceUrl } from './NativeChatGptView.js';

/** Logical metadata stays on the existing authenticated MAW transport. */
export function useNativeChatGptTabs(tabs: readonly WebTab[], synchronized: boolean, request: ReturnType<typeof useAgencyStore>['request']): void {
  const current = useRef({ tabs, request, synchronized });
  current.current = { tabs, request, synchronized };
  const lastSyncedTabs = useRef<Map<string, { url: string; provider: string }>>(new Map());
  const lastRetainedKey = useRef<string | null>(null);

  useEffect(() => window.mawChatGpt?.subscribe(state => {
    if (state.type === 'tab-shortcut' || state.type === 'close-shortcut') {
      if (document.querySelector('[role="dialog"], [role="menu"], .maw-tab-name-input')) return;
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.maw-tabs-strip [role="tab"]:not(:disabled)')];
      const index = buttons.findIndex(button => button.getAttribute('aria-selected') === 'true');
      if (index < 0) return;
      if (state.type === 'close-shortcut') buttons[index]?.parentElement?.querySelector<HTMLButtonElement>('button[data-close]')?.click();
      else { const next = buttons[(index + (state.direction === -1 ? -1 : 1) + buttons.length) % buttons.length]; next?.focus(); next?.click(); }
      return;
    }
    if (state.type !== 'committed' || !state.id || !state.url || !current.current.synchronized) return;
    const tab = current.current.tabs.find(tab => tab.id === state.id && !tab.closedAt && tab.runtimeState === 'client-managed');
    if (!tab || tab.url === state.url) return;
    // Pre-record committed navigation so the subsequent store update does not issue duplicate IPC.
    lastSyncedTabs.current.set(tab.id, { url: state.url, provider: nativeWebProvider(state.url) });
    // A failed checkpoint keeps the previous durable URL. Refocusing or a
    // reconnect asks the existing view for its latest committed URL again.
    void current.current.request({ type: 'agency.webTab.navigate', workspaceId: tab.workspaceId, tabId: tab.id, url: state.url }).catch(() => {});
  }), []);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !synchronized) {
      lastSyncedTabs.current.clear();
      lastRetainedKey.current = null;
      return;
    }
    const currentSynced = lastSyncedTabs.current;
    const openIds = new Set<string>();
    for (const tab of tabs) {
      if (tab.closedAt || tab.runtimeState !== 'client-managed' || !nativeWorkspaceUrl(tab.url)) continue;
      openIds.add(tab.id);
      const provider = nativeWebProvider(tab.url);
      const prev = currentSynced.get(tab.id);
      if (!prev || prev.url !== tab.url || prev.provider !== provider) {
        currentSynced.set(tab.id, { url: tab.url, provider });
        void bridge.command({ type: 'update', id: tab.id, url: tab.url, provider }).catch(() => {});
      }
    }
    for (const id of currentSynced.keys()) {
      if (!openIds.has(id)) {
        currentSynced.delete(id);
      }
    }
    const retainedKey = Array.from(openIds).sort().join(',');
    if (retainedKey !== lastRetainedKey.current) {
      lastRetainedKey.current = retainedKey;
      void bridge.command({ type: 'retain', ids: [...openIds] }).catch(() => {});
    }
  }, [tabs, synchronized]);
}
