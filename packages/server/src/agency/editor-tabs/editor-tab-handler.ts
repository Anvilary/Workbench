/**
 * Message handler for EditorTab protocol messages.
 *
 * Dispatches parsed client messages to the EditorTabAdapter and formats
 * protocol responses or agency.error messages.
 */

import type {
  AgencyServerMessage,
  EditorTabServerMessage,
} from '@agent-workbench/shared';
import { parseEditorTabClientMessage } from '@agent-workbench/shared';
import type { EditorTabAdapter } from './editor-tab-adapter.js';
import { EditorTabStoreError } from './editor-tab-store.js';

export type EditorTabHandlerResponse =
  | EditorTabServerMessage
  | Extract<AgencyServerMessage, { type: 'agency.error' }>;

export interface EditorTabHandlerContext {
  adapter: EditorTabAdapter;
  publish?: (message: EditorTabServerMessage) => void;
}

export async function handleEditorTabMessage(
  raw: unknown,
  context: EditorTabHandlerContext,
): Promise<EditorTabHandlerResponse | null> {
  const message = parseEditorTabClientMessage(raw);
  if (!message) return null;

  const requestId = message.requestId;

  try {
    switch (message.type) {
      case 'agency.editorTab.open': {
        const tab = await context.adapter.createTab({
          workspaceId: message.workspaceId,
          filePath: message.filePath,
          title: message.title,
          order: message.order,
          select: message.select,
          launchId: message.launchId,
          targetPaneId: message.targetPaneId,
        });
        context.publish?.({
          type: 'agency.editorTab.changed',
          change: 'created',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.editorTab.opened',
          requestId,
          tab,
        };
      }

      case 'agency.editorTab.select': {
        const tab = await context.adapter.selectTab(message.workspaceId, message.tabId);
        context.publish?.({
          type: 'agency.editorTab.changed',
          change: 'updated',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.editorTab.updated',
          requestId,
          tab,
        };
      }

      case 'agency.editorTab.rename': {
        const tab = await context.adapter.renameTab(message.workspaceId, message.tabId, message.title);
        context.publish?.({
          type: 'agency.editorTab.changed',
          change: 'updated',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.editorTab.updated',
          requestId,
          tab,
        };
      }

      case 'agency.editorTab.close': {
        const tab = await context.adapter.closeTab(message.workspaceId, message.tabId);
        context.publish?.({
          type: 'agency.editorTab.changed',
          change: 'closed',
          workspaceId: message.workspaceId,
          tab,
        });
        return {
          type: 'agency.editorTab.closed',
          requestId,
          tab,
        };
      }

      case 'agency.editorTabs.list': {
        const tabs = context.adapter.listTabs(message.workspaceId);
        return {
          type: 'agency.editorTabs.snapshot',
          requestId,
          tabs,
        };
      }

      default:
        return null;
    }
  } catch (error) {
    if (error instanceof EditorTabStoreError) {
      return {
        type: 'agency.error',
        requestId,
        code: error.code,
        message: error.message,
        ...('workspaceId' in message && message.workspaceId ? { workspaceId: message.workspaceId } : {}),
        ...('tabId' in message && message.tabId ? { tabId: message.tabId } : {}),
      };
    }
    return {
      type: 'agency.error',
      requestId,
      code: 'internal-error',
      message: error instanceof Error ? error.message : 'Unknown editor tab error',
      ...('workspaceId' in message && message.workspaceId ? { workspaceId: message.workspaceId } : {}),
    };
  }
}
