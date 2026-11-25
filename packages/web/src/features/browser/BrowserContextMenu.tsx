import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { classifyWebTabUrl, DEFAULT_BROWSER_PROFILE_ID, validateOtherWebUrl, type WebTab } from '@agent-workbench/shared';
import { getLocale, t } from '../../i18n/index.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { useBrowserSettings } from './useBrowserSettings.js';
import { getLanguageDisplayName } from './SpellCheckSettingsSection.js';
import type { AppSettingsApi } from '../settings/useAppSettings.js';

export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function isSupportedBrowserLink(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
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
  profileId: string;
  x: number;
  y: number;
  linkURL: string;
  pageURL: string;
  canGoBack: boolean;
  canGoForward: boolean;
  selection: boolean;
  selectionText: string;
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
}

export interface ContextMenuItem {
  id?: string;
  label: string;
  disabled?: boolean;
  run: () => void;
}

export function buildBrowserContextMenuItems(params: {
  hasSelection: boolean;
  isValidLink: boolean;
  canOpenUrl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onCopySelection: () => void;
  onCopyLink: () => void;
  onCopyPageUrl: () => void;
  onOpenUrl: () => void;
  onOpenLinkExternal?: () => void;
  onOpenExternalPage: () => void;
  onReload: () => void;
  onBack: () => void;
  onForward: () => void;
  onSearch: () => void;
  onInspectPage?: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (params.hasSelection) {
    items.push({ id: 'copy-selection', label: t('agency.browser.copySelectedText'), run: params.onCopySelection });
  }

  if (params.isValidLink) {
    items.push({ id: 'copy-link', label: t('agency.browser.copyLinkAddress'), run: params.onCopyLink });
    if (params.onOpenLinkExternal) {
      items.push({ id: 'open-link-external', label: t('agency.browser.openLinkInExternalBrowser'), run: params.onOpenLinkExternal });
    }
  }

  items.push({ id: 'copy-page-url', label: t('agency.browser.copyPageUrl'), run: params.onCopyPageUrl });
  items.push({ id: 'open-url', label: t('agency.browser.openUrl'), disabled: !params.canOpenUrl, run: params.onOpenUrl });
  items.push({ id: 'open-external-page', label: t('agency.browser.openInExternalBrowser'), run: params.onOpenExternalPage });
  items.push({ id: 'reload', label: t('agency.browser.reload'), run: params.onReload });
  items.push({ id: 'back', label: t('agency.browser.back'), disabled: !params.canGoBack, run: params.onBack });
  items.push({ id: 'forward', label: t('agency.browser.forward'), disabled: !params.canGoForward, run: params.onForward });
  items.push({ id: 'search', label: t('agency.browser.search'), run: params.onSearch });

  if (params.onInspectPage) {
    items.push({ id: 'inspect-page', label: t('agency.browser.inspectPage'), run: params.onInspectPage });
  }

  return items;
}

/**
 * Context menu for a native browser tab. Commands go to the desktop main
 * process, which owns the WebContents. The page itself gets no preload.
 */
export function BrowserContextMenu({
  tabs,
  appSettings,
  onError,
  onCloseTab: _onCloseTab,
  onMoveNext: _onMoveNext,
  onDuplicate: _onDuplicate,
}: {
  tabs?: readonly WebTab[];
  appSettings?: AppSettingsApi;
  onError?: (message: string) => void;
  request?: ReturnType<typeof useWorkbenchStore>['request'];
  onCloseTab?: (tab: WebTab) => void;
  onMoveNext?: (tabId: string) => void;
  onDuplicate?: (tab: WebTab) => void;
} = {}): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [fallbackAlert, setFallbackAlert] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({ width: 190, height: 220 });
  const { spellCheck, addCustomDictionaryWord } = useBrowserSettings(appSettings);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
  const [activeLanguagesExpanded, setActiveLanguagesExpanded] = useState(false);

  useEffect(() => window.mawChatGpt?.subscribe((state) => {
    if (state.type === 'browser-context' && state.id) {
      setSuggestionsExpanded(true);
      setActiveLanguagesExpanded(false);
      setMenu({
        id: state.id,
        profileId: typeof state.profileId === 'string' && state.profileId ? state.profileId : DEFAULT_BROWSER_PROFILE_ID,
        x: state.x ?? 0,
        y: state.y ?? 0,
        linkURL: state.linkURL ?? '',
        pageURL: state.pageURL ?? '',
        canGoBack: state.canGoBack === true,
        canGoForward: state.canGoForward === true,
        selection: state.selection === true,
        selectionText: state.selectionText ?? '',
        isEditable: state.isEditable === true,
        misspelledWord: state.misspelledWord ?? '',
        dictionarySuggestions: Array.isArray(state.dictionarySuggestions) ? state.dictionarySuggestions : [],
      });
      return;
    }
    if (
      (state.type === 'loading' || state.type === 'committed' || state.type === 'suspended' || state.type === 'error') &&
      state.id
    ) {
      setMenu((prev) => (prev && prev.id === state.id ? null : prev));
    }
  }), []);

  useEffect(() => {
    if (!tabs || !menu) return;
    if (!tabs.some((tab) => tab.id === menu.id)) {
      setMenu(null);
    }
  }, [tabs, menu]);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  }, [menu, suggestionsExpanded, activeLanguagesExpanded, measuredSize.width, measuredSize.height]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!menuRef.current) return;
        const buttons = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (buttons.length === 0) return;
        const activeIdx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIdx = event.key === 'ArrowDown'
          ? (activeIdx + 1) % buttons.length
          : (activeIdx - 1 + buttons.length) % buttons.length;
        buttons[nextIdx]?.focus();
      }
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

  if (!menu) {
    if (!fallbackAlert) return null;
    return (
      <div
        role="alert"
        className="agency-error-bar maw-context-menu-alert"
        style={{ position: 'fixed', top: 12, right: 12, zIndex: 10000 }}
      >
        <span>{fallbackAlert}</span>
        <button
          type="button"
          aria-label={t('agency.ui.dismissError')}
          onClick={() => setFallbackAlert(null)}
        >
          ×
        </button>
      </div>
    );
  }
  const send = (action: string, url?: string) => {
    const command = url ? { type: 'browser-action', id: menu.id, action, url } : { type: 'browser-action', id: menu.id, action };
    void window.mawChatGpt?.command(command);
    setMenu(null);
  };

  const isValidLink = isSupportedBrowserLink(menu.linkURL);
  const link = isValidLink ? menu.linkURL.trim() : '';
  const trimmedSelection = (menu.selectionText || '').trim();
  const selectionIsUrl = isSupportedBrowserLink(trimmedSelection);
  const targetOpenUrl = isValidLink ? link : (selectionIsUrl ? trimmedSelection : '');
  const canOpenUrl = Boolean(targetOpenUrl);

  const handleOpenUrl = () => {
    if (!targetOpenUrl) return;
    send('open-link', targetOpenUrl);
  };

  const handleSearch = () => {
    window.dispatchEvent(new CustomEvent('workbench:open-find-in-page', { detail: { id: menu.id } }));
    setMenu(null);
  };

  const isSpellCheckEnabled = spellCheck.enabled !== false;
  const enabledLanguages = Array.isArray(spellCheck.languages) ? spellCheck.languages : [];
  const currentLocale = getLocale();

  const reportDictionaryError = (message: string) => {
    if (onError) {
      onError(message);
    } else {
      setFallbackAlert(message);
    }
  };

  const handleAddToDictionary = async () => {
    if (!menu.misspelledWord) return;
    const word = menu.misspelledWord;
    const profileId = menu.profileId;
    setMenu(null);
    setFallbackAlert(null);
    const res = await addCustomDictionaryWord(word, profileId);
    if (!res.success) {
      reportDictionaryError(res.error || t('settings.browser.customDictionaryAddFailed'));
    } else if (res.nativeSyncPending) {
      reportDictionaryError(t('settings.browser.customDictionarySyncPending'));
    }
  };

  const handleManageSpellCheck = () => {
    window.dispatchEvent(new CustomEvent('workbench:open-settings', { detail: { tab: 'browser' } }));
    setMenu(null);
  };

  const handleInspectPage = () => {
    const x = Math.max(0, Math.min(32768, Math.round(menu.x)));
    const y = Math.max(0, Math.min(32768, Math.round(menu.y)));
    void window.mawChatGpt?.command({
      type: 'inspect-page',
      id: menu.id,
      x,
      y,
    });
    setMenu(null);
  };

  const handleReplaceMisspelling = (word: string) => {
    void window.mawChatGpt?.command({
      type: 'browser-action',
      id: menu.id,
      action: 'replace-misspelling',
      word,
    });
    setMenu(null);
  };

  const standardItems = buildBrowserContextMenuItems({
    hasSelection: menu.selection,
    isValidLink: Boolean(isValidLink && link),
    canOpenUrl,
    canGoBack: menu.canGoBack,
    canGoForward: menu.canGoForward,
    onCopySelection: () => send('copy-selection'),
    onCopyLink: () => send('copy-link', link),
    onCopyPageUrl: () => send('copy-url'),
    onOpenUrl: handleOpenUrl,
    onOpenLinkExternal: Boolean(isValidLink && link) ? () => send('open-link-external', link) : undefined,
    onOpenExternalPage: () => send('open-page'),
    onReload: () => send('reload'),
    onBack: () => send('back'),
    onForward: () => send('forward'),
    onSearch: handleSearch,
    onInspectPage: handleInspectPage,
  });

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

  const hasMisspelling = Boolean(menu.misspelledWord) && isSpellCheckEnabled;

  return (
    <div
      ref={menuRef}
      className="maw-context-menu"
      role="menu"
      style={{ left: `${finalX}px`, top: `${finalY}px` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {hasMisspelling && (
        <div className="maw-context-menu-spelling" role="group" aria-label={t('agency.browser.spellingSuggestions')}>
          <div className="maw-context-menu-header">{t('agency.browser.spellCheck')}</div>
          {/* Chromium returns a combined dictionarySuggestions array without per-language attribution.
              Keep suggestions in a single collapsible section and display active dictionaries separately. */}
          <div className="maw-context-menu-category">
            <button
              type="button"
              role="menuitem"
              aria-expanded={suggestionsExpanded}
              className="maw-context-menu-category-btn"
              onClick={() => setSuggestionsExpanded((prev) => !prev)}
            >
              <span className="maw-context-menu-chevron" aria-hidden="true">{suggestionsExpanded ? '▾' : '▸'}</span>
              <span className="maw-context-menu-category-name">{t('agency.browser.spellingSuggestions')}</span>
            </button>
            {suggestionsExpanded && (
              <div className="maw-context-menu-category-content">
                {menu.dictionarySuggestions.length > 0 ? (
                  menu.dictionarySuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      role="menuitem"
                      className="maw-context-menu-suggestion"
                      onClick={() => handleReplaceMisspelling(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))
                ) : (
                  <button type="button" role="menuitem" disabled className="maw-context-menu-disabled-item">
                    {t('agency.browser.noSpellingSuggestions')}
                  </button>
                )}
              </div>
            )}
          </div>
          {enabledLanguages.length > 1 && (
            <div className="maw-context-menu-category">
              <button
                type="button"
                role="menuitem"
                aria-expanded={activeLanguagesExpanded}
                className="maw-context-menu-category-btn"
                onClick={() => setActiveLanguagesExpanded((prev) => !prev)}
              >
                <span className="maw-context-menu-chevron" aria-hidden="true">{activeLanguagesExpanded ? '▾' : '▸'}</span>
                <span className="maw-context-menu-category-name">
                  {t('agency.browser.activeLanguages', { count: enabledLanguages.length })}
                </span>
              </button>
              {activeLanguagesExpanded && (
                <div className="maw-context-menu-category-content">
                  {enabledLanguages.map((code) => (
                    <div key={code} className="maw-context-menu-lang-indicator">
                      {getLanguageDisplayName(code, currentLocale)} ({code})
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className="maw-context-menu-action-item"
            onClick={handleAddToDictionary}
          >
            {t('agency.browser.addToDictionary')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="maw-context-menu-action-item"
            onClick={handleManageSpellCheck}
          >
            {t('agency.browser.manageSpellCheck')}
          </button>
          <div className="maw-context-menu-divider" role="separator" />
        </div>
      )}
      {standardItems.map((item, idx) => (
        <span key={item.id ?? item.label} style={{ display: 'contents' }}>
          {item.id === 'inspect-page' && idx > 0 && <div className="maw-context-menu-divider" role="separator" />}
          <button type="button" role="menuitem" disabled={item.disabled} onClick={item.run}>
            {item.label}
          </button>
        </span>
      ))}
    </div>
  );
}
