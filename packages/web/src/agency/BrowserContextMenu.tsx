import { useEffect, useState } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';
import type { useAgencyStore } from './useAgencyStore.js';

interface MenuState {
  id: string;
  x: number;
  y: number;
  linkURL: string;
  canGoBack: boolean;
  canGoForward: boolean;
  selection: boolean;
}

/**
 * Context menu for a native browser tab. Commands go to the desktop main
 * process, which owns the WebContents. The page itself gets no preload.
 */
export function BrowserContextMenu({
  tabs,
  request,
  onCloseTab,
  onMoveNext,
  onDuplicate,
}: {
  tabs: readonly WebTab[];
  request: ReturnType<typeof useAgencyStore>['request'];
  onCloseTab: (tab: WebTab) => void;
  onMoveNext: (tabId: string) => void;
  onDuplicate: (tab: WebTab) => void;
}): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => window.mawChatGpt?.subscribe((state) => {
    if (state.type !== 'browser-context' || !state.id) return;
    setMenu({
      id: state.id,
      x: state.x ?? 0,
      y: state.y ?? 0,
      linkURL: state.linkURL ?? '',
      canGoBack: state.canGoBack === true,
      canGoForward: state.canGoForward === true,
      selection: state.selection === true,
    });
  }), []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;
  const tab = tabs.find((item) => item.id === menu.id);
  const send = (action: string, url?: string) => {
    const command = url ? { type: 'browser-action', id: menu.id, action, url } : { type: 'browser-action', id: menu.id, action };
    void window.mawChatGpt?.command(command);
    setMenu(null);
  };
  const link = menu.linkURL.startsWith('https://') ? menu.linkURL : '';
  const items: { label: string; disabled?: boolean; run: () => void }[] = [
    { label: t('agency.browser.back'), disabled: !menu.canGoBack, run: () => send('back') },
    { label: t('agency.browser.forward'), disabled: !menu.canGoForward, run: () => send('forward') },
    { label: t('agency.browser.reload'), run: () => send('reload') },
    { label: t('agency.browser.copyPageUrl'), run: () => send('copy-url') },
    { label: t('agency.browser.copySelection'), disabled: !menu.selection, run: () => send('copy-selection') },
    { label: t('agency.browser.openLink'), disabled: !link, run: () => send('open-link', link) },
    { label: t('agency.browser.openPage'), run: () => send('open-page') },
    { label: t('agency.browser.zoomIn'), run: () => send('zoom-in') },
    { label: t('agency.browser.zoomOut'), run: () => send('zoom-out') },
    { label: t('agency.browser.zoomReset'), run: () => send('zoom-reset') },
    { label: t('agency.browser.moveNext'), disabled: !tab, run: () => { if (tab) onMoveNext(tab.id); setMenu(null); } },
    { label: t('agency.browser.duplicate'), disabled: !tab, run: () => { if (tab) onDuplicate(tab); setMenu(null); } },
    { label: t('agency.browser.close'), disabled: !tab, run: () => { if (tab) onCloseTab(tab); setMenu(null); } },
  ];

  return (
    <div
      className="maw-context-menu"
      role="menu"
      style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={item.run}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
