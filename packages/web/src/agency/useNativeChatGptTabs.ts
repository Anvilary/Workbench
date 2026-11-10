import { useEffect, useRef, useState } from 'react';
import type { WebTab } from '@agent-workbench/shared';
import type { useAgencyStore } from './useAgencyStore.js';
import { nativeWebProvider, nativeWorkspaceUrl } from './NativeChatGptView.js';

/** Logical metadata stays on the existing authenticated MAW transport. */
export function useNativeChatGptTabs(
  tabs: readonly WebTab[],
  synchronized: boolean,
  request: ReturnType<typeof useAgencyStore>['request']
): void {
  const current = useRef({ tabs, request, synchronized });
  current.current = { tabs, request, synchronized };

  // Separate confirmed state from in-flight requests and desired state
  const confirmedTabs = useRef<Map<string, { url: string; provider: string }>>(new Map());
  const inFlightUpdates = useRef<Map<string, { seq: number; url: string; provider: string }>>(new Map());
  const pendingCheckpoints = useRef<Map<string, { url: string; provider: string; seq: number; acknowledged?: boolean }>>(new Map());
  const checkpointInFlight = useRef<Map<string, number>>(new Map());
  const mounted = useRef(true);
  const confirmedRetainedKey = useRef<string | null>(null);
  const inFlightRetainKey = useRef<string | null>(null);
  const seqCounter = useRef(0);
  const retryTimeout = useRef<number | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    mounted.current = true;
    // The desktop retains native pages across a shell-origin change. Their URLs
    // take precedence over the older backend snapshot until checkpointed.
    try {
      const restored = window.mawRestoredBrowserTabs;
      delete window.mawRestoredBrowserTabs;
      if (Array.isArray(restored)) for (const entry of restored) {
        if (!entry || typeof entry !== 'object') continue;
        const tab = entry as Partial<WebTab>;
        if (typeof tab.id !== 'string' || typeof tab.url !== 'string' || !nativeWorkspaceUrl(tab.url, tab.provider)) continue;
        const provider = nativeWebProvider(tab.url, tab.provider);
        pendingCheckpoints.current.set(tab.id, { url: tab.url, provider, seq: ++seqCounter.current });
        confirmedTabs.current.set(tab.id, { url: tab.url, provider });
      }
    } catch {}
    return () => {
      mounted.current = false;
      if (retryTimeout.current !== null) {
        window.clearTimeout(retryTimeout.current);
        retryTimeout.current = null;
      }
    };
  }, []);

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
    if (state.type !== 'committed' || !state.id || !state.url) return;
    const tab = current.current.tabs.find(t => t.id === state.id && !t.closedAt && t.runtimeState === 'client-managed');
    if (!tab || !nativeWorkspaceUrl(state.url, tab.provider)) return;
    if (tab.url === state.url && !pendingCheckpoints.current.has(tab.id)) return;
    const provider = nativeWebProvider(state.url, tab.provider);
    pendingCheckpoints.current.set(tab.id, { url: state.url, provider, seq: ++seqCounter.current, acknowledged: tab.url === state.url });
    confirmedTabs.current.set(tab.id, { url: state.url, provider });
    inFlightUpdates.current.delete(tab.id);
    setRetryEpoch(e => e + 1);

  }), []);

  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge || !synchronized) {
      confirmedTabs.current.clear();
      inFlightUpdates.current.clear();
      confirmedRetainedKey.current = null;
      inFlightRetainKey.current = null;
      if (retryTimeout.current !== null) {
        window.clearTimeout(retryTimeout.current);
        retryTimeout.current = null;
      }
      return;
    }

    const scheduleRetry = () => {
      if (retryTimeout.current !== null) return;
      retryTimeout.current = window.setTimeout(() => {
        retryTimeout.current = null;
        setRetryEpoch(e => e + 1);
      }, 300);
    };

    const openIds = new Set<string>();
    for (const tab of tabs) {
      if (tab.closedAt || tab.runtimeState !== 'client-managed' || !nativeWorkspaceUrl(tab.url, tab.provider)) continue;
      openIds.add(tab.id);
      let pending = pendingCheckpoints.current.get(tab.id);
      if (pending?.acknowledged && pending.url === tab.url) {
        pendingCheckpoints.current.delete(tab.id);
        pending = undefined;
      }
      if (pending && !pending.acknowledged && !checkpointInFlight.current.has(tab.id)) {
        const checkpoint = pending;
        checkpointInFlight.current.set(tab.id, checkpoint.seq);
        void request({ type: 'agency.webTab.navigate', workspaceId: tab.workspaceId, tabId: tab.id, url: checkpoint.url })
          .then(() => {
            const latest = pendingCheckpoints.current.get(tab.id);
            if (latest?.seq === checkpoint.seq) latest.acknowledged = true;
          }).catch(() => { if (mounted.current) scheduleRetry(); })
          .finally(() => {
            if (checkpointInFlight.current.get(tab.id) === checkpoint.seq) checkpointInFlight.current.delete(tab.id);
            const latest = pendingCheckpoints.current.get(tab.id);
            if (mounted.current && latest && (latest.acknowledged || latest.seq !== checkpoint.seq)) setRetryEpoch(e => e + 1);
          });
      }
      const desiredUrl = pending?.url ?? tab.url;
      const provider = pending?.provider ?? nativeWebProvider(desiredUrl, tab.provider);
      const confirmed = confirmedTabs.current.get(tab.id);
      const inFlight = inFlightUpdates.current.get(tab.id);

      // If already confirmed for this exact URL & provider, skip IPC
      if (confirmed && confirmed.url === desiredUrl && confirmed.provider === provider) {
        continue;
      }
      // If an in-flight request is already targeting this exact URL & provider, await it
      if (inFlight && inFlight.url === desiredUrl && inFlight.provider === provider) {
        continue;
      }

      const seq = ++seqCounter.current;
      inFlightUpdates.current.set(tab.id, { seq, url: desiredUrl, provider });

      void bridge.command({ type: 'update', id: tab.id, url: desiredUrl, provider })
        .then(() => {
          if (inFlightUpdates.current.get(tab.id)?.seq === seq) {
            inFlightUpdates.current.delete(tab.id);
            confirmedTabs.current.set(tab.id, { url: desiredUrl, provider });
          }
        })
        .catch(() => {
          if (inFlightUpdates.current.get(tab.id)?.seq === seq) {
            inFlightUpdates.current.delete(tab.id);
            scheduleRetry();
          }
        });
    }

    // Clean up closed tabs from cache
    for (const id of confirmedTabs.current.keys()) {
      if (!openIds.has(id)) {
        confirmedTabs.current.delete(id);
      }
    }
    for (const id of inFlightUpdates.current.keys()) {
      if (!openIds.has(id)) {
        inFlightUpdates.current.delete(id);
      }
    }
    for (const id of pendingCheckpoints.current.keys()) if (!openIds.has(id)) pendingCheckpoints.current.delete(id);

    // Retain management: dispatch retain only when active set changes
    const retainedKey = Array.from(openIds).sort().join(',');
    if (retainedKey !== confirmedRetainedKey.current && inFlightRetainKey.current !== retainedKey) {
      inFlightRetainKey.current = retainedKey;
      void bridge.command({ type: 'retain', ids: [...openIds] })
        .then(() => {
          if (inFlightRetainKey.current === retainedKey) {
            confirmedRetainedKey.current = retainedKey;
            inFlightRetainKey.current = null;
          }
        })
        .catch(() => {
          if (inFlightRetainKey.current === retainedKey) {
            inFlightRetainKey.current = null;
            scheduleRetry();
          }
        });
    }
  }, [tabs, synchronized, retryEpoch]);
}
