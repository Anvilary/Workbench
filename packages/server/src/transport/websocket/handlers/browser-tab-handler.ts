/**
 * Browser tabs of a workspace.
 */

import type { ClientMessage } from '@anvilary/workbench-shared';
import type { HandlerContext } from '../handler-context.js';

export const browserTabMessageTypes = [
  'agency.webTab.create',
  'agency.webTab.select',
  'agency.webTab.navigate',
  'agency.webTab.rename',
  'agency.webTab.order',
  'agency.webTab.close',
  'agency.webTabs.list',
] as const;

type BrowserTabMessage = Extract<ClientMessage, { type: (typeof browserTabMessageTypes)[number] }>;

export async function handleBrowserTabMessage(
  message: BrowserTabMessage,
  ctx: HandlerContext<'agencyActivityManager' | 'agencyBrowserTabs' | 'send' | 'socket' | 'tabCoordinator'>,
): Promise<void> {
  const { agencyActivityManager, agencyBrowserTabs, send, socket, tabCoordinator } = ctx;
  switch (message.type) {
    case 'agency.webTab.create':
    case 'agency.webTab.select':
    case 'agency.webTab.navigate':
    case 'agency.webTab.rename':
    case 'agency.webTab.order':
    case 'agency.webTab.close':
    case 'agency.webTabs.list': {
      const response = await tabCoordinator.webRequest(message);
      for (const tab of agencyBrowserTabs.listTabs()) {
        await agencyActivityManager.ensureTab({ workspaceId: tab.workspaceId, tabId: tab.id, source: 'browser' });
      }
      if (message.type === 'agency.webTab.close' && response?.type === 'agency.webTab.closed') {
        await agencyActivityManager.closeTab(message.workspaceId, message.tabId);
      }
      if (response) send(socket, response);
      break;
    }
  }
}
