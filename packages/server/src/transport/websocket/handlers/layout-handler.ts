/**
 * Workspace pane layouts.
 */

import type { ClientMessage } from '@anvilary/workbench-shared';
import { evaluateLayoutSave } from '../../../features/workspaces/layout-validation.js';
import type { HandlerContext } from '../handler-context.js';

export const layoutMessageTypes = [
  'agency.layout.save',
  'agency.layout.get',
] as const;

type LayoutMessage = Extract<ClientMessage, { type: (typeof layoutMessageTypes)[number] }>;

export async function handleLayoutMessage(
  message: LayoutMessage,
  ctx: HandlerContext<'agencyLayoutStore' | 'agencyWorkspaceStore' | 'broadcast' | 'send' | 'socket' | 'tabCoordinator'>,
): Promise<void> {
  const { agencyLayoutStore, agencyWorkspaceStore, broadcast, send, socket, tabCoordinator } = ctx;
  switch (message.type) {
    case 'agency.layout.save': {
      await tabCoordinator.mutations.runExclusive(message.workspaceId, async () => {
        if (!agencyWorkspaceStore.getWorkspace(message.workspaceId)) {
          send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Workspace not found' });
          return;
        }
        const openTabIds = tabCoordinator.listOpenTabIds(message.workspaceId, { includeClosing: true });
        const decision = evaluateLayoutSave(message.workspaceId, message.layout, openTabIds);
        if (!decision.ok) {
          send(socket, { type: 'agency.error', requestId: message.requestId, code: 'invalid-request', message: decision.message });
          return;
        }
        // Persist the validated layout only. Session records and their ids stay as they are.
        await agencyLayoutStore.save(decision.layout);
        send(socket, { type: 'agency.layout.saved', requestId: message.requestId, workspaceId: message.workspaceId });
        broadcast({ type: 'agency.layout.changed', workspaceId: message.workspaceId, layout: decision.layout });
      });
      break;
    }
    case 'agency.layout.get': {
      const layout = tabCoordinator.reconcileLayout(message.workspaceId) ?? agencyLayoutStore.get(message.workspaceId);
      send(socket, {
        type: 'agency.layouts.snapshot',
        requestId: message.requestId,
        layouts: layout ? [layout] : [],
      });
      break;
    }
  }
}
