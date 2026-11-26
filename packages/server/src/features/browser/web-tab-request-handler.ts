/**
 * Message handler for WebTab protocol messages.
 *
 * Dispatches parsed client messages to the BrowserTabAdapter and formats
 * protocol responses or agency.error messages.
 */

import type {
  AgencyServerMessage,
  WebTabServerMessage,
} from '@anvilary/workbench-shared';
import { parseWebTabClientMessage } from '@anvilary/workbench-shared';
import type { BrowserTabAdapter } from './browser-tab-adapter.js';
import { BrowserTabStoreError } from './browser-tab-store.js';

export type WebTabHandlerResponse = WebTabServerMessage | Extract<AgencyServerMessage, { type: 'agency.error' }>;

export interface WebTabHandlerContext {
  adapter: BrowserTabAdapter;
  publish?: (message: WebTabServerMessage) => void;
}

export async function handleWebTabMessage(
  raw: unknown,
  context: WebTabHandlerContext,
): Promise<WebTabHandlerResponse | null> {
  const message = parseWebTabClientMessage(raw);
  if (!message) return null;

  const requestId = message.requestId;

  try {
    switch (message.type) {
      case 'agency.webTab.create': {
        const tab = await context.adapter.createTab({
          workspaceId: message.workspaceId,
          url: message.url,
          provider: message.provider,
          title: message.title,
          order: message.order,
          select: message.select,
          launchId: message.launchId,
          unloaded: message.unloaded,
        });
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'created',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.webTab.created',
          requestId,
          tab,
        };
      }

      case 'agency.webTab.select': {
        let tab: import('@anvilary/workbench-shared').WebTab;
        try {
          tab = await context.adapter.selectTab(message.workspaceId, message.tabId);
        } catch (error) {
          const current = context.adapter.getTabState(message.tabId);
          if (current && current.workspaceId === message.workspaceId && current.closedAt === null) {
            context.publish?.({
              type: 'agency.webTab.changed',
              change: 'updated',
              workspaceId: message.workspaceId,
              tab: current,
            });
          }
          throw error;
        }
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'updated',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.webTab.updated',
          requestId,
          tab,
        };
      }

      case 'agency.webTab.navigate': {
        const tab = await context.adapter.navigateTab(message.workspaceId, message.tabId, message.url);
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'updated',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.webTab.updated',
          requestId,
          tab,
        };
      }

      case 'agency.webTab.rename': {
        const tab = await context.adapter.renameTab(message.workspaceId, message.tabId, message.title);
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'updated',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.webTab.updated',
          requestId,
          tab,
        };
      }

      case 'agency.webTab.order': {
        const tabs = await context.adapter.orderTabs(message.workspaceId, message.tabIds);
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'ordered',
          workspaceId: message.workspaceId,
          tabs,
        });
        return {
          type: 'agency.webTabs.snapshot',
          requestId,
          tabs,
        };
      }

      case 'agency.webTab.close': {
        const tab = await context.adapter.closeTab(message.workspaceId, message.tabId);
        context.publish?.({
          type: 'agency.webTab.changed',
          change: 'closed',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.webTab.closed',
          requestId,
          tab,
        };
      }

      case 'agency.webTabs.list': {
        const tabs = context.adapter.listTabs(message.workspaceId);
        return {
          type: 'agency.webTabs.snapshot',
          requestId,
          tabs,
        };
      }
    }
  } catch (error) {
    const code = error instanceof BrowserTabStoreError ? error.code : 'internal-error';
    const msg = error instanceof Error ? error.message : String(error);
    return {
      type: 'agency.error',
      requestId,
      code,
      message: msg,
    };
  }
}
