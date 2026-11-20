/**
 * Shared agent memory messages.
 */

import {
  parseMemoryChange,
  parseMemoryInstallOptions,
  parseMemoryNoteContent,
  parseMemoryStatus,
  type MemoryChange,
  type MemoryInstallOptions,
  type MemoryNoteContent,
  type MemoryStatus,
} from '../agents/memory.js';
import type { TerminalId } from '../sessions/models.js';
import { asArrayOf, asNonEmptyString, asStringArray, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Memoria compartida del proyecto de una pestana (`memory.*`).
 *
 * Igual que `git.*` y `files.*`: todo se dirige por `terminalId` y el servidor
 * resuelve dentro del `cwd` de esa pestana. El cliente no nombra ninguna ruta;
 * lo mas parecido es el nombre de una nota, que el servidor valida como un
 * archivo suelto de `.agents/memory/` (CLAUDE.md 2.4).
 *
 * Es la unica familia que **escribe** dentro de un proyecto, y por eso tiene
 * dos pasos: `memory.plan` devuelve lo que cambiaria sin tocar nada, y
 * `memory.install` lo aplica. El servidor rehace el plan al instalar; lo que
 * mando el cliente son las opciones, nunca los cambios.
 *
 * `requestId` es opcional y el servidor lo devuelve en la respuesta y en el
 * `error`. Sin el, un fallo no dice a que pedido responde: el de la pestana que
 * se dejo atras apareceria en el panel de la que se esta mirando, y el de otro
 * panel apagaria el "Escribiendo…" de una instalacion en curso.
 */
export interface ClientMemorySubscribeMessage {
  type: 'memory.subscribe';
  terminalId: TerminalId;
  requestId?: string;
}

export interface ClientMemoryUnsubscribeMessage {
  type: 'memory.unsubscribe';
  terminalId: TerminalId;
}

export interface ClientMemoryPlanMessage {
  type: 'memory.plan';
  terminalId: TerminalId;
  options: MemoryInstallOptions;
  requestId?: string;
}

export interface ClientMemoryInstallMessage {
  type: 'memory.install';
  terminalId: TerminalId;
  options: MemoryInstallOptions;
  requestId?: string;
}

/** Copia la memoria nativa de la CLI a la carpeta compartida. */
export interface ClientMemoryImportMessage {
  type: 'memory.import';
  terminalId: TerminalId;
  requestId?: string;
}

export interface ClientMemoryReadMessage {
  type: 'memory.read';
  terminalId: TerminalId;
  /** Un archivo de `.agents/memory/`, incluido `MEMORY.md`. Nunca una ruta. */
  name: string;
  requestId?: string;
}

/** Estado de la memoria compartida. Llega al suscribirse y en cada cambio. */
export interface ServerMemoryStatusMessage {
  type: 'memory.status';
  terminalId: TerminalId;
  status: MemoryStatus;
}

/** Lo que cambiaria una instalacion, sin haber escrito nada. */
export interface ServerMemoryPlannedMessage {
  type: 'memory.planned';
  terminalId: TerminalId;
  changes: MemoryChange[];
  /** Eco del `requestId` del pedido, si lo trajo. */
  requestId?: string;
}

/** Lo que se escribio. Le sigue un `memory.status` con el estado nuevo. */
export interface ServerMemoryInstalledMessage {
  type: 'memory.installed';
  terminalId: TerminalId;
  applied: MemoryChange[];
  requestId?: string;
}

/**
 * Resultado de importar la memoria nativa. `skipped` son los nombres que ya
 * existian en la carpeta compartida con otro contenido: no se pisan.
 */
export interface ServerMemoryImportedMessage {
  type: 'memory.imported';
  terminalId: TerminalId;
  copied: string[];
  skipped: string[];
  requestId?: string;
}

export interface ServerMemoryContentMessage {
  type: 'memory.content';
  terminalId: TerminalId;
  note: MemoryNoteContent;
  requestId?: string;
}

/**
 * Copia el `requestId` opcional de un mensaje `memory.*`. Si viene, tiene que
 * ser un texto no vacio; si no, el mensaje sale igual, sin el.
 */
export function withMemoryRequestId<T extends { requestId?: string }>(
  message: T,
  record: Record<string, unknown>,
): T {
  const requestId = asNonEmptyString(record['requestId']);
  if (requestId !== null) message.requestId = requestId;
  return message;
}

/** Every client message of this family. */
export type ClientMemoryMessage =
  | ClientMemorySubscribeMessage
  | ClientMemoryUnsubscribeMessage
  | ClientMemoryPlanMessage
  | ClientMemoryInstallMessage
  | ClientMemoryImportMessage
  | ClientMemoryReadMessage;

/** Every server message of this family. */
export type ServerMemoryMessage =
  | ServerMemoryStatusMessage
  | ServerMemoryPlannedMessage
  | ServerMemoryInstalledMessage
  | ServerMemoryImportedMessage
  | ServerMemoryContentMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientMemoryMessage(record: UnknownRecord): ClientMemoryMessage | null | undefined {
  switch (record['type']) {
    case 'memory.subscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null
        ? null
        : withMemoryRequestId<ClientMemorySubscribeMessage>({ type: 'memory.subscribe', terminalId }, record);
    }
    case 'memory.unsubscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'memory.unsubscribe', terminalId };
    }
    case 'memory.import': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null
        ? null
        : withMemoryRequestId<ClientMemoryImportMessage>({ type: 'memory.import', terminalId }, record);
    }
    case 'memory.plan': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const options = parseMemoryInstallOptions(record['options']);
      return terminalId === null || options === null
        ? null
        : withMemoryRequestId<ClientMemoryPlanMessage>({ type: 'memory.plan', terminalId, options }, record);
    }
    case 'memory.install': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const options = parseMemoryInstallOptions(record['options']);
      return terminalId === null || options === null
        ? null
        : withMemoryRequestId<ClientMemoryInstallMessage>({ type: 'memory.install', terminalId, options }, record);
    }
    case 'memory.read': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const name = asNonEmptyString(record['name']);
      return terminalId === null || name === null
        ? null
        : withMemoryRequestId<ClientMemoryReadMessage>({ type: 'memory.read', terminalId, name }, record);
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerMemoryMessage(record: UnknownRecord): ServerMemoryMessage | null | undefined {
  switch (record['type']) {
    case 'memory.status': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const status = parseMemoryStatus(record['status']);
      return terminalId === null || status === null
        ? null
        : { type: 'memory.status', terminalId, status };
    }
    case 'memory.planned': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const changes = asArrayOf(record['changes'], parseMemoryChange);
      return terminalId === null || changes === null
        ? null
        : withMemoryRequestId<ServerMemoryPlannedMessage>({ type: 'memory.planned', terminalId, changes }, record);
    }
    case 'memory.installed': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const applied = asArrayOf(record['applied'], parseMemoryChange);
      return terminalId === null || applied === null
        ? null
        : withMemoryRequestId<ServerMemoryInstalledMessage>({ type: 'memory.installed', terminalId, applied }, record);
    }
    case 'memory.imported': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const copied = asStringArray(record['copied']);
      const skipped = asStringArray(record['skipped']);
      return terminalId === null || copied === null || skipped === null
        ? null
        : withMemoryRequestId<ServerMemoryImportedMessage>({ type: 'memory.imported', terminalId, copied, skipped }, record);
    }
    case 'memory.content': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const note = parseMemoryNoteContent(record['note']);
      return terminalId === null || note === null
        ? null
        : withMemoryRequestId<ServerMemoryContentMessage>({ type: 'memory.content', terminalId, note }, record);
    }
    default:
      return undefined;
  }
}
