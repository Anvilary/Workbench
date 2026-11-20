/**
 * Live agent and shell sessions, their tabs and model selection.
 */

import type { AgencyErrorCode } from '@agent-workbench/shared';
import type { ClientMessage } from '@agent-workbench/shared';
import { AgencyRuntimeError } from '../../../features/sessions/session-runtime.js';
import type { HandlerContext } from '../handler-context.js';

export const sessionMessageTypes = [
  'agency.sessions.list',
  'agency.sessions.history',
  'agency.session.create',
  'agency.tab.rename',
  'agency.tab.action',
  'agency.tabs.order',
  'agency.session.selection.set',
] as const;

type SessionMessage = Extract<ClientMessage, { type: (typeof sessionMessageTypes)[number] }>;

export async function handleSessionMessage(
  message: SessionMessage,
  ctx: HandlerContext<'agencyActivityManager' | 'agencyRuntime' | 'send' | 'socket' | 'tabCoordinator'>,
): Promise<void> {
  const { agencyActivityManager, agencyRuntime, send, socket, tabCoordinator } = ctx;
  switch (message.type) {
    case 'agency.sessions.list': {
      const sessions = agencyRuntime.liveList(message.workspaceId);
      send(socket, { type: 'agency.sessions.snapshot', requestId: message.requestId, sessions,
        ...(message.workspaceId !== undefined ? { workspaceId: message.workspaceId } : {}) });
      break;
    }
    case 'agency.sessions.history': {
      const page = agencyRuntime.history({
        ...(message.workspaceId !== undefined ? { workspaceId: message.workspaceId } : {}),
        offset: message.offset ?? 0, limit: message.limit ?? 50,
      });
      send(socket, { type: 'agency.sessions.history', requestId: message.requestId, sessions: page.sessions, total: page.total, offset: message.offset ?? 0 });
      break;
    }
    case 'agency.session.create': {
      try {
        const session = await tabCoordinator.createNative(message);
        send(socket, { type: 'agency.session.created', requestId: message.requestId, session });
      } catch (error) {
        let code: AgencyErrorCode = 'internal-error';
        let msg = 'Failed to create session';
        if (error instanceof AgencyRuntimeError) {
          code = error.code;
          msg = error.message;
        } else if (error instanceof Error) {
          msg = error.message;
        }
        send(socket, { type: 'agency.error', requestId: message.requestId, code, message: msg });
      }
      break;
    }
    case 'agency.tab.rename':
    case 'agency.tab.action':
    case 'agency.tabs.order': {
      try {
        await tabCoordinator.nativeAction(message);
        if (message.type === 'agency.tab.action' && message.action === 'close') {
          await agencyActivityManager.closeTab(message.workspaceId, message.tabId);
        }
        send(socket, { type: 'agency.sessions.snapshot', requestId: message.requestId, sessions: agencyRuntime.liveList() });
      } catch (error) {
        send(socket, { type: 'agency.error', requestId: message.requestId, code: error instanceof AgencyRuntimeError ? error.code : 'internal-error', message: error instanceof Error ? error.message : String(error) });
      }
      break;
    }
    case 'agency.session.selection.set': {
      try {
        const session = await agencyRuntime.setSelection(message.sessionId, message.model, message.effort);
        send(socket, { type: 'agency.session.selection', requestId: message.requestId, session });
      } catch (error) {
        let code: AgencyErrorCode = 'internal-error';
        let msg = 'Failed to set selection';
        if (error instanceof AgencyRuntimeError) {
          code = error.code;
          msg = error.message;
        } else if (error instanceof Error) {
          msg = error.message;
        }
        send(socket, { type: 'agency.error', requestId: message.requestId, code, message: msg });
      }
      break;
    }
  }
}
