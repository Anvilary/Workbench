/**
 * The set of connected sockets and the ways to reach them.
 *
 * The hub owns who is connected (`clients`), which of those came in as a
 * paired remote device (`remoteSockets`) and the one socket that asked to pair
 * a phone. It is the only place that serializes a `ServerMessage` onto a
 * socket, so error envelopes and broadcast rules cannot drift between handlers.
 */

import {
  encodeServerMessage,
  type ServerErrorCode,
  type ServerErrorMessage,
  type ServerMessage,
  type ServerText,
} from '@agent-workbench/shared';
import type { WebSocket } from 'ws';

export interface SocketHub {
  /** Every open socket. */
  readonly clients: Set<WebSocket>;
  /**
    Las ventanas que entraron como **equipo remoto** (hito 37), con el id de su
    equipo. Las demas entraron con el token del arranque: son del anfitrion.
  */
  readonly remoteSockets: Map<WebSocket, string>;
  /** La ventana que pidio emparejar un telefono: si se cierra, la llave se olvida. */
  readonly phonePairing: { owner: WebSocket | null };
  send(socket: WebSocket, message: ServerMessage): void;
  broadcast(message: ServerMessage): void;
  /** Solo a las ventanas del anfitrion: el estado del acceso remoto no se le cuenta a un equipo remoto. */
  broadcastToHost(message: ServerMessage): void;
  /** A todos menos uno: el que tecleo una nota no necesita el eco. */
  broadcastExcept(except: WebSocket, message: ServerMessage): void;
  sendError(
    socket: WebSocket,
    code: ServerErrorCode,
    text: ServerText,
    detail?: string,
    requestId?: string,
  ): void;
  /** Le pone a una respuesta el `requestId` del pedido, si lo trajo. */
  withRequestId<T extends ServerMessage & { requestId?: string }>(message: T, requestId: string | undefined): T;
  /** Called before every broadcast. Used to revoke socket state that a message invalidates. */
  observeBroadcasts(observer: (message: ServerMessage) => void): void;
}

export function createSocketHub(): SocketHub {
  const clients = new Set<WebSocket>();
  const remoteSockets = new Map<WebSocket, string>();
  const phonePairing: { owner: WebSocket | null } = { owner: null };
  let observer: ((message: ServerMessage) => void) | null = null;

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(encodeServerMessage(message));
  };

  const broadcast = (message: ServerMessage): void => {
    observer?.(message);
    const payload = encodeServerMessage(message);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  /** Solo a las ventanas del anfitrion: el estado del acceso remoto no se le cuenta a un equipo remoto. */
  const broadcastToHost = (message: ServerMessage): void => {
    const payload = encodeServerMessage(message);
    for (const socket of clients) {
      if (!remoteSockets.has(socket) && socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  /** A todos menos uno: el que tecleo una nota no necesita el eco. */
  const broadcastExcept = (except: WebSocket, message: ServerMessage): void => {
    const payload = encodeServerMessage(message);
    for (const socket of clients) {
      if (socket !== except && socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const sendError = (
    socket: WebSocket,
    code: ServerErrorCode,
    text: ServerText,
    detail?: string,
    requestId?: string,
  ): void => {
    // El texto va como clave y la web arma la frase en su idioma (§6.23).
    const payload: ServerErrorMessage = { type: 'error', code, text };
    if (detail !== undefined) payload.detail = detail;
    if (requestId !== undefined) payload.requestId = requestId;
    send(socket, payload);
  };

  /** Le pone a una respuesta el `requestId` del pedido, si lo trajo. */
  const withRequestId = <T extends ServerMessage & { requestId?: string }>(
    message: T,
    requestId: string | undefined,
  ): T => {
    if (requestId !== undefined) message.requestId = requestId;
    return message;
  };

  return {
    clients,
    remoteSockets,
    phonePairing,
    send,
    broadcast,
    broadcastToHost,
    broadcastExcept,
    sendError,
    withRequestId,
    observeBroadcasts: (next) => {
      observer = next;
    },
  };
}
