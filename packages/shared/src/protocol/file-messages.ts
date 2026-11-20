/**
 * File messages: listing, search, preview, existence checks, saving and reveal, always addressed by terminal.
 */

import {
  isContentHash,
  parseDirectoryListing,
  parseFilePreview,
  parseFileSearchResult,
  type DirectoryListing,
  type FilePreview,
  type FileSearchResult,
} from '../files/files.js';
import type { TerminalId } from '../sessions/models.js';
import { asLiteral, asNonEmptyString, asString, asStringArray, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Contenido de un directorio. `path` es relativo al `cwd` de la pestana;
 * cadena vacia = raiz. Nunca absoluto.
 */
export interface ClientListFilesMessage {
  type: 'files.list';
  terminalId: TerminalId;
  path: string;
  /**
   * true para que vengan tambien las entradas que se ocultan solas.
   *
   * Es el ojo del panel. Sin esto no hay forma de mirar un archivo que
   * `.gitignore` esconde —un `.env` de ejemplo, un `dist/` recien construido—
   * mas que desde afuera de la aplicacion.
   */
  includeHidden?: boolean;
}

/**
 * Busca archivos por nombre dentro del `cwd` de la pestana.
 *
 * Un nivel por peticion sirve para recorrer y no para buscar, asi que esto es
 * lo unico del panel que mira mas de un nivel de una. Va acotado por tres topes
 * a la vez —resultados, directorios visitados y tiempo— porque en un repo
 * grande cualquiera de los tres solo se queda corto.
 */
export interface ClientSearchFilesMessage {
  type: 'files.search';
  terminalId: TerminalId;
  query: string;
  /** El mismo ojo que `files.list`: con true, tambien busca en lo ignorado. */
  includeHidden?: boolean;
}

/** Previsualizacion de solo lectura de un archivo del `cwd`. */
export interface ClientReadFileMessage {
  type: 'files.read';
  terminalId: TerminalId;
  path: string;
  requestId?: string;
}

/** Cuantas rutas lleva como mucho un `files.check`. */
export const FILES_CHECK_MAX_PATHS = 100;

/** El largo de cada una: una ruta mas larga no es de un proyecto real. */
export const FILES_CHECK_MAX_PATH_CHARS = 512;

/**
 * Pregunta cuales de esas rutas son archivos del `cwd` de la pestana (§6.33).
 *
 * Es lo que deja abrir desde el hilo un archivo que el agente nombro: el hilo
 * solo vuelve enlace lo que el servidor dijo que existe. Las rutas son
 * **relativas**, como en `files.read`, y pasan por el mismo guardia (§6.3): una
 * que sale del proyecto, o un enlace hacia afuera, cuenta como que no esta. El
 * parser descarta las que no tienen forma en vez de invalidar el pedido.
 *
 * Solo lo manda una pagina cuyo servidor dijo `fileCheck` en `hello`: un
 * servidor anterior contestaria cada pedido con un cartel de mensaje invalido.
 */
export interface ClientCheckFilesMessage {
  type: 'files.check';
  terminalId: TerminalId;
  /** Eco: la respuesta lo trae, y con el la pagina sabe que rutas pregunto. */
  requestId: string;
  paths: string[];
}

/**
 * Guarda un archivo del `cwd` editado en el visor (Hito 46, §6.36).
 *
 * La ruta es **relativa**, como en `files.read`, y el servidor solo reemplaza
 * el contenido de un archivo que ya existe: no crea, no renombra, no borra, y
 * nunca escribe en la carpeta de una CLI. `baseHash` es la huella de lo que se
 * abrio (`FilePreview.hash`): si el disco ya no la tiene, porque el agente u
 * otro programa lo cambio, no se escribe nada y se contesta `changed`.
 *
 * Solo lo manda una pagina cuyo servidor dijo `fileWrite` en `hello`.
 */
export interface ClientWriteFileMessage {
  type: 'files.write';
  terminalId: TerminalId;
  /** Eco: la respuesta, o el error, lo trae. */
  requestId: string;
  path: string;
  /** El texto entero, con `\n`: el servidor le devuelve los saltos de linea del archivo. */
  text: string;
  baseHash: string;
}

/**
 * Abre la ruta con la aplicacion que el sistema tenga asociada.
 *
 * No se elige editor ni se configura ninguno: se delega en el sistema
 * operativo, que ya sabe cual es el del usuario.
 */
export interface ClientRevealFileMessage {
  type: 'files.reveal';
  terminalId: TerminalId;
  path: string;
}

export interface ServerFilesListingMessage {
  type: 'files.listing';
  terminalId: TerminalId;
  listing: DirectoryListing;
}

export interface ServerFilePreviewMessage {
  type: 'files.preview';
  terminalId: TerminalId;
  preview: FilePreview;
  requestId?: string;
}

/**
 * Respuesta a `files.check`: de las rutas pedidas, las que son un archivo del
 * proyecto y las que son una carpeta. Las demas no estan o caen fuera. Solo al
 * socket que pregunto.
 */
export interface ServerFilesCheckedMessage {
  type: 'files.checked';
  terminalId: TerminalId;
  requestId: string;
  existing: string[];
  /**
   * Las carpetas, que el hilo abre en el explorador del sistema (23-10-2026).
   * Aditivo: un servidor anterior no las manda, y se leen como ninguna.
   */
  directories: string[];
}

/** Lo que paso con un `files.write`. */
export type FileSaveOutcome = 'saved' | 'changed';

export const FILE_SAVE_OUTCOMES: readonly FileSaveOutcome[] = ['saved', 'changed'];

/**
 * Respuesta a `files.write`, solo al socket que guardo. Un fallo llega como
 * `error`, con el mismo `requestId`.
 *
 *  - `saved`: se escribio, y `preview` es el archivo como quedo.
 *  - `changed`: el disco ya no tenia la huella de lo que se abrio y no se
 *    escribio nada. `preview` es lo que hay ahora, o null si el archivo ya no
 *    esta.
 */
export interface ServerFileSavedMessage {
  type: 'files.saved';
  terminalId: TerminalId;
  requestId: string;
  path: string;
  outcome: FileSaveOutcome;
  preview: FilePreview | null;
}

export interface ServerFileSearchMessage {
  type: 'files.results';
  terminalId: TerminalId;
  result: FileSearchResult;
}

/** Every client message of this family. */
export type ClientFileMessage =
  | ClientListFilesMessage
  | ClientSearchFilesMessage
  | ClientReadFileMessage
  | ClientCheckFilesMessage
  | ClientWriteFileMessage
  | ClientRevealFileMessage;

/** Every server message of this family. */
export type ServerFileMessage =
  | ServerFilesListingMessage
  | ServerFilePreviewMessage
  | ServerFilesCheckedMessage
  | ServerFileSavedMessage
  | ServerFileSearchMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientFileMessage(record: UnknownRecord): ClientFileMessage | null | undefined {
  switch (record['type']) {
    case 'files.list': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // La raiz es la cadena vacia, asi que aca no vale asNonEmptyString.
      const listPath = asString(record['path']);
      return terminalId === null || listPath === null
        ? null
        : {
            type: 'files.list',
            terminalId,
            path: listPath,
            includeHidden: record['includeHidden'] === true,
          };
    }
    case 'files.search': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const query = asString(record['query']);
      return terminalId === null || query === null
        ? null
        : {
            type: 'files.search',
            terminalId,
            query,
            includeHidden: record['includeHidden'] === true,
          };
    }
    case 'files.read': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const readPath = asNonEmptyString(record['path']);
      const requestId = asNonEmptyString(record['requestId']);
      if (terminalId === null || readPath === null) return null;
      const message: ClientReadFileMessage = { type: 'files.read', terminalId, path: readPath };
      if (requestId !== null) message.requestId = requestId;
      return message;
    }
    case 'files.check': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const rawPaths = record['paths'];
      if (terminalId === null || requestId === null || !Array.isArray(rawPaths)) return null;
      // Una ruta sin forma no invalida el pedido: se descarta sola, y pasado el tope, el resto.
      const paths: string[] = [];
      for (const candidate of rawPaths) {
        if (paths.length >= FILES_CHECK_MAX_PATHS) break;
        if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= FILES_CHECK_MAX_PATH_CHARS) {
          paths.push(candidate);
        }
      }
      return { type: 'files.check', terminalId, requestId, paths };
    }
    case 'files.write': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const writePath = asNonEmptyString(record['path']);
      const text = asString(record['text']);
      const baseHash = record['baseHash'];
      return terminalId === null || requestId === null || writePath === null || text === null || !isContentHash(baseHash)
        ? null
        : { type: 'files.write', terminalId, requestId, path: writePath, text, baseHash };
    }
    case 'files.reveal': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // Cadena vacia = el propio cwd, y abrirlo es legitimo.
      const revealPath = asString(record['path']);
      return terminalId === null || revealPath === null
        ? null
        : { type: 'files.reveal', terminalId, path: revealPath };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerFileMessage(record: UnknownRecord): ServerFileMessage | null | undefined {
  switch (record['type']) {
    case 'files.listing': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const listing = parseDirectoryListing(record['listing']);
      return terminalId === null || listing === null
        ? null
        : { type: 'files.listing', terminalId, listing };
    }
    case 'files.preview': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const preview = parseFilePreview(record['preview']);
      const requestId = asNonEmptyString(record['requestId']);
      if (terminalId === null || preview === null) return null;
      const message: ServerFilePreviewMessage = { type: 'files.preview', terminalId, preview };
      if (requestId !== null) message.requestId = requestId;
      return message;
    }
    case 'files.checked': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const existing = asStringArray(record['existing']);
      const directories = asStringArray(record['directories']) ?? [];
      return terminalId === null || requestId === null || existing === null
        ? null
        : { type: 'files.checked', terminalId, requestId, existing, directories };
    }
    case 'files.saved': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const savedPath = asNonEmptyString(record['path']);
      const outcome = asLiteral(record['outcome'], FILE_SAVE_OUTCOMES);
      const preview = record['preview'] === null ? null : parseFilePreview(record['preview']);
      if (terminalId === null || requestId === null || savedPath === null || outcome === null) return null;
      // Guardado sin el archivo como quedo no dice nada: el visor no tendria que mostrar.
      if (preview === null && (outcome === 'saved' || record['preview'] !== null)) return null;
      return { type: 'files.saved', terminalId, requestId, path: savedPath, outcome, preview };
    }
    case 'files.results': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const result = parseFileSearchResult(record['result']);
      return terminalId === null || result === null
        ? null
        : { type: 'files.results', terminalId, result };
    }
    default:
      return undefined;
  }
}
