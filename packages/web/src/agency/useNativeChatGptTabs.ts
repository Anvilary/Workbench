import { useEffect, useRef } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import type { useAgencyStore } from './useAgencyStore.js';
import { nativeChatGptUrl } from './NativeChatGptView.js';

/** Logical metadata stays on the existing authenticated MAW transport. */
export function useNativeChatGptTabs(tabs: readonly WebTab[], synchronized: boolean, request: ReturnType<typeof useAgencyStore>['request']): void {
  const current = useRef({ tabs, request, synchronized });
  current.current = { tabs, request, synchronized };
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
    // A failed checkpoint keeps the previous durable URL. Refocusing or a
    // reconnect asks the existing view for its latest committed URL again.
    void current.current.request({ type: 'agency.webTab.navigate', workspaceId: tab.workspaceId, tabId: tab.id, url: state.url }).catch(() => {});
  }), []);
  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !synchronized) return;
    const open = new Set<string>();
    for (const tab of tabs) {
      if (tab.closedAt || tab.runtimeState !== 'client-managed' || !nativeChatGptUrl(tab.url)) continue;
      open.add(tab.id);
      void bridge.command({ type: 'update', id: tab.id, url: tab.url }).catch(() => {});
    }
    void bridge.command({ type: 'retain', ids: [...open] }).catch(() => {});
  }, [tabs, synchronized]);
}
