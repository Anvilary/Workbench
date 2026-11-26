import { useEffect, type MutableRefObject } from 'react';
import {
  classifyWebTabUrl,
  getPaneNodes,
  validateOtherWebUrl,
  type WebTabProvider,
  type WorkspaceId,
  type WorkspacePaneLayout,
} from '@anvilary/workbench-shared';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { t } from '../../i18n/index.js';

type AgencyRequestFn = ReturnType<typeof useWorkbenchStore>['request'];
type AgencyResponse = Awaited<ReturnType<AgencyRequestFn>>;

export interface UseNativeWebTabLinksOptions {
  workspaceId: WorkspaceId;
  tabs: readonly WorkspaceTab[];
  layoutRef: MutableRefObject<WorkspacePaneLayout>;
  request: AgencyRequestFn;
  onCreated: (response: AgencyResponse, targetPaneId: string) => void;
  onError: (message: string) => void;
}

/**
 * Subscribes to native Electron `open-web-tab` requests triggered from embedded
 * browser panes and opens the validated destination tab inside the originating pane.
 */
export function useNativeWebTabLinks({
  workspaceId,
  tabs,
  layoutRef,
  request,
  onCreated,
  onError,
}: UseNativeWebTabLinksOptions): void {
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;
    return bridge.subscribe((state) => {
      if (state.type !== 'open-web-tab' || !state.url || !state.sourceTabId) return;

      const sourceTabId = state.sourceTabId;
      const targetUrl = state.url;
      const sourceTab = tabs.find((tab) => tab.id === sourceTabId);
      if (!sourceTab) return;

      const panes = getPaneNodes(layoutRef.current.tree);
      const sourcePane = panes.find((pane) => pane.tabIds.includes(sourceTabId));
      const targetPaneId = sourcePane?.id ?? layoutRef.current.focusedPaneId;

      const classification = classifyWebTabUrl(targetUrl);
      const otherValidation = validateOtherWebUrl(targetUrl);
      if (!classification.valid && !otherValidation.valid) {
        onError(t('agency.web.invalidUrl'));
        return;
      }

      const provider: WebTabProvider = classification.provider ?? 'other';
      const urlToOpen = classification.normalizedUrl ?? otherValidation.normalizedUrl ?? targetUrl;
      let title = '';
      try {
        if (provider === 'github') title = 'GitHub';
        else if (provider === 'chatgpt') title = 'ChatGPT';
        else if (provider === 'perplexity') title = 'Perplexity';
        else title = new URL(urlToOpen).hostname;
      } catch {
        title = provider;
      }

      const launchId = crypto.randomUUID();
      void request({
        type: 'agency.webTab.create',
        workspaceId,
        url: urlToOpen,
        provider,
        title,
        select: true,
        targetPaneId,
        launchId,
      })
        .then((response) => {
          onCreated(response, targetPaneId);
        })
        .catch((reason) => {
          onError(reason instanceof Error ? reason.message : String(reason));
        });
    });
  }, [tabs, workspaceId, layoutRef, request, onCreated, onError]);
}
