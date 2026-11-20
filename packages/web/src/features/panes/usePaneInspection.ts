import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MawActivityState, WorkspaceId } from '@agent-workbench/shared';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';

interface Inspection {
  workspaceId: WorkspaceId;
  tab?: WorkspaceTab;
  serverSelectedId?: string;
  online: boolean;
  displayed: ReadonlySet<string>;
  activity?: MawActivityState;
  activityVersion: string;
  request: ReturnType<typeof useWorkbenchStore>['request'];
  onDisplayed?: (workspaceId: WorkspaceId, tabId: string) => void;
  onAcknowledge?: (workspaceId: WorkspaceId, tabId: string) => Promise<void> | void;
  onError: (message: string) => void;
  onSelectionFailed: () => void;
}

/** Selection and inspection share a queue: a later selection cannot overtake an acknowledgement. */
export function usePaneInspection(input: Inspection, selecting: { current: number }): void {
  const latest = useRef(input);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const acknowledged = useRef(new Set<string>());
  const [confirmed, setConfirmed] = useState<{ tabId: string; generation: number } | null>(null);

  useLayoutEffect(() => { latest.current = input; });

  useLayoutEffect(() => {
    const current = ++generation.current;
    const { tab, workspaceId, online } = input;
    setConfirmed(null);
    if (!tab || !online) return;

    // A snapshot can predate an outstanding selection; confirm every new focus intent.
    selecting.current += 1;
    queue.current = queue.current.then(async () => {
      if (generation.current !== current) return;
      try {
        await latest.current.request(tab.kind === 'web'
          ? { type: 'agency.webTab.select', workspaceId, tabId: tab.id }
          : { type: 'agency.tab.action', workspaceId, tabId: tab.id, action: 'select' });
        if (generation.current === current) setConfirmed({ tabId: tab.id, generation: current });
      } catch (reason) {
        if (generation.current !== current) return;
        latest.current.onError(reason instanceof Error ? reason.message : String(reason));
        latest.current.onSelectionFailed();
      }
    }).finally(() => { selecting.current -= 1; });

    // Invalidate queued work on focus changes, disconnects and workspace unmounts.
    return () => { generation.current += 1; };
  }, [input.workspaceId, input.tab?.id, input.online]);

  useEffect(() => {
    const current = generation.current;
    const { tab, workspaceId, activityVersion } = input;
    if (!tab || confirmed?.tabId !== tab.id || confirmed.generation !== current) return;
    queue.current = queue.current.then(async () => {
      const state = latest.current;
      if (generation.current !== current || !state.online || document.hidden ||
          !state.displayed.has(tab.id) || state.serverSelectedId !== tab.id ||
          state.activityVersion !== activityVersion) return;

      state.onDisplayed?.(workspaceId, tab.id);
      const key = `${workspaceId}:${tab.id}:${activityVersion}`;
      if (state.activity !== 'finished' || !state.onAcknowledge || acknowledged.current.has(key)) return;
      // Retain successful and in-flight keys even if an intermediate snapshot changes activity.
      acknowledged.current.add(key);
      try {
        await state.onAcknowledge(workspaceId, tab.id);
      } catch (reason) {
        acknowledged.current.delete(key);
        if (generation.current === current) {
          latest.current.onError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    });
  }, [confirmed, input.workspaceId, input.tab?.id, input.online, input.displayed,
    input.serverSelectedId, input.activity, input.activityVersion, input.onDisplayed, input.onAcknowledge]);
}
