/**
 * Shared agent memory of a terminal's project.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { UnknownTerminalError } from '../../../features/memory/memory-hub.js';
import type { HandlerContext } from '../handler-context.js';

export const memoryMessageTypes = [
  'memory.subscribe',
  'memory.unsubscribe',
  'memory.plan',
  'memory.install',
  'memory.import',
  'memory.read',
] as const;

type MemoryMessage = Extract<ClientMessage, { type: (typeof memoryMessageTypes)[number] }>;

export async function handleMemoryMessage(
  message: MemoryMessage,
  ctx: HandlerContext<'cwdOf' | 'memory' | 'memorySubscriptions' | 'send' | 'sendError' | 'sendMemoryError' | 'socket' | 'withRequestId'>,
): Promise<void> {
  const { cwdOf, memory, memorySubscriptions, send, sendError, sendMemoryError, socket, withRequestId } = ctx;
  switch (message.type) {
    /*
      Memoria compartida. El `cwd` sale del registro y todo lo que toca
      disco pasa por la cola de ese directorio en el hub. La suscripcion
      queda anotada aunque la primera lectura falle: el watcher sigue
      mirando y avisa cuando el problema se arregla.

      Cada respuesta y cada error llevan el `requestId` del pedido: es lo
      unico que le dice al panel si un fallo es suyo.
    */
    case 'memory.subscribe':
      void (async () => {
        // Una segunda suscripcion del mismo socket contaria dos veces en el
        // refcount y el watcher no se apagaria nunca.
        if (memorySubscriptions.has(message.terminalId)) {
          memory.unsubscribe(message.terminalId);
          memorySubscriptions.delete(message.terminalId);
        }
        if (cwdOf(message.terminalId) === null) {
          sendMemoryError(new UnknownTerminalError(), message.requestId);
          return;
        }
        memorySubscriptions.add(message.terminalId);
        try {
          const status = await memory.subscribe(message.terminalId);
          if (status === null) {
            memorySubscriptions.delete(message.terminalId);
            sendMemoryError(new UnknownTerminalError(), message.requestId);
            return;
          }
          send(socket, { type: 'memory.status', terminalId: message.terminalId, status });
        } catch (error) {
          sendMemoryError(error, message.requestId);
        }
      })();
      break;
    case 'memory.unsubscribe':
      if (memorySubscriptions.delete(message.terminalId)) {
        memory.unsubscribe(message.terminalId);
      }
      break;
    case 'memory.plan':
      void memory
        .plan(message.terminalId, message.options)
        .then((changes) => {
          send(
            socket,
            withRequestId(
              { type: 'memory.planned', terminalId: message.terminalId, changes },
              message.requestId,
            ),
          );
        })
        .catch((error: unknown) => sendMemoryError(error, message.requestId));
      break;
    /*
      La unica escritura de la app dentro de un proyecto. El servidor rehace
      el plan con las opciones: lo que el cliente previsualizo es
      informativo, no una orden de escritura.
    */
    case 'memory.install':
      void memory
        .install(message.terminalId, message.options)
        .then(({ applied, status }) => {
          send(
            socket,
            withRequestId(
              { type: 'memory.installed', terminalId: message.terminalId, applied },
              message.requestId,
            ),
          );
          if (status !== null) memory.publish(message.terminalId, status);
        })
        .catch((error: unknown) => sendMemoryError(error, message.requestId));
      break;
    case 'memory.import':
      void memory
        .importNative(message.terminalId)
        .then(({ copied, skipped, status }) => {
          send(
            socket,
            withRequestId(
              { type: 'memory.imported', terminalId: message.terminalId, copied, skipped },
              message.requestId,
            ),
          );
          if (status !== null) memory.publish(message.terminalId, status);
        })
        .catch((error: unknown) => sendMemoryError(error, message.requestId));
      break;
    case 'memory.read':
      void memory
        .read(message.terminalId, message.name)
        .then((note) => {
          if (note === null) {
            sendError(socket, 'memory-failed', serverText('memoryNoteGone'), undefined, message.requestId);
            return;
          }
          send(
            socket,
            withRequestId(
              { type: 'memory.content', terminalId: message.terminalId, note },
              message.requestId,
            ),
          );
        })
        .catch((error: unknown) => sendMemoryError(error, message.requestId));
      break;
  }
}
