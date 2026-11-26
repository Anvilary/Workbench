/**
 * Terminal lifecycle, attachment, history paging, raw input and tab order.
 */

import { serverText, type ClientMessage } from '@anvilary/workbench-shared';
import { CLEAR_EDITOR } from '../../../features/composer/pty-input.js';
import { TerminalOpenError } from '../../../features/terminals/terminal-registry.js';
import type { HandlerContext } from '../handler-context.js';

export const terminalMessageTypes = [
  'input',
  'resize',
  'terminal.open',
  'terminal.wake',
  'terminal.close',
  'terminal.attach',
  'terminal.detach',
  'terminal.history.page',
  'terminal.rename',
  'tabs.reorder',
] as const;

type TerminalMessage = Extract<ClientMessage, { type: (typeof terminalMessageTypes)[number] }>;

export async function handleTerminalMessage(
  message: TerminalMessage,
  ctx: HandlerContext<'agencyRuntime' | 'attachedTerminals' | 'backpressure' | 'closingTerminals' | 'dropTab' | 'getHistoryStore' | 'gitSubscriptions' | 'historyAccessReason' | 'historyReads' | 'memorySubscriptions' | 'queuedSubmits' | 'registry' | 'replayTerminal' | 'retireHistoryStore' | 'revokeTerminalAttachment' | 'send' | 'sendError' | 'socket' | 'subscriptions'>,
): Promise<void> {
  const { agencyRuntime, attachedTerminals, backpressure, closingTerminals, dropTab, getHistoryStore, gitSubscriptions, historyAccessReason, historyReads, memorySubscriptions, queuedSubmits, registry, replayTerminal, retireHistoryStore, revokeTerminalAttachment, send, sendError, socket, subscriptions } = ctx;
  switch (message.type) {
    case 'input':
      // Sin filtrar: Ctrl+V, Alt+V, Esc Esc y compania tienen que llegar
      // intactos o la CLI pierde funcionalidad.
      //
      // A una pestana sin proceso no se le escribe, y **no se avisa**: la
      // terminal manda todo lo que produce xterm —una tecla de mas justo al
      // cerrarse la CLI, o algo que la terminal contesta sola— y el cartel
      // de error quedaba arriba sin tener que ver con nada que el usuario
      // hubiera pedido. Que no hay CLI ya lo dicen el nombre tachado, el
      // punto y "Abrir CLI". El aviso sigue para lo que manda el cuadro.
      if (socket.readyState !== socket.OPEN || !attachedTerminals.has(message.terminalId)) break;
      if (historyAccessReason(message.terminalId) !== null) {
        revokeTerminalAttachment(message.terminalId);
        break;
      }
      if (!registry.write(message.terminalId, message.data) && registry.get(message.terminalId) === null) {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'));
      }
      // Un Ctrl+C tecleado cuenta para la separacion de la tecla de vaciar (hito 43).
      if (message.data.includes(CLEAR_EDITOR)) queuedSubmits.noteClearKey(message.terminalId, Date.now());
      break;
    case 'resize':
      registry.resize(message.terminalId, message.cols, message.rows);
      break;
    case 'terminal.open':
      /*
        Una CLI que este lado no conoce no se reemplaza por la de por
        defecto: abrir otra que la pedida es peor que no abrir nada.
      */
      if (message.unsupportedAgent !== undefined && message.kind !== 'shell') {
        sendError(
          socket,
          'agent-unsupported',
          serverText('agentUnknown'),
          message.unsupportedAgent,
          message.requestId,
        );
        break;
      }
      void (async () => {
        try {
          const descriptor = await registry.open({
            cwd: message.cwd,
            ...(message.kind !== undefined ? { kind: message.kind } : {}),
            ...(message.agent !== undefined ? { agent: message.agent } : {}),
            ...(message.resumeSessionId !== undefined
              ? { resumeSessionId: message.resumeSessionId }
              : {}),
            ...(message.label !== undefined ? { label: message.label } : {}),
            ...(message.historyId !== undefined ? { historyId: message.historyId } : {}),
          });
          // Early PTY output may already have created this store. Reuse it.
          getHistoryStore(descriptor.terminalId);
          send(socket, {
            type: 'terminal.opened',
            requestId: message.requestId,
            terminal: descriptor,
          });
        } catch (error) {
          if (error instanceof TerminalOpenError) {
            sendError(socket, error.code, error.text, error.detail, message.requestId);
          } else {
            sendError(
              socket,
              'internal',
              serverText('tabOpenFailed'),
              error instanceof Error ? error.message : String(error),
              message.requestId,
            );
          }
        }
      })();
      break;
    /*
      Una pestana dormida no tiene proceso: existe, se lee y no gasta nada.
      Esto es lo que pasa cuando el usuario quiere escribirle al agente.
    */
    case 'terminal.wake': {
      /*
        Se mira antes de esperar. Con un lanzamiento que tarda —el `serve` de
        OpenCode, hito 29— el usuario puede cerrar la pestana mientras se
        despierta, y `wake` da null: la cerro el, y un cartel "La terminal ya
        no existe" sobre algo que acaba de cerrar a proposito es ruido.
        Medido en la prueba en vivo del hito.
      */
      const existed = registry.has(message.terminalId);
      void (async () => {
        try {
          const descriptor = await registry.wake(message.terminalId);
          if (descriptor === null && !existed) {
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          }
        } catch (error) {
          if (error instanceof TerminalOpenError) {
            sendError(socket, error.code, error.text, error.detail);
          } else {
            sendError(
              socket,
              'internal',
              serverText('cliOpenFailed'),
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      break;
    }
    case 'terminal.close':
      revokeTerminalAttachment(message.terminalId);
      closingTerminals.add(message.terminalId);
      void (async () => {
        const session = agencyRuntime.list().find(item => item.terminalId === message.terminalId);
        if (session) await agencyRuntime.stop(session.id);
        if (!dropTab(message.terminalId) && !session) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
        } else {
          subscriptions.delete(message.terminalId);
          attachedTerminals.delete(message.terminalId);
          backpressure.forget(message.terminalId);
          gitSubscriptions.delete(message.terminalId);
          memorySubscriptions.delete(message.terminalId);
          retireHistoryStore(message.terminalId);
        }
      })().catch(error => sendError(socket, 'unknown-terminal', serverText('terminalGone'), String(error)))
        .finally(() => closingTerminals.delete(message.terminalId));
      break;
    case 'terminal.attach': {
      const terminalId = message.terminalId;
      revokeTerminalAttachment(terminalId);
      if (socket.readyState !== socket.OPEN || historyAccessReason(terminalId) !== null) {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'));
        break;
      }

      try {
        registry.resize(terminalId, message.cols, message.rows);
      } catch {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'));
        break;
      }
      const grant = Symbol();
      attachedTerminals.set(terminalId, grant);
      const canDeliver = (): boolean =>
        socket.readyState === socket.OPEN &&
        attachedTerminals.get(terminalId) === grant &&
        historyAccessReason(terminalId) === null;

      void replayTerminal(terminalId, message.sinceOffset, canDeliver).then(replayed => {
        // Cancellation belongs to the superseding operation. Only this lease's
        // failed replay may revoke it; completion never establishes authority.
        if (replayed === false && attachedTerminals.get(terminalId) === grant) {
          revokeTerminalAttachment(terminalId);
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
        }
      }).catch(error => {
        if (attachedTerminals.get(terminalId) === grant) revokeTerminalAttachment(terminalId);
        console.error('[terminal] Attachment failed:', String(error));
      });
      break;
    }
    case 'terminal.detach':
      revokeTerminalAttachment(message.terminalId);
      break;
    /*
      El cliente pide una pagina del historial persistente de una terminal (Lane F).
    */
    case 'terminal.history.page': {
      const { terminalId, page, pageSize, direction, requestId } = message;
      const fail = (reason: string): void => send(socket, {
        type: 'terminal.history.error', terminalId, requestId, reason,
      });
      const accessReason = historyAccessReason(terminalId);
      if (accessReason !== null) { fail(accessReason); break; }
      const grant = attachedTerminals.get(terminalId);
      if (!grant) { fail('Unauthorized session history access'); break; }
      if (historyReads.has(terminalId)) { fail('History request already in progress'); break; }
      const store = getHistoryStore(terminalId);
      if (!store) { fail('History store not available'); break; }
      historyReads.add(terminalId);
      try {
        const historyPage = await store.getPage(page, pageSize ?? 1000, direction ?? 'backward');
        // Detach, reattach, close and workspace changes invalidate a pending read.
        // Checking just the terminal ID after await would revive an old grant.
        const currentReason = historyAccessReason(terminalId);
        if (currentReason !== null || attachedTerminals.get(terminalId) !== grant) {
          fail(currentReason ?? 'Unauthorized session history access');
          break;
        }
        send(socket, {
          type: 'terminal.history.data', terminalId, requestId,
          ...historyPage,
        });
      } catch {
        // Filesystem errors can contain private paths. Return a stable reason.
        fail('History read failed');
      } finally {
        historyReads.delete(terminalId);
      }
      break;
    }
    case 'terminal.rename':
      if (!registry.rename(message.terminalId, message.label)) {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'));
      }
      break;
    case 'tabs.reorder':
      registry.reorder(message.terminalIds);
      break;
  }
}
