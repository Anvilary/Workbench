/**
 * HTTP request authorization middleware for the local server.
 */

/**
 * Arranque de Agent Workbench.
 *
 * Un solo proceso: sirve la UI y el WebSocket en el mismo puerto. Eso no es
 * casualidad — con un unico origen, el chequeo de Origin y el token funcionan
 * igual en desarrollo y en produccion, sin excepciones que despues se olvidan
 * de sacar.
 */

import type { NextFunction, Request, Response } from 'express';
import { RemoteAccessService } from '../../features/remote-access/remote-access-service.js';
import {
  authorizeRequest,
  buildDeviceCookie,
  buildTokenCookie,
  readPairingCode,
} from '../../security/request-guards.js';


/**
 * Guardia unica para todas las rutas HTTP.
 *
 * El token llega por query la primera vez (la URL que abrimos) y despues por
 * cookie, porque los assets del SPA no pueden llevarlo en la URL.
 *
 * Con el acceso remoto encendido (hito 37) entra tambien la cookie de un equipo
 * emparejado, y una peticion **sin** credencial puede traer un codigo para
 * emparejarse: si es el vigente, se cambia por esa cookie y se redirige a la
 * raiz, sin el codigo en la direccion. El codigo es una credencial de un solo
 * uso: sigue sin haber ninguna ruta que atienda a quien no presenta nada.
 */
/*
  Las respuestas de texto del servidor no pasan por la web, asi que no hay
  idioma elegido: van en ingles, el idioma por defecto, y en espanol, el de
  siempre (hito 34, D13).
*/
const ORIGIN_REFUSED_TEXT = 'Origin not allowed.\nOrigen no permitido.';
const TOKEN_MISSING_TEXT =
  'The session token is missing. Open the URL the server printed at startup.\n' +
  'Falta el token de sesión. Abre la URL que imprimió el servidor al arrancar.';
/** Solo con el acceso remoto andando: a quien llega de otro equipo, como se entra. */
const PAIRING_HINT_TEXT =
  '\n\nFrom another computer: pair it first. On the computer that runs Agent Workbench, open ' +
  '"Remote access" and choose "Pair a device".\n' +
  'Desde otro equipo: primero emparéjalo. En el equipo donde corre Agent Workbench, abre ' +
  '"Acceso remoto" y elige "Emparejar un equipo".';
const PAIRING_REFUSED_TEXT =
  "That pairing code isn't valid or has expired. Ask for a new one in \"Remote access\".\n" +
  'Ese código para emparejar no es válido o venció. Pide uno nuevo en "Acceso remoto".';

export function createAuthMiddleware(port: number, token: string, remote: RemoteAccessService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = authorizeRequest(request, port, token, remote.verifier());
    if (authorization.ok) {
      const { credential } = authorization;
      (request as any).workbenchCredential = credential;
      if (credential.kind === 'session' && credential.source === 'query') {
        response.setHeader('Set-Cookie', buildTokenCookie(token));
      }
      // La de un equipo se renueva al cargar la pagina, no con cada archivo.
      if (credential.kind === 'device' && request.method === 'GET' && request.path === '/') {
        response.setHeader('Set-Cookie', buildDeviceCookie(credential.credential));
      }
      next();
      return;
    }

    if (authorization.reason !== 'bad-token') {
      response.status(403).type('text/plain').send(ORIGIN_REFUSED_TEXT);
      return;
    }

    // Sin credencial: puede ser un equipo que viene a emparejarse. Solo en la raiz.
    const code = request.method === 'GET' && request.path === '/' ? readPairingCode(request) : null;
    if (code !== null && remote.verifier() !== null) {
      response.setHeader('Cache-Control', 'no-store');
      void remote
        .redeemPairing(code, request.headers['user-agent'])
        .catch(() => null)
        .then((redeemed) => {
          if (redeemed === null) {
            response.status(401).type('text/plain').send(PAIRING_REFUSED_TEXT);
            return;
          }
          response.setHeader('Set-Cookie', buildDeviceCookie(redeemed.credential));
          response.redirect(303, '/');
        });
      return;
    }

    response
      .status(401)
      .type('text/plain')
      .send(remote.verifier() === null ? TOKEN_MISSING_TEXT : TOKEN_MISSING_TEXT + PAIRING_HINT_TEXT);
  };
}

