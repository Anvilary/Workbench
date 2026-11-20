/**
 * Project files and the directory picker. Every path is resolved inside the terminal's cwd or a picker owned by this socket.
 */

import { serverText, type ClientMessage } from '@agent-workbench/shared';
import { DirectoryPickerError } from '../../../features/files/directory-picker.js';
import {
  existingPaths,
  listDirectory,
  readPreview,
  searchFiles,
} from '../../../features/files/file-browser.js';
import { FileWriteError, saveProjectFile } from '../../../features/files/file-write.js';
import { InvalidPathError, resolveInside } from '../../../features/files/path-guard.js';
import { revealPath } from '../../../features/files/reveal.js';
import type { HandlerContext } from '../handler-context.js';

export const fileMessageTypes = [
  'files.list',
  'files.search',
  'files.read',
  'files.write',
  'files.check',
  'files.reveal',
  'picker.open',
  'picker.enter',
  'picker.root',
  'picker.create',
  'picker.close',
] as const;

type FileMessage = Extract<ClientMessage, { type: (typeof fileMessageTypes)[number] }>;

export async function handleFileMessage(
  message: FileMessage,
  ctx: HandlerContext<'cwdOf' | 'folders' | 'pickers' | 'send' | 'sendError' | 'sendPathError' | 'socket'>,
): Promise<void> {
  const { cwdOf, folders, pickers, send, sendError, sendPathError, socket } = ctx;
  switch (message.type) {
    case 'files.list':
      void (async () => {
        const cwd = cwdOf(message.terminalId);
        if (cwd === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        try {
          const listing = await listDirectory(cwd, message.path, await folders, {
            includeHidden: message.includeHidden === true,
          });
          send(socket, { type: 'files.listing', terminalId: message.terminalId, listing });
        } catch (error) {
          sendPathError(error, serverText('dirReadFailed'));
        }
      })();
      break;
    /*
      La busqueda por nombre es lo unico del panel que mira mas de un nivel
      de una, y por eso es lo unico que lleva topes propios. El `cwd` lo
      sigue poniendo el servidor: lo que llega del cliente es el texto que
      se escribio, nunca una ruta.
    */
    case 'files.search':
      void (async () => {
        const cwd = cwdOf(message.terminalId);
        if (cwd === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        try {
          const result = await searchFiles(cwd, message.query, await folders, {
            includeHidden: message.includeHidden === true,
          });
          send(socket, { type: 'files.results', terminalId: message.terminalId, result });
        } catch (error) {
          sendPathError(error, serverText('dirSearchFailed'));
        }
      })();
      break;
    case 'files.read':
      void (async () => {
        const cwd = cwdOf(message.terminalId);
        if (cwd === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'), undefined, message.requestId);
          return;
        }
        try {
          const preview = await readPreview(cwd, message.path, await folders);
          send(socket, {
            type: 'files.preview',
            terminalId: message.terminalId,
            preview,
            ...(message.requestId ? { requestId: message.requestId } : {}),
          });
        } catch (error) {
          sendPathError(error, serverText('fileReadFailed'), message.requestId);
        }
      })();
      break;
    /*
      Guardar un archivo editado en el visor (Hito 46, §6.36): la segunda
      escritura de la app dentro de un proyecto. Lo que llega es la ruta
      relativa, el texto y la huella de lo que se abrio; que se puede
      escribir lo decide `saveProjectFile`. Un remoto tambien guarda: ya
      puede pedirle al agente que lo haga (§14.4).
    */
    case 'files.write':
      void (async () => {
        const { requestId } = message;
        const cwd = cwdOf(message.terminalId);
        if (cwd === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'), undefined, requestId);
          return;
        }
        try {
          const result = await saveProjectFile(cwd, message.path, message.text, message.baseHash, await folders);
          send(socket, {
            type: 'files.saved',
            terminalId: message.terminalId,
            requestId,
            path: message.path,
            outcome: result.outcome,
            preview: result.preview,
          });
        } catch (error) {
          if (error instanceof InvalidPathError) {
            sendError(socket, 'invalid-path', error.text, undefined, requestId);
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          sendError(
            socket,
            'write-failed',
            error instanceof FileWriteError ? error.text : serverText('fileSaveFailed'),
            detail,
            requestId,
          );
        }
      })();
      break;
    /*
      Cuales de esas rutas son archivos o carpetas del proyecto (§6.33): lo
      que el hilo vuelve enlace. Sin error para ningun caso (una pestana que
      ya no esta, una ruta que cae fuera): nada existe, y el hilo queda como
      texto. Un cartel por una ruta que escribio el agente no le dice nada
      al usuario.
    */
    case 'files.check':
      void (async () => {
        const cwd = cwdOf(message.terminalId);
        const none = { files: [], directories: [] };
        const { files, directories } =
          cwd === null ? none : await existingPaths(cwd, message.paths, await folders).catch(() => none);
        send(socket, {
          type: 'files.checked',
          terminalId: message.terminalId,
          requestId: message.requestId,
          existing: files,
          directories,
        });
      })();
      break;
    case 'files.reveal':
      void (async () => {
        const cwd = cwdOf(message.terminalId);
        if (cwd === null) {
          sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          return;
        }
        try {
          const absolute = await resolveInside(cwd, message.path, { mustExist: true });
          // Abrir algo de la carpeta de una CLI con la app del sistema es leerlo por otro lado.
          if (await (await folders).contains(absolute)) throw new InvalidPathError(serverText('cliFolderClosed'));
          revealPath(absolute);
        } catch (error) {
          sendPathError(error, serverText('pathOpenFailed'));
        }
      })();
      break;
    /*
      Una nota entera al agente de una pestana recien abierta.

      El cliente abre la pestana y manda los dos ids; el contenido ya esta
      de este lado. Se arma el mismo pegado que un mensaje del cuadro de
      escritura y se escribe por el mismo camino: `buildSubmissionWrites`
      es el unico sitio que compone lo que entra en la pty, y la fila de la
      terminal el unico que lo escribe.

      **La nota no se borra.** Mandarla no es cerrarla.
    */
    /*
      Selector de carpetas: el unico sitio de la app que lista fuera del
      `cwd` de una pestana. Cuatro operaciones y ninguna acepta una ruta —
      ver `directory-picker.ts`.
    */
    case 'picker.open':
    case 'picker.enter':
    case 'picker.root':
    case 'picker.create':
      void (async () => {
        try {
          const listing =
            message.type === 'picker.open'
              ? await pickers.open(message.pickerId)
              : message.type === 'picker.enter'
                ? await pickers.enter(message.pickerId, message.name)
                : message.type === 'picker.root'
                  ? await pickers.root(message.pickerId, message.rootIndex)
                  : await pickers.create(message.pickerId, message.name);
          send(socket, { type: 'picker.listing', listing });
        } catch (error) {
          sendError(
            socket,
            'picker-failed',
            error instanceof DirectoryPickerError ? error.text : serverText('pickerListFailed'),
            error instanceof Error ? error.message : String(error),
            message.pickerId,
          );
        }
      })();
      break;
    case 'picker.close':
      pickers.close(message.pickerId);
      break;
  }
}
