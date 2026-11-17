import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { classifyWebTabUrl, isLoopbackHost, validateOtherWebUrl, type WebTab } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';
import type { useAgencyStore } from './useAgencyStore.js';

export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function isSupportedBrowserLink(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
    if (isLoopbackHost(parsed.hostname)) return false;
    const classification = classifyWebTabUrl(trimmed);
    if (classification.valid) return true;
    const other = validateOtherWebUrl(trimmed);
    return other.valid;
  } catch {
    return false;
  }
}

export function getBrowserContentBounds(tabId: string): { bounds: BoundingBox; originX: number; originY: number } {
  if (typeof document === 'undefined') {
    return {
      bounds: { left: 0, top: 0, right: 1200, bottom: 800 },
      originX: 0,
      originY: 0,
    };
  }

  const viewer =
    document.querySelector<HTMLElement>(`[data-native-id="${tabId}"]`) ||
    document.querySelector<HTMLElement>('.maw-browser-pane') ||
    document.querySelector<HTMLElement>('.agency-workspace-content');

  if (!viewer) {
    return {
      bounds: {
        left: 0,
        top: 0,
        right: window.innerWidth || 1200,
        bottom: window.innerHeight || 800,
      },
      originX: 0,
      originY: 0,
    };
  }

  const rect = viewer.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;

  for (let parent = viewer.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    const clipsX = style.overflowX !== 'visible' && style.overflowX !== '';
    const clipsY = style.overflowY !== 'visible' && style.overflowY !== '';
    if (clipsX || clipsY) {
      const pRect = parent.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, pRect.left);
        right = Math.min(right, pRect.right);
      }
      if (clipsY) {
        top = Math.max(top, pRect.top);
        bottom = Math.min(bottom, pRect.bottom);
      }
    }
  }

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(window.innerWidth, right);
  bottom = Math.min(window.innerHeight, bottom);

  return {
    bounds: { left, top, right, bottom },
    originX: rect.left,
    originY: rect.top,
  };
}

export function calculateMenuPosition(params: {
  pointerX: number;
  pointerY: number;
  bounds: BoundingBox;
  menuWidth: number;
  menuHeight: number;
  padding?: number;
}): { x: number; y: number } {
  const { pointerX, pointerY, bounds, menuWidth, menuHeight } = params;
  const padding = params.padding ?? 6;

  const contentLeft = bounds.left + padding;
  const contentRight = Math.max(contentLeft, bounds.right - padding);
  const contentTop = bounds.top + padding;
  const contentBottom = Math.max(contentTop, bounds.bottom - padding);

  // Horizontal positioning:
  let x = pointerX;
  if (x + menuWidth > contentRight) {
    x = contentRight - menuWidth;
  }
  if (x < contentLeft) {
    x = contentLeft;
  }

  // Vertical positioning:
  let y = pointerY;
  if (y + menuHeight > contentBottom) {
    // Attempt flip upwards above pointer
    const flippedY = pointerY - menuHeight;
    if (flippedY >= contentTop) {
      y = flippedY;
    } else {
      // Shift to stay inside bounds
      y = Math.max(contentTop, contentBottom - menuHeight);
    }
  }
  if (y < contentTop) {
    y = contentTop;
  }

  return { x: Math.round(x), y: Math.round(y) };
}

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
  onCloseTab,
  onMoveNext,
  onDuplicate,
}: {
  tabs: readonly WebTab[];
  request?: ReturnType<typeof useAgencyStore>['request'];
  onCloseTab: (tab: WebTab) => void;
  onMoveNext: (tabId: string) => void;
  onDuplicate: (tab: WebTab) => void;
}): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({ width: 190, height: 240 });

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

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  }, [menu, measuredSize.width, measuredSize.height]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  if (!menu) return null;
  const tab = tabs.find((item) => item.id === menu.id);
  const send = (action: string, url?: string) => {
    const command = url ? { type: 'browser-action', id: menu.id, action, url } : { type: 'browser-action', id: menu.id, action };
    void window.mawChatGpt?.command(command);
    setMenu(null);
  };
  const isValidLink = isSupportedBrowserLink(menu.linkURL);
  const link = isValidLink ? menu.linkURL.trim() : '';
  const items: { label: string; disabled?: boolean; run: () => void }[] = [
    { label: t('agency.browser.back'), disabled: !menu.canGoBack, run: () => send('back') },
    { label: t('agency.browser.forward'), disabled: !menu.canGoForward, run: () => send('forward') },
    { label: t('agency.browser.reload'), run: () => send('reload') },
    { label: t('agency.browser.copyPageUrl'), run: () => send('copy-url') },
    { label: t('agency.browser.copySelection'), disabled: !menu.selection, run: () => send('copy-selection') },
    { label: t('agency.browser.openLink'), disabled: !link, run: () => send('open-link', link) },
    { label: t('agency.browser.moveNext'), disabled: !tab, run: () => { if (tab) onMoveNext(tab.id); setMenu(null); } },
    { label: t('agency.browser.duplicate'), disabled: !tab, run: () => { if (tab) onDuplicate(tab); setMenu(null); } },
    { label: t('agency.browser.close'), disabled: !tab, run: () => { if (tab) onCloseTab(tab); setMenu(null); } },
  ];

  const { bounds, originX, originY } = getBrowserContentBounds(menu.id);
  const pointerX = originX + menu.x;
  const pointerY = originY + menu.y;

  const { x: finalX, y: finalY } = calculateMenuPosition({
    pointerX,
    pointerY,
    bounds,
    menuWidth: measuredSize.width,
    menuHeight: measuredSize.height,
  });

  return (
    <div
      ref={menuRef}
      className="maw-context-menu"
      role="menu"
      style={{ left: `${finalX}px`, top: `${finalY}px` }}
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
