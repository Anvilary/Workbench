import type { NextFunction, Request, Response } from 'express';
import { authorizeRequestNoAuth } from './security.js';

export function createNoAuthMiddleware(port: number) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = authorizeRequestNoAuth(request, port);
    if (!authorization.ok) {
      response.status(403).type('text/plain').send('Origin not allowed.\nOrigen no permitido.');
      return;
    }
    (request as Request & { mawCredential?: { kind: string } }).mawCredential = authorization.credential;
    next();
  };
}
