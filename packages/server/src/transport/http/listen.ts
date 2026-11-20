/**
 * Binding the HTTP server to the loopback interface.
 */

/**
 * Arranque de Agent Workbench.
 *
 * Un solo proceso: sirve la UI y el WebSocket en el mismo puerto. Eso no es
 * casualidad — con un unico origen, el chequeo de Origin y el token funcionan
 * igual en desarrollo y en produccion, sin excepciones que despues se olvidan
 * de sacar.
 */

import type { Server as HttpServer } from 'node:http';
import { LOOPBACK_HOST } from '../../security/request-guards.js';


/** El puerto estaba tomado, o no se puede abrir: el servidor cae a uno efimero y lo dice. */
export function isPortUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

/** Escucha en loopback. Nunca 0.0.0.0. Rechaza con el error de `listen`. */
export function listenOnLoopback(httpServer: HttpServer, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, LOOPBACK_HOST);
  });
}

