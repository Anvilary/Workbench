/**
 * Following the transcript of a terminal's session, its plans and images.
 */

import { serverText, type ClientMessage } from '@anvilary/workbench-shared';
import type { HandlerContext } from '../handler-context.js';

export const conversationMessageTypes = [
  'conversation.subscribe',
  'plans.read',
  'conversation.image',
  'conversation.unsubscribe',
  'conversation.loadMore',
] as const;

type ConversationMessage = Extract<ClientMessage, { type: (typeof conversationMessageTypes)[number] }>;

export async function handleConversationMessage(
  message: ConversationMessage,
  ctx: HandlerContext<'conversations' | 'defaultsFor' | 'send' | 'sendError' | 'socket' | 'subscriptions'>,
): Promise<void> {
  const { conversations, defaultsFor, send, sendError, socket, subscriptions } = ctx;
  switch (message.type) {
    case 'conversation.subscribe':
      void (async () => {
        // Una segunda suscripcion del mismo socket contaria dos veces en el
        // refcount y el seguimiento no se apagaria nunca.
        if (subscriptions.has(message.terminalId)) {
          conversations.unsubscribe(message.terminalId);
          subscriptions.delete(message.terminalId);
        }

        const snapshot = await conversations.subscribe(message.terminalId);
        if (snapshot === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        subscriptions.add(message.terminalId);
        send(socket, {
          type: 'conversation.reset',
          terminalId: message.terminalId,
          sessionId: snapshot.sessionId,
          state: snapshot.state,
          events: snapshot.events,
          hasMore: snapshot.hasMore,
          usage: snapshot.usage,
          permissionMode: snapshot.permissionMode,
          defaults: await defaultsFor(message.terminalId, snapshot.usage.lastModel),
          waitingFor: snapshot.waitingFor,
          openToolCall: conversations.isToolCallOpen(message.terminalId),
          subagents: conversations.getSubagents(message.terminalId),
          queue: conversations.getQueue(message.terminalId),
          liveQuestion: conversations.getLiveQuestion(message.terminalId),
        });
        // Los planes van en su propio mensaje y no dentro del reset: la
        // conversacion se rehace muchas veces —cada `conversation.reset`—
        // y los planes casi nunca cambian.
        if (snapshot.plans.length > 0) {
          send(socket, {
            type: 'conversation.plans',
            terminalId: message.terminalId,
            plans: snapshot.plans,
          });
        }
      })();
      break;
    /*
      El contenido de un plan, al abrirlo en su solapa. El servidor
      comprueba que sea un plan **de esta conversacion** antes de leerlo.
    */
    case 'plans.read':
      void (async () => {
        const plan = await conversations
          .readPlan(message.terminalId, message.fileName)
          .catch(() => null);
        if (plan === null) {
          sendError(socket, 'read-failed', serverText('planReadFailed'));
          return;
        }
        send(socket, { type: 'plans.content', terminalId: message.terminalId, plan });
      })();
      break;
    /*
      Una imagen del historial, pedida al entrar en pantalla. Es una lectura
      completa del archivo de sesion, asi que va por demanda y de a una.
    */
    case 'conversation.image':
      void (async () => {
        const { terminalId, eventId, index, source } = message;
        const image = await conversations
          .readImage(terminalId, eventId, index, source)
          .catch(() => null);
        send(socket, {
          type: 'conversation.imageData',
          terminalId,
          eventId,
          index,
          source,
          mediaType: image?.mediaType ?? 'image/png',
          data: image?.data ?? null,
        });
      })();
      break;
    case 'conversation.unsubscribe':
      if (subscriptions.delete(message.terminalId)) {
        conversations.unsubscribe(message.terminalId);
      }
      break;
    case 'conversation.loadMore': {
      const page = conversations.getPage(
        message.terminalId,
        message.beforeEventId,
        message.limit,
      );
      if (page === null) {
        sendError(socket, 'unknown-terminal', serverText('conversationNotFollowed'));
        break;
      }
      send(socket, {
        type: 'conversation.page',
        terminalId: message.terminalId,
        events: page.events,
        hasMore: page.hasMore,
      });
      break;
    }
  }
}
