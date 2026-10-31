import { useLayoutEffect, useRef, useState } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

type Layout = { type: 'layout'; id: string | null; bounds: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number } };
type Command = Layout | { type: 'open' | 'update'; id: string; url: string } | { type: 'close'; id: string } | { type: 'retain'; ids: string[] };
export interface DesktopBridge {
  command: (command: Command) => Promise<void>;
  subscribe: (callback: (state: { type: string; id?: string; url?: string; message?: string; direction?: number }) => void) => () => void;
}
declare global { interface Window { mawChatGpt?: DesktopBridge } }
export function nativeChatGptUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) && !url.username && !url.password && !url.port; }
  catch { return false; }
}
function hasIntersectingOverlay(viewBounds: { left: number; top: number; right: number; bottom: number }): boolean {
  if (viewBounds.right <= viewBounds.left || viewBounds.bottom <= viewBounds.top) return false;
  const items = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], .agency-modal-backdrop, .agency-dropdown-menu, .maw-toast-item, .context-menu, .agency-dialog'
  );
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const rects = item.getClientRects();
    if (rects.length === 0) continue;
    const style = window.getComputedStyle(item);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j]!;
      if (r.width <= 0 || r.height <= 0) continue;
      if (
        r.left < viewBounds.right &&
        r.right > viewBounds.left &&
        r.top < viewBounds.bottom &&
        r.bottom > viewBounds.top
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Only measures MAW's own DOM. Never accesses or injects into the website. */
export function NativeChatGptView({ tab, onDisplayed }: { tab: WebTab; onDisplayed: (id: string, ready: boolean) => void }): JSX.Element {
  const { id } = tab;
  const supported = nativeChatGptUrl(tab.url);
  const callback = useRef(onDisplayed);
  callback.current = onDisplayed;
  const url = useRef(tab.url);
  url.current = tab.url;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !supported) return;
    let frame = 0, last = '', cancelled = false, loaded = false;
    const reportError = (reason: unknown) => { if (!cancelled) setError(String(reason)); };
    const hide = (): Layout => ({ type: 'layout', id: null, bounds: { x: 0, y: 0, width: 0, height: 0 }, viewport: { width: window.innerWidth, height: window.innerHeight } });
    const measure = () => {
      if (cancelled) return;
      const element = host.current;
      const rect = element?.getBoundingClientRect();
      const command = hide();
      if (element && rect && element.getClientRects().length && !document.hidden && !error && getComputedStyle(element).visibility === 'visible') {
        let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        const x = Math.ceil(left), y = Math.ceil(top);
        const width = Math.max(0, Math.floor(right) - x);
        const height = Math.max(0, Math.floor(bottom) - y);
        const viewBounds = { left: x, top: y, right: x + width, bottom: y + height };
        // Detach only when an overlay actually intersects the native content pane bounds.
        if (width > 0 && height > 0 && !hasIntersectingOverlay(viewBounds)) {
          command.id = id;
          command.bounds = { x, y, width, height };
        }
      }
      const serialized = JSON.stringify(command);
      if (serialized !== last) { last = serialized; void bridge.command(command).then(() => { if (!cancelled) callback.current(id, !!command.id && loaded); }).catch(reportError); }
    };
    const tick = () => { measure(); frame = requestAnimationFrame(tick); };
    const unsubscribe = bridge.subscribe(state => {
      if (state.type === 'ready' && state.id === id) { loaded = true; last = ''; measure(); }
      if (state.type === 'loading' && state.id === id) { loaded = false; callback.current(id, false); }
      if (state.type === 'layout-needed') { last = ''; measure(); }
      if (state.type === 'error' && (!state.id || state.id === id)) setError(state.message ?? 'Native page unavailable.');
    });
    // Hide synchronously with MAW DOM changes; continuous measurements also catch
    // ancestor layout/scroll/CSS transitions that ResizeObserver alone misses.
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const release = () => { measure(); };
    const visibility = () => { last = ''; measure(); };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('lostpointercapture', release, true);
    window.addEventListener('blur', release);
    window.addEventListener('focus', release);
    document.addEventListener('visibilitychange', visibility);
    void bridge.command({ type: 'open', id, url: url.current }).then(() => { last = ''; measure(); }).catch(reportError);
    tick();
    return () => {
      cancelled = true;
      callback.current(id, false);
      cancelAnimationFrame(frame);
      observer.disconnect(); unsubscribe();
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('lostpointercapture', release, true);
      window.removeEventListener('blur', release);
      window.removeEventListener('focus', release);
      document.removeEventListener('visibilitychange', visibility);
      void bridge.command(hide()).catch(() => {});
      // Unmounting the surface detaches; only closing a tab destroys its page.
    };
  }, [id, error, supported]);
  return <div ref={host} className="maw-browser-viewer">
    {!window.mawChatGpt || !supported ? <div className="agency-shell-placeholder"><p>{t('agency.web.externalHint')}</p><a href={tab.url} target="_blank" rel="noopener noreferrer">{t('agency.web.externalOpen')}</a></div> : error ? <div className="agency-shell-placeholder" role="alert"><p>{error}</p><button type="button" onClick={() => void window.mawChatGpt?.command({ type: 'close', id }).then(() => setError(''))}>{t('common.reloadPage')}</button></div> : null}
  </div>;
}
