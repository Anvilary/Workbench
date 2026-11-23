import { useEffect, useRef, useState } from 'react';
import type { WebTab, SearchEngine } from '@agent-workbench/shared';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  validateChatGptUrl,
  validateGithubUrl,
  validateOtherWebUrl,
  validatePerplexityUrl,
  getSearchEngine,
  resolveAddressBarInput,
} from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { BrowserFindBar } from './BrowserFindBar.js';
import { nativeLayoutCoordinator } from './native-layout-coordinator.js';

export function nativeChatGptUrl(value: string): boolean {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return false;
  return validateChatGptUrl(value).valid;
}

export function nativePerplexityUrl(value: string): boolean {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return false;
  return validatePerplexityUrl(value).valid;
}

export function nativeWorkspaceUrl(value: string, provider?: WebTab['provider']): boolean {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  if (provider === 'other') return validateOtherWebUrl(value).valid;
  if (nativeChatGptUrl(value)) return provider === undefined || provider === 'chatgpt';
  if (nativePerplexityUrl(value)) return provider === undefined || provider === 'perplexity';
  return (provider === undefined || provider === 'github') && validateGithubUrl(value).valid;
}

export function nativeWebProvider(value: string, storedProvider?: WebTab['provider']): 'chatgpt' | 'github' | 'perplexity' | 'other' {
  if (storedProvider) return storedProvider;
  if (nativeChatGptUrl(value)) return 'chatgpt';
  if (nativePerplexityUrl(value)) return 'perplexity';
  if (validateGithubUrl(value).valid) return 'github';
  return 'other';
}

export function NativeBrowserView({
  tab,
  profileId = DEFAULT_BROWSER_PROFILE_ID,
  toolbarOpen = false,
  onExpandToolbar,
  onDisplayed,
  onFocused,
  searchEngine,
  activeWorkspace = true,
}: {
  tab: WebTab;
  profileId?: string;
  toolbarOpen?: boolean;
  onExpandToolbar?: () => void;
  onDisplayed: (id: string, ready: boolean) => void;
  onFocused?: () => void;
  searchEngine?: SearchEngine;
  activeWorkspace?: boolean;
}): JSX.Element {
  const effectiveSearchEngine = searchEngine ?? getSearchEngine();
  const { id } = tab;
  const supported = nativeWorkspaceUrl(tab.url, tab.provider);
  const callback = useRef(onDisplayed);
  callback.current = onDisplayed;
  const focusCallback = useRef(onFocused);
  focusCallback.current = onFocused;
  const expandCallback = useRef(onExpandToolbar);
  expandCallback.current = onExpandToolbar;
  const url = useRef(tab.url);
  url.current = tab.url;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [isPageReady, setIsPageReady] = useState(() => nativeLayoutCoordinator.isReady(id));
  const [captureBackdrop, setCaptureBackdrop] = useState<string | null>(null);
  const [downloadFeedback, setDownloadFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [address, setAddress] = useState(tab.url);
  const [history, setHistory] = useState({ canGoBack: false, canGoForward: false });
  const [findOpen, setFindOpen] = useState(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const provider = tab.provider ?? nativeWebProvider(tab.url);

  useEffect(() => setAddress(tab.url), [tab.url]);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !supported || !host.current || !activeWorkspace) return;

    void bridge.command({ type: 'open', id, url: url.current, provider: tab.provider ?? nativeWebProvider(url.current), profileId }).catch((err) => {
      setError(String(err));
    });
    const unsubscribe = bridge.subscribe((state) => {
      if (state.id !== id) return;
      if (state.type === 'ready') {
        setIsPageReady(true);
        setRestoring(false);
      }
      if (state.type === 'loading') {
        setIsPageReady(false);
      }
      if (state.type === 'restoring') {
        setRestoring(true);
        setIsPageReady(false);
      }
      if (state.type === 'open-find-in-page') {
        setFindOpen(true);
      }
      if (state.type === 'address-shortcut') {
        expandCallback.current?.();
        setTimeout(() => {
          addressInput.current?.focus();
          addressInput.current?.select();
        }, 0);
      }
      if (state.type === 'navigation' && state.url) {
        setAddress(state.url);
        setHistory({ canGoBack: !!state.canGoBack, canGoForward: !!state.canGoForward });
      }
      if (state.type === 'committed' && state.url) setAddress(state.url);
    });

    const unregister = nativeLayoutCoordinator.register({
      id,
      element: host.current,
      onDisplayed: (ready) => callback.current(id, ready),
      onReadyChange: (ready) => setIsPageReady(ready),
      onFocused: () => focusCallback.current?.(),
      setCaptureBackdrop,
      onError: (msg) => setError(msg),
      onRestoring: setRestoring,
      onDownloadEvent: (evt) => {
        if (evt.type === 'download-complete') {
          const name = evt.filename || '';
          setDownloadFeedback({
            message: name ? `${t('agency.ui.fileDownloaded')}: ${name}` : t('agency.ui.fileDownloaded'),
            type: 'success',
          });
          setTimeout(() => setDownloadFeedback(null), 2000);
        } else if (evt.type === 'download-failed') {
          setDownloadFeedback({
            message: t('agency.ui.downloadFailed'),
            type: 'error',
          });
          setTimeout(() => setDownloadFeedback(null), 2000);
        }
      },
    });

    return () => {
      unsubscribe();
      unregister();
    };
  }, [id, profileId, supported, activeWorkspace]);

  useEffect(() => {
    const onOpenFind = (e: Event) => {
      const custom = e as CustomEvent<{ id?: string }>;
      if (custom.detail?.id === id) {
        setFindOpen(true);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (nativeLayoutCoordinator.isViewing(id) || host.current?.contains(document.activeElement)) {
          e.preventDefault();
          setFindOpen(true);
        }
      }
    };
    window.addEventListener('workbench:open-find-in-page', onOpenFind);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('workbench:open-find-in-page', onOpenFind);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [id]);

  return (
    <div className="maw-browser-pane">
      {window.mawChatGpt && supported && toolbarOpen && <div className="maw-browser-toolbar">
        <button type="button" aria-label={t('agency.browser.back')} disabled={!history.canGoBack} onClick={() => void window.mawChatGpt?.command({ type: 'browser-action', id, action: 'back' })}>‹</button>
        <button type="button" aria-label={t('agency.browser.forward')} disabled={!history.canGoForward} onClick={() => void window.mawChatGpt?.command({ type: 'browser-action', id, action: 'forward' })}>›</button>
        <button type="button" aria-label={t('agency.browser.reload')} onClick={() => void window.mawChatGpt?.command({ type: 'browser-action', id, action: 'reload' })}>↻</button>
        <form onSubmit={(event) => {
          event.preventDefault();
          const value = address.trim();
          if (provider === 'other') {
            const resolved = resolveAddressBarInput(value, effectiveSearchEngine, 'other');
            if (resolved.url) {
              setAddress(resolved.url);
              void window.mawChatGpt?.command({ type: 'update', id, url: resolved.url, provider: 'other', profileId }).catch((reason) => setError(String(reason)));
            } else {
              addressInput.current?.setCustomValidity(resolved.error || t('agency.web.invalidUrl'));
              addressInput.current?.reportValidity();
            }
          } else {
            if (nativeWorkspaceUrl(value, provider)) {
              void window.mawChatGpt?.command({ type: 'update', id, url: value, provider, profileId }).catch((reason) => setError(String(reason)));
            } else {
              addressInput.current?.setCustomValidity(t('agency.web.invalidUrl'));
              addressInput.current?.reportValidity();
            }
          }
        }}>
          <input ref={addressInput} aria-label={t('agency.browser.address')} value={address} onChange={(event) => { event.currentTarget.setCustomValidity(''); setAddress(event.target.value); }} onKeyDown={(event) => { if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); event.currentTarget.select(); } }} />
        </form>
      </div>}
      {findOpen && (
        <BrowserFindBar id={id} onClose={() => setFindOpen(false)} />
      )}
      <div ref={host} className="maw-browser-viewer" data-native-id={id}>
      {!window.mawChatGpt || !supported ? (
        <div className="agency-shell-placeholder">
          <p>{t('agency.web.externalHint')}</p>
          <a href={tab.url} target="_blank" rel="noopener noreferrer">{t('agency.web.externalOpen')}</a>
        </div>
      ) : error ? (
        <div className="agency-shell-placeholder" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              setError('');
              void window.mawChatGpt?.command({ type: 'open', id, url: url.current, provider: tab.provider ?? nativeWebProvider(url.current), profileId });
            }}
          >
            {t('common.reloadPage')}
          </button>
        </div>
      ) : (
        <>
          {captureBackdrop && <img className="maw-capture-backdrop" src={captureBackdrop} alt="" />}
          {(!isPageReady || restoring) && !captureBackdrop && (
            <div className="maw-browser-loading-container" role="status" aria-label={t('agency.web.loadingPage')}>
              <img
                src="/brand/workbench-logo-128.png"
                className="maw-browser-loading-logo"
                alt=""
                width="32"
                height="32"
              />
            </div>
          )}
          {downloadFeedback && (
            <div className={`maw-pane-feedback maw-pane-feedback-${downloadFeedback.type}`} role="status">
              {downloadFeedback.message}
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
