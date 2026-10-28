import { useEffect, useRef, useState } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';
import { hasLiveVideo, isNekoViewerUrl, NEKO_STATUS_PATH } from './viewer-model.js';

interface Props {
  tab: WebTab;
  online: boolean;
  onDisplayed: (tabId: string, ready: boolean) => void;
  onReconnect: () => Promise<void>;
}

/** One Neko WebRTC surface. ChatGPT is rendered by remote Chromium, never framed here. */
export function AgencyBrowserViewer({ tab, online, onDisplayed, onReconnect }: Props): JSX.Element {
  const iframe = useRef<HTMLIFrameElement>(null);
  const callback = useRef(onDisplayed);
  callback.current = onDisplayed;
  const activate = useRef(onReconnect);
  activate.current = onReconnect;
  const [activated, setActivated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'connecting' | 'ready' | 'unavailable' | 'not-configured'>('loading');
  const targetReady = tab.runtimeState === 'ready' && !!tab.targetRef;

  // Workspace navigation must activate its existing target before exposing the shared Neko display.
  useEffect(() => {
    let cancelled = false;
    setActivated(false);
    callback.current(tab.id, false);
    if (online) void activate.current().then(() => {
      if (!cancelled) setActivated(true);
    }).catch(() => { if (!cancelled) setState('unavailable'); });
    return () => { cancelled = true; };
  }, [tab.id, online]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { setState('unavailable'); controller.abort(); }, 10000);
    setUrl(null);
    setState('loading');
    callback.current(tab.id, false);
    if (!online || !targetReady || !activated) {
      window.clearTimeout(timeout);
      return () => controller.abort();
    }
    void fetch(NEKO_STATUS_PATH, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        const status: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!status || typeof status !== 'object') throw new Error('unavailable');
        const info = status as Record<string, unknown>;
        if (info.configured === false) { setState('not-configured'); return; }
        if (info.configured !== true || info.ready !== true || !isNekoViewerUrl(info.url, window.location.origin)) throw new Error('unavailable');
        const endpoint = '/api/agency/browser/viewer?' + new URLSearchParams({ workspaceId: tab.workspaceId, tabId: tab.id });
        const descriptorResponse = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!descriptorResponse.ok) throw new Error('unavailable');
        const viewer = await descriptorResponse.json();
        if (controller.signal.aborted) return;
        if (viewer.workspaceId !== tab.workspaceId || viewer.tabId !== tab.id || !isNekoViewerUrl(viewer.url, window.location.origin, tab.workspaceId, tab.id)) throw new Error('unavailable');
        setUrl(viewer.url);
        setState('connecting');
      })
      .catch(() => { if (!controller.signal.aborted) setState('unavailable'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); callback.current(tab.id, false); };
  }, [tab.id, tab.workspaceId, tab.targetRef, targetReady, online, activated, attempt]);

  useEffect(() => {
    if (!url || !online || !targetReady || !activated) return;
    let previous = false;
    let signaled = false;
    let lastTime = -1;
    let lastProgress = 0;
    const inspect = () => {
      let live = false;
      try {
        const video = iframe.current?.contentDocument?.querySelector('video');
        if (video && hasLiveVideo(video)) {
          if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = performance.now(); }
          live = performance.now() - lastProgress < 3000;
        }
      } catch { /* Cross-origin redirects and inaccessible documents are never inspection evidence. */ }
      const visible = !document.hidden && !!iframe.current?.getClientRects().length;
      const displayed = signaled && live && visible;
      if (displayed !== previous) { previous = displayed; callback.current(tab.id, displayed); }
      setState(live ? 'ready' : 'connecting');
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.workspaceId !== tab.workspaceId || message.tabId !== tab.id) return;
      if (message.type === 'agency.browser.viewer.ready') signaled = true;
      else if (message.type === 'agency.browser.viewer.unavailable') signaled = false;
      else return;
      inspect();
    };
    window.addEventListener('message', onMessage);
    const timer = window.setInterval(inspect, 250);
    document.addEventListener('visibilitychange', inspect);
    inspect();
    return () => { window.clearInterval(timer); window.removeEventListener('message', onMessage); document.removeEventListener('visibilitychange', inspect); callback.current(tab.id, false); };
  }, [url, online, activated, targetReady, tab.id, tab.workspaceId, attempt]);

  const message = !online ? t('agency.web.disconnected') : !targetReady ? t('agency.web.targetUnavailable') :
    state === 'not-configured' ? t('agency.web.notConfigured') : state === 'unavailable' ? t('agency.web.unavailable') :
    state === 'loading' ? t('agency.web.loading') : state === 'ready' ? t('agency.web.connected') : t('agency.web.connecting');
  return <div className="maw-browser-viewer">
    <div className="agency-pane-bar"><span role="status">{message}</span><span className="agency-flex-spacer" />
      <button type="button" className="agency-text-button" disabled={!online} onClick={() => { void onReconnect().then(() => { setActivated(true); setAttempt(value => value + 1); }).catch(() => setState('unavailable')); }}>{t('agency.web.reconnect')}</button>
    </div>
    {url && online && targetReady && activated ? <iframe key={attempt} ref={iframe} className="maw-neko-frame" src={url} title={t('agency.web.viewerTitle', { name: tab.title })} allow="autoplay; fullscreen" referrerPolicy="same-origin" onError={() => { setState('unavailable'); callback.current(tab.id, false); }} /> : <div className="agency-shell-placeholder"><p>{message}</p></div>}
  </div>;
}
