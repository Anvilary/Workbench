/**
 * Editor tabs of a workspace.
 */

import type { ClientMessage } from '@anvilary/workbench-shared';
import type { HandlerContext } from '../handler-context.js';

export const editorTabMessageTypes = [
  'agency.editorTab.open',
  'agency.editorTab.select',
  'agency.editorTab.rename',
  'agency.editorTab.order',
  'agency.editorTab.close',
  'agency.editorTabs.list',
] as const;

type EditorTabMessage = Extract<ClientMessage, { type: (typeof editorTabMessageTypes)[number] }>;

export async function handleEditorTabMessage(
  message: EditorTabMessage,
  ctx: HandlerContext<'send' | 'socket' | 'tabCoordinator'>,
): Promise<void> {
  const { send, socket, tabCoordinator } = ctx;
  switch (message.type) {
    case 'agency.editorTab.open':
    case 'agency.editorTab.select':
    case 'agency.editorTab.rename':
    case 'agency.editorTab.order':
    case 'agency.editorTab.close':
    case 'agency.editorTabs.list': {
      const response = await tabCoordinator.editorRequest(message as import('@anvilary/workbench-shared').EditorTabClientMessage);
      if (response) send(socket, response);
      break;
    }
  }
}
