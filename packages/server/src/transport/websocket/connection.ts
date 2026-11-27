/**
 * One accepted WebSocket connection.
 *
 * This is the single transport boundary for a client message: it decodes and
 * validates it, refuses what a remote device may not do, waits for the
 * workspace state when a message needs it, routes it to the owning handler,
 * serializes any failure, preserves wire order for commands that touch the same
 * terminal, applies the per-terminal backlog limits and releases everything the
 * socket held when it closes. Handlers contain no authorization or error
 * serialization of their own.
 */

import {
  asRecord,
  parseClientMessage,
  parseJson,
  serverText,
  type ServerText,
  type TerminalId,
} from '@anvilary/workbench-shared';
import type { WebSocket } from 'ws';
import { BrowserTabStoreError } from '../../features/browser/browser-tab-store.js';
import { cliFolders } from '../../features/files/cli-folders.js';
import { DirectoryPickers } from '../../features/files/directory-picker.js';
import { InvalidPathError } from '../../features/files/path-guard.js';
import { GlobalSearchSlot } from '../../features/history/global-search.js';
import { MemoryBridgeError } from '../../features/memory/memory-bridge.js';
import { UnknownTerminalError } from '../../features/memory/memory-hub.js';
import { NotesError } from '../../features/notes/notes-store.js';
import { remoteRefusal } from '../../features/remote-access/remote-access.js';
import { AgencyRuntimeError } from '../../features/sessions/session-runtime.js';
import { runWithTerminalLaunchOrigin } from '../../features/terminals/graphical-session-env.js';
import type { Credential } from '../../security/request-guards.js';
import { debugLog } from '../../shared/debug.js';
import { dispatchClientMessage } from './dispatch.js';
import type { ErrorReporters } from './error-reporters.js';
import type { ConnectionScope, FullContext } from './handler-context.js';
import { sendInitialSnapshot } from './initial-snapshot.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalCommands } from './terminal-commands.js';
import type { TerminalHistoryAccess } from './terminal-history-access.js';
import { createTerminalStream } from './terminal-stream.js';

export interface ConnectionDeps {
  services: WorkbenchServices;
  hub: SocketHub;
  history: TerminalHistoryAccess;
  commands: TerminalCommands;
  reporters: ErrorReporters;
}

export function acceptConnection(socket: WebSocket, credential: Credential, deps: ConnectionDeps): void {
  const { services, hub, history, commands, reporters } = deps;
  const { registry, remote, planLimits, conversations, repos, memory, agents, tabReady, classicLifecycle, agencyWorkspaceStore } = services;
  const { send, sendError, clients, remoteSockets, phonePairing } = hub;
  const { historyBindings } = history;

  clients.add(socket);

  // Con que entro esta ventana decide que se le atiende (`remoteRefusal`).
  const deviceId = credential.kind === 'device' ? credential.deviceId : null;

  if (deviceId !== null) {
    remoteSockets.set(socket, deviceId);
    remote.noteConnected(deviceId);
  }

  const stream = createTerminalStream({
    socket,
    registry,
    send,
    historyAccessReason: history.historyAccessReason,
  });
  const { attachedTerminals, historyReads, backpressure, revokeTerminalAttachment, replayTerminal } = stream;

  // Conversaciones y repos que sigue **este** socket. Se sueltan al cerrarse,
  // para que el seguimiento se apague cuando no queda nadie mirando.
  const subscriptions = new Set<TerminalId>();

  const gitSubscriptions = new Set<TerminalId>();

  const memorySubscriptions = new Set<TerminalId>();

  historyBindings.set(socket, stream.historyBinding);

  /*
    Los selectores de carpeta son **de este socket** y mueren con el. No hay
    nada que sobreviva a la conexion que los pidio: sin `pickerId` vivo, el
    servidor no lista nada.
  */
  const pickers = new DirectoryPickers(agents.protectedDirs());

  /*
    Las mismas carpetas, para Archivos (Hito 46): el arbol no las lista y nada
    de adentro se lee ni se escribe, aunque caigan dentro del proyecto.
  */
  const folders = cliFolders(agents.protectedDirs());

  /** La busqueda global en curso de este socket: una nueva o el cierre la cancelan. */
  const globalSearch = new GlobalSearchSlot();

  /**
   * `cwd` de una pestana viva.
   *
   * Toda ruta que llega del cliente se resuelve contra esto. Si la pestana ya
   * no existe, no hay `cwd` contra el cual validar y la peticion se rechaza:
   * nunca se cae a un directorio por defecto.
   */
  const cwdOf = (terminalId: TerminalId): string | null => {
    const descriptor = registry.get(terminalId);
    if (descriptor !== null && descriptor.cwd.length > 0) return descriptor.cwd;
    const ws = agencyWorkspaceStore.getWorkspace(terminalId as import('@anvilary/workbench-shared').WorkspaceId);
    if (ws && ws.status === 'active') return ws.cwd;
    return null;
  };

  const sendPathError = (error: unknown, fallback: ServerText, requestId?: string): void => {
    if (error instanceof InvalidPathError) {
      sendError(socket, 'invalid-path', error.text, undefined, requestId);
      return;
    }
    sendError(
      socket,
      'read-failed',
      fallback,
      error instanceof Error ? error.message : String(error),
      requestId,
    );
  };

  const sendNotesError = (error: unknown): void => {
    if (error instanceof NotesError) {
      sendError(socket, 'notes-failed', error.text);
      return;
    }
    sendError(
      socket,
      'internal',
      serverText('noteSaveFailed'),
      error instanceof Error ? error.message : String(error),
    );
  };

  /**
   * Errores de `memory.*`. Lo que rechaza el guardia de rutas es
   * `invalid-path`; lo demas, `memory-failed` con su mensaje, que el puente
   * escribe para mostrarse tal cual.
   */
  const sendMemoryError = (error: unknown, requestId: string | undefined): void => {
    if (error instanceof UnknownTerminalError) {
      sendError(socket, 'unknown-terminal', serverText('terminalGone'), undefined, requestId);
      return;
    }
    if (error instanceof InvalidPathError) {
      sendError(socket, 'invalid-path', error.text, undefined, requestId);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    sendError(
      socket,
      'memory-failed',
      error instanceof MemoryBridgeError ? error.text : serverText('operationFailed', { detail }),
      detail,
      requestId,
    );
  };

  sendInitialSnapshot({ socket, deviceId, services, hub, commands });

  const connection: ConnectionScope = {
    socket,
    deviceId,
    attachedTerminals,
    historyReads,
    backpressure,
    revokeTerminalAttachment,
    replayTerminal,
    subscriptions,
    gitSubscriptions,
    memorySubscriptions,
    pickers,
    folders,
    globalSearch,
    cwdOf,
    sendPathError,
    sendNotesError,
    sendMemoryError,
  };
  const ctx: FullContext = {
    ...services,
    ...hub,
    ...commands,
    ...reporters,
    closingTerminals: history.closingTerminals,
    historyAccessReason: history.historyAccessReason,
    getHistoryStore: history.getHistoryStore,
    retireHistoryStore: history.retireHistoryStore,
    ...connection,
  };

  const handleClientMessage = async (
    raw: Buffer | ArrayBuffer | Buffer[],
    parsedMessage: ReturnType<typeof parseClientMessage>,
  ): Promise<void> => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as Buffer).toString('utf8');

    const message = parsedMessage;
    if (message === null) {
      const rawObj = asRecord(parseJson(text));
      if (rawObj && typeof rawObj['type'] === 'string' && rawObj['type'].startsWith('agency.') && typeof rawObj['requestId'] === 'string') {
        const requestId = rawObj['requestId'].slice(0, 128);
        send(socket, { type: 'agency.error', requestId, code: 'invalid-request', message: 'Invalid Agency request' });
        return;
      }
      debugLog('socket', `message rejected: ${text.slice(0, 160)}`);
      sendError(socket, 'bad-message', serverText('badMessage'));
      return;
    }
    if (message.type !== 'input') debugLog('socket', `received ${message.type}`);

    if (classicLifecycle && (
      message.type.startsWith('index.') ||
      message.type.startsWith('vault.') ||
      message.type.startsWith('session.')
    )) {
      void classicLifecycle.ensureStarted();
    }

    // Antes de atender nada: lo que a un equipo remoto no se le atiende (hito 37).
    const refusal = remoteRefusal(message.type, deviceId !== null);
    if (refusal !== null) {
      sendError(socket, 'remote-refused', refusal, undefined, 'requestId' in message ? message.requestId : undefined);
      return;
    }

    try {
      if (message.type.startsWith('agency.')) await tabReady;
      await runWithTerminalLaunchOrigin(deviceId !== null, () => dispatchClientMessage(message, ctx));
    } catch (error) {
      if (message.type.startsWith('agency.') && 'requestId' in message) {
        send(socket, { type: 'agency.error', requestId: message.requestId!,
          code: error instanceof AgencyRuntimeError || error instanceof BrowserTabStoreError ? error.code : 'internal-error',
          message: error instanceof Error ? error.message : String(error) });
      } else console.error('[socket] request failed:', String(error));
    }
  };

  // Preserve wire order for commands affecting the same terminal.
  // Different terminals and sockets retain independent queues.
  const terminalCommandQueues = new Map<
    TerminalId,
    { tail: Promise<void>; count: number; bytes: number }
  >();

  const MAX_TERMINAL_COMMANDS = 1024;

  const MAX_TERMINAL_QUEUE_BYTES = 2 * 1024 * 1024;

  socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as Buffer).toString('utf8');

    const message = parseClientMessage(text);

    if (
      message === null ||
      !(
        message.type === 'input' ||
        message.type === 'terminal.attach' ||
        message.type === 'terminal.detach' ||
        message.type === 'terminal.close' ||
        message.type === 'terminal.history.page'
      )
    ) {
      void handleClientMessage(raw, message).catch(error => {
        console.error('[socket] Message handler failed:', String(error));
      });
      return;
    }

    const terminalId = message.terminalId;
    let queue = terminalCommandQueues.get(terminalId);

    if (!queue) {
      queue = { tail: Promise.resolve(), count: 0, bytes: 0 };
      terminalCommandQueues.set(terminalId, queue);
    }

    const size = Buffer.byteLength(text);

    if (
      queue.count >= MAX_TERMINAL_COMMANDS ||
      queue.bytes + size > MAX_TERMINAL_QUEUE_BYTES
    ) {
      socket.close(1009, 'Terminal command backlog exceeded');
      return;
    }

    queue.count += 1;
    queue.bytes += size;

    const currentQueue = queue;

    currentQueue.tail = currentQueue.tail
      .catch(() => undefined)
      .then(async () => {
        if (socket.readyState !== socket.OPEN) return;

        if (message.type === 'terminal.history.page') {
          // Disk I/O cannot block revocation. The read captures the current
          // lease synchronously and rechecks its identity before delivery.
          void handleClientMessage(raw, message).catch(error => {
            console.error('[socket] Async terminal command failed:', String(error));
          });
          return;
        }

        await handleClientMessage(raw, message);
      })
      .catch(error => {
        console.error('[socket] Terminal command failed:', String(error));
      })
      .finally(() => {
        currentQueue.count -= 1;
        currentQueue.bytes -= size;

        if (
          currentQueue.count === 0 &&
          terminalCommandQueues.get(terminalId) === currentQueue
        ) {
          terminalCommandQueues.delete(terminalId);
        }
      });
  });

  let tornDown = false;
  const teardown = (): void => {
    // Se quitan los oyentes de este socket. Las terminales siguen vivas.
    // `close` y `error` pueden llegar los dos: la ventana se suelta del plan una sola vez.
    if (!tornDown) {
      tornDown = true;
      planLimits.release();
    }
    stream.revokeAll();
    terminalCommandQueues.clear();
    stream.disposeOutput();
    if (phonePairing.owner === socket) {
      phonePairing.owner = null;
      remote.cancelPhonePairing();
    }
    globalSearch.cancel();
    pickers.closeAll();
    stream.finish();
    historyBindings.delete(socket);
    for (const terminalId of subscriptions) conversations.unsubscribe(terminalId);
    subscriptions.clear();
    for (const terminalId of gitSubscriptions) repos.unsubscribe(terminalId);
    gitSubscriptions.clear();
    for (const terminalId of memorySubscriptions) memory.unsubscribe(terminalId);
    memorySubscriptions.clear();
    clients.delete(socket);
    // `close` y `error` pueden llegar los dos: la baja se anota una sola vez.
    if (deviceId !== null && remoteSockets.delete(socket)) remote.noteDisconnected(deviceId);
  };

  socket.on('close', teardown);
  socket.on('error', teardown);
}
