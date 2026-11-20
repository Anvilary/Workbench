/**
 * Session history: reindexing, archiving, continuing a session in another agent and global search.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { deliverWhenReady, prefillReasonFor } from '../../../features/composer/deliver-when-ready.js';
import { HANDOFF_DELIVERY_TIMEOUT_MS, continueSession } from '../../../features/history/handoff.js';
import { VaultError } from '../../../features/vault/service.js';
import { debugLog } from '../../../shared/debug.js';
import type { HandlerContext } from '../handler-context.js';

export const historyMessageTypes = [
  'session.archive',
  'index.refresh',
  'session.continue',
  'search.global',
  'search.cancel',
] as const;

type HistoryMessage = Extract<ClientMessage, { type: (typeof historyMessageTypes)[number] }>;

export async function handleHistoryMessage(
  message: HistoryMessage,
  ctx: HandlerContext<'archived' | 'continueDeps' | 'deliverDeps' | 'globalSearch' | 'index' | 'registry' | 'send' | 'sendError' | 'sendVaultError' | 'socket' | 'vault'>,
): Promise<void> {
  const { archived, continueDeps, deliverDeps, globalSearch, index, registry, send, sendError, sendVaultError, socket, vault } = ctx;
  switch (message.type) {
    /*
      Esconder de la barra lateral, o volver a mostrar. No borra nada: el
      `.jsonl` es de la CLI y de `~/.claude/` solo leemos (CLAUDE.md 2.1).

      Una sesion con pestana abierta no se archiva. Esconder de la lista lo
      que se esta usando deja al usuario sin la fila que explica la pestana
      que tiene delante, y no resuelve nada: lo que estorba es el historial
      viejo. Restaurar si se permite siempre — devolver algo a la vista
      nunca esconde nada.
    */
    case 'session.archive': {
      const open = new Set(
        registry.list().map((terminal) => terminal.sessionId).filter((id) => id.length > 0),
      );
      const targets = message.archived
        ? message.sessionIds.filter((id) => !open.has(id))
        : message.sessionIds;

      if (archived.set(targets, message.archived)) index.refresh();
      if (message.archived && targets.length < message.sessionIds.length) {
        sendError(
          socket,
          'archive-failed',
          serverText('archiveOpenTab'),
        );
      }
      break;
    }
    case 'index.refresh':
      void index.scan();
      // ⟳ tambien relee la copia: lo que escribio un importador aparece sin reiniciar.
      void vault.reload().catch((error: unknown) => sendVaultError(socket, error));
      break;
    /*
      Continuar una conversacion con otra CLI (hito 29).

      No viaja ninguna ruta ni ningun texto: la sesion se busca en el indice
      por `(agent, sessionId)`. `continueSession` abre la pestana y guarda el
      transcript; aca se contesta y se entrega. La pestana llega con
      `terminal.opened` y el mismo `requestId`, que es lo que la activa en
      la ventana que la pidio; despues `session.continued`, con lo que dice
      el aviso encima del cuadro.

      La entrega va en segundo plano. Si no se manda sola —la CLI no avisa
      cuando esta lista, o no llego a estarlo—, el mensaje queda en el
      cuadro de esa pestana, y lo manda el usuario. Nunca las dos cosas.
    */
    case 'session.continue': {
      if (message.target === null) {
        sendError(
          socket,
          'agent-unsupported',
          serverText('agentUnknown'),
          message.unsupportedAgent,
          message.requestId,
        );
        break;
      }
      const { requestId, target } = message;
      void (async () => {
        let outcome;
        try {
          outcome = await continueSession(continueDeps, {
            agent: message.agent,
            sessionId: message.sessionId,
            target,
            ...(message.label !== undefined ? { label: message.label } : {}),
          });
        } catch (error) {
          sendError(
            socket,
            'continue-failed',
            serverText('continueFailed'),
            error instanceof Error ? error.message : String(error),
            requestId,
          );
          return;
        }
        if (!outcome.ok) {
          sendError(socket, outcome.code, outcome.text, outcome.detail, requestId);
          return;
        }

        const { terminalId } = outcome.descriptor;
        send(socket, { type: 'terminal.opened', requestId, terminal: outcome.descriptor });
        send(socket, { type: 'session.continued', requestId, ...outcome.continued });
        if (outcome.continued.delivery === 'prefilled') {
          send(socket, { type: 'composer.prefill', terminalId, text: outcome.message, reason: 'no-delivery' });
          return;
        }

        const delivered = await deliverWhenReady(deliverDeps, {
          terminalId,
          text: outcome.message,
          images: [],
          timeoutMs: HANDOFF_DELIVERY_TIMEOUT_MS,
          // Sin avisos por pieza: si no entra, el mensaje vuelve al cuadro y eso ya lo dice.
          write: (piece) => registry.write(terminalId, piece),
        });
        const reason = prefillReasonFor(delivered);
        if (reason !== null) {
          debugLog('continue', `not sent on its own to ${terminalId.slice(0, 8)}: ${delivered.kind}`);
          send(socket, { type: 'composer.prefill', terminalId, text: outcome.message, reason });
        }
      })();
      break;
    }
    /*
      Buscar en las conversaciones de la copia propia (hito 29). Solo viaja
      el texto: donde se busca lo decide el catalogo. La respuesta es solo
      para este socket, y una busqueda que otra reemplazo no contesta.
      Recorre todas las sesiones y va mandando lo que encuentra
      (`search.progress`) hasta el resultado final.
    */
    case 'search.global': {
      const { searchId, query, includeArchived } = message;
      void globalSearch
        .run(
          (signal) =>
            vault.search(query, {
              includeArchived,
              signal,
              onProgress: (progress) => {
                if (!signal.aborted) send(socket, { type: 'search.progress', searchId, progress });
              },
            }),
          searchId,
        )
        .then((result) => {
          if (result !== null) send(socket, { type: 'search.results', searchId, result });
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          sendError(
            socket,
            'search-failed',
            error instanceof VaultError ? error.text : serverText('searchFailed'),
            detail,
            searchId,
          );
        });
      break;
    }
    // Se cerro el buscador: solo esa busqueda, si todavia es la que corre.
    case 'search.cancel':
      globalSearch.cancel(message.searchId);
      break;
  }
}
