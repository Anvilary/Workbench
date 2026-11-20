/**
 * WebSocket transport.
 *
 * Ojo con el reparto de responsabilidades: este archivo NO es duenio de las
 * terminales. Solo acepta conexiones y las entrega a `connection.ts`; el
 * estado vive en los servicios y la logica de cada familia de mensajes, en su
 * handler. Si se cae un socket, lo unico que pasa es que se quitan sus oyentes
 * (CLAUDE.md 3.0).
 *
 * Authorization of the upgrade lives here and nowhere else.
 */

import { WS_PATH } from '@agent-workbench/shared';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { authorizeRequest, authorizeRequestNoAuth, type Credential } from '../../security/request-guards.js';
import { wireServerEvents } from './broadcasts.js';
import { acceptConnection } from './connection.js';
import { createErrorReporters } from './error-reporters.js';
import { createWorkbenchServices, type WorkbenchServiceOptions } from './services.js';
import { wireSessionEvents } from './session-events.js';
import { createSocketHub } from './socket-hub.js';
import { createTerminalCommands } from './terminal-commands.js';
import { createTerminalHistoryAccess } from './terminal-history-access.js';

export interface WorkbenchSocketOptions extends WorkbenchServiceOptions {
  httpServer: HttpServer;
  port: number;
  token: string;
}

export function attachWorkbenchSocket(options: WorkbenchSocketOptions): () => Promise<void> {
  const { httpServer, port, token } = options;

  const hub = createSocketHub();
  const serviceHandle = createWorkbenchServices(options, hub.broadcast);
  const { services } = serviceHandle;
  const { remote } = services;
  const history = createTerminalHistoryAccess({
    registry: services.registry,
    agencyRuntime: services.agencyRuntime,
    agencyWorkspaceStore: services.agencyWorkspaceStore,
    historyStoreFactory: serviceHandle.historyStoreFactory,
  });
  // A workspace change can revoke what a socket was allowed to read.
  hub.observeBroadcasts((message) => {
    if (message.type === 'agency.workspace.changed') history.refreshHistoryBindings();
  });
  const commands = createTerminalCommands({ services, hub, history });
  const reporters = createErrorReporters(hub.sendError);
  const stopServerEvents = wireServerEvents({ services, hub, history, commands });
  const stopSessionEvents = wireSessionEvents({ services, hub, history });

  // noServer: manejamos el upgrade a mano para no pisarnos con el WebSocket de
  // HMR de Vite, que vive en el mismo servidor HTTP.
  const wss = new WebSocketServer({ noServer: true });

  // ---- upgrade ----

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
        .pathname;
    } catch {
      return;
    }

    // Cualquier otra ruta es de Vite. Si destruimos el socket aca, rompemos el HMR.
    if (pathname !== WS_PATH) return;

    const authorization = options.noAuth
      ? authorizeRequestNoAuth(request, port)
      : authorizeRequest(request, port, token, remote.verifier());
    if (!authorization.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      console.warn(`[security] upgrade rejected on ${WS_PATH}: ${authorization.reason}`);
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request, authorization.credential);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, credential: Credential) => {
    acceptConnection(socket, credential, { services, hub, history, commands, reporters });
  });

  return () => {
    // From here on no history store is handed out; pending flushes are awaited below.
    const historyClosed = history.shutdown();
    httpServer.off('upgrade', onUpgrade);
    stopServerEvents();
    stopSessionEvents();
    services.planLimits.dispose();
    for (const client of wss.clients) client.terminate();
    wss.close();
    return Promise.allSettled([historyClosed, serviceHandle.shutdown()]).then(() => undefined);
  };
}
