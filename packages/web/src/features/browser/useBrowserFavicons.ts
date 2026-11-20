import { useEffect, useState, useCallback } from 'react';
import { validateFaviconUrl } from '@agent-workbench/shared';

const STORAGE_KEY = 'agency-ui.browser-favicons.v1';

function readStoredFavicons(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [id, url] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof url === 'string') {
        const valid = validateFaviconUrl(url, { allowLoopback: true });
        if (valid) result[id] = valid;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredFavicons(favicons: Record<string, string>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favicons));
  } catch {}
}

export function useBrowserFavicons() {
  const [favicons, setFavicons] = useState<Record<string, string>>(() => readStoredFavicons());

  useEffect(() => {
    writeStoredFavicons(favicons);
  }, [favicons]);

  // Sync with Electron main process
  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge) return;

    // Fetch already-discovered favicons
    void bridge.command({ type: 'get-favicons' }).then((res: unknown) => {
      if (res && typeof res === 'object' && 'ok' in res && (res as { ok: boolean }).ok && 'favicons' in res) {
        const received = (res as { favicons: Record<string, string> }).favicons;
        if (received && typeof received === 'object') {
          setFavicons((prev) => {
            const next = { ...prev };
            for (const [id, url] of Object.entries(received)) {
              const valid = validateFaviconUrl(url, { allowLoopback: true });
              if (valid) next[id] = valid;
            }
            return next;
          });
        }
      }
    }).catch(() => {});

    // Listen for real-time favicon events
    return bridge.subscribe((state) => {
      if (state.type === 'favicon' && state.id) {
        const id = state.id;
        const rawFavicon = (state as { favicon?: string }).favicon;
        if (rawFavicon) {
          const valid = validateFaviconUrl(rawFavicon, { allowLoopback: true });
          if (valid) {
            setFavicons((prev) => (prev[id] === valid ? prev : { ...prev, [id]: valid }));
          }
        } else {
          setFavicons((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      }
    });
  }, []);

  const removeFavicon = useCallback((tabId: string) => {
    setFavicons((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const setFavicon = useCallback((tabId: string, url: string) => {
    const valid = validateFaviconUrl(url, { allowLoopback: true });
    if (valid) {
      setFavicons((prev) => ({ ...prev, [tabId]: valid }));
    }
  }, []);

  return {
    favicons,
    removeFavicon,
    setFavicon,
  };
}
