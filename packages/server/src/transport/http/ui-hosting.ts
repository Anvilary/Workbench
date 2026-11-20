/**
 * Serving the web interface: Vite in development, the compiled files in production.
 */

/**
 * Arranque de Agent Workbench.
 *
 * Un solo proceso: sirve la UI y el WebSocket en el mismo puerto. Eso no es
 * casualidad — con un unico origen, el chequeo de Origin y el token funcionan
 * igual en desarrollo y en produccion, sin excepciones que despues se olvidan
 * de sacar.
 */

import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';


const NOT_FOUND_TEXT = 'Not found.\nNo encontrado.';

/** Monta Vite como middleware. El HMR viaja por el mismo servidor HTTP. */
export async function mountDevUi(
  app: express.Express,
  httpServer: HttpServer,
  webRoot: string,
): Promise<() => Promise<void>> {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: webRoot,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  app.use(vite.middlewares);
  return () => vite.close();
}

/**
 * Sirve la interfaz ya compilada.
 *
 * Vite no se importa siquiera en este camino: en produccion no tiene por que
 * estar instalado.
 *
 * El `sendFile` del final es el fallback de una SPA, y **solo** se aplica a
 * rutas que no piden un archivo. Un fallback que atrapa todo es el error
 * clasico de esta configuracion: un asset que falta devuelve el HTML con
 * estado 200, el navegador intenta interpretar `<!doctype html>` como
 * JavaScript y el error que se ve es un `Unexpected token '<'` que no tiene
 * nada que ver con la causa. Pasa de verdad — con un fragmento cargado a
 * demanda, como el resaltador de sintaxis, basta con recompilar mientras
 * alguien tiene la pagina abierta.
 *
 * Se detecta por la extension del ultimo segmento: si la ruta pide un archivo
 * y `express.static` no lo encontro, no existe, y eso es un 404.
 */
const LOOKS_LIKE_FILE = /\.[a-zA-Z0-9]{1,8}$/;

export function mountBuiltUi(app: express.Express, webDist: string): () => Promise<void> {
  const indexHtml = path.join(webDist, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(
      `There's no compiled interface in ${webDist}.
Run "pnpm build" before "pnpm start", or use "pnpm dev".`,
    );
  }

  app.use(express.static(webDist, { index: false, maxAge: 0 }));
  app.get(/.*/, (request: Request, response: Response) => {
    if (LOOKS_LIKE_FILE.test(request.path)) {
      response.status(404).type('text/plain').send(NOT_FOUND_TEXT);
      return;
    }
    // Absolute paths include hidden install parents such as ~/.local. `send`
    // rejects those as dotfiles unless the trusted asset root is explicit.
    response.sendFile('index.html', { root: webDist });
  });

  return () => Promise.resolve();
}

