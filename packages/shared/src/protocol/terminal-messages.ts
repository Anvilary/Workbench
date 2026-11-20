/**
 * Terminal messages: input, resize, open, wake, close, attach, replay, history paging, activity and tab order.
 */

import { AGENT_IDS, type AgentId } from '../agents/agents.js';
import {
  TERMINAL_ACTIVITIES,
  TERMINAL_KINDS,
  TERMINAL_OFFLINE_REASONS,
  parseTerminalDescriptor,
  type SessionId,
  type TerminalActivity,
  type TerminalDescriptor,
  type TerminalId,
  type TerminalKind,
  type TerminalOfflineReason,
} from '../sessions/models.js';
import {
  asArrayFiltered,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asNonNegativeInt,
  asPositiveInt,
  asString,
  asStringArray,
  type UnknownRecord,
} from '../validation/narrowing.js';

/** Teclas del usuario, tal cual las entrega xterm. Van sin filtrar al pty. */
export interface ClientInputMessage {
  type: 'input';
  terminalId: TerminalId;
  data: string;
}

/**
 * Nuevo tamano del terminal. Reenviarlo al pty no es opcional: un pty con
 * tamano desincronizado rompe el renderizado de la CLI.
 */
export interface ClientResizeMessage {
  type: 'resize';
  terminalId: TerminalId;
  cols: number;
  rows: number;
}

/**
 * Abrir una pestana.
 *
 * Si `resumeSessionId` viene, se lanza con `--resume` sobre esa conversacion.
 * Si no, el servidor genera un UUID nuevo y lo pasa con `--session-id`, para
 * saber de antemano que archivo JSONL va a escribir (ver CLAUDE.md 4.8).
 */
export interface ClientOpenTerminalMessage {
  type: 'terminal.open';
  /** Eco para casar la respuesta con la peticion. */
  requestId: string;
  cwd: string;
  resumeSessionId?: SessionId;
  label?: string;
  /**
   * Que lanzar. Ausente significa `agent`, que es lo que pedian los clientes
   * de la v4. Con `shell` se abre la consola del sistema: sin `--session-id`,
   * sin conversacion y sin persistirse entre arranques.
   */
  kind?: TerminalKind;
  /**
   * Que CLI lanzar. Ausente, decide el servidor: reanudando, la de esa sesion;
   * si no, la de la ultima pestana del mismo proyecto, o la CLI por defecto.
   * Solo cuenta para `kind: 'agent'`.
   */
  agent?: AgentId;
  /**
   * Lo pone el **parser**, nunca un cliente: el mensaje pidio una CLI que este
   * lado no conoce, con el valor tal cual llego.
   *
   * Va aparte de `agent` para que ese campo sea siempre un id valido. Ignorarlo
   * abriria la CLI por defecto en lugar de la pedida, que es peor que no abrir
   * nada: el servidor responde `agent-unsupported` y no abre la pestana.
   */
  unsupportedAgent?: string;
  historyId?: string;
}

/** Cierra la pestana y termina el proceso. */
/**
 * Le da proceso a una pestana dormida, o revive una que murio.
 *
 * Es lo unico nuevo que hace falta para que arrancar la aplicacion no lance una
 * CLI por pestana: la conversacion, el medidor y los paneles salen del archivo
 * y del `cwd`, asi que una pestana sin proceso se lee igual. La pty aparece
 * cuando hay algo que escribirle al agente, y eso lo decide el usuario.
 *
 * Reusa el mismo `terminalId` y el mismo `sessionId`: no es una pestana nueva,
 * es la misma que ya estaba en pantalla.
 */
export interface ClientWakeTerminalMessage {
  type: 'terminal.wake';
  terminalId: TerminalId;
}

export interface ClientCloseTerminalMessage {
  type: 'terminal.close';
  terminalId: TerminalId;
}

/**
 * Engancha este socket a una terminal existente y pide el buffer de replay.
 * Es lo que corre despues de recargar el navegador.
 */
export interface ClientAttachTerminalMessage {
  type: 'terminal.attach';
  terminalId: TerminalId;
  /** Tamano actual del contenedor, para sincronizar el pty al reenganchar. */
  cols: number;
  rows: number;
  /** Offset monotonico opcional para replay incremental acotado (sin reset). */
  sinceOffset?: number;
}

/** Deja de recibir salida de esa terminal, sin matarla. */
export interface ClientDetachTerminalMessage {
  type: 'terminal.detach';
  terminalId: TerminalId;
}

export interface ClientRenameTerminalMessage {
  type: 'terminal.rename';
  terminalId: TerminalId;
  label: string;
}

/** Nuevo orden de las pestanas. Se persiste del lado del servidor. */
export interface ClientReorderTabsMessage {
  type: 'tabs.reorder';
  terminalIds: TerminalId[];
}

/** Estado completo de las pestanas. Se manda al conectar y tras cada cambio. */
export interface ServerTerminalListMessage {
  type: 'terminal.list';
  terminals: TerminalDescriptor[];
  /** Orden de las pestanas, por id. */
  order: TerminalId[];
}

export interface ServerTerminalOpenedMessage {
  type: 'terminal.opened';
  /** Eco del requestId de `terminal.open`. */
  requestId: string;
  terminal: TerminalDescriptor;
}

/** Salida en vivo del pty. */
export interface ServerTerminalOutputMessage {
  type: 'terminal.output';
  terminalId: TerminalId;
  data: string;
  /** Offset monotonico acumulado tras este chunk. */
  offset?: number;
}

/**
 * Contenido del buffer circular, en respuesta a `terminal.attach`.
 *
 * El cliente tiene que limpiar la pantalla antes de escribirlo si reset es true:
 * es el estado completo que conocemos. Si reset es false, es un replay incremental
 * que se anexa sin limpiar la pantalla para preservar todo el scrollback.
 */
export interface ServerTerminalReplayMessage {
  type: 'terminal.replay';
  terminalId: TerminalId;
  data: string;
  /** true si el buffer se lleno y se perdio salida anterior. */
  truncated: boolean;
  /** true si el cliente debe resetear la terminal antes de escribir; false para delta. */
  reset?: boolean;
  startOffset?: number;
  endOffset?: number;
  offset?: number;
  /** Dimensions at which a rendering checkpoint must be restored. */
  cols?: number;
  rows?: number;
}

/** El proceso termino. La pestana sigue abierta hasta que el usuario la cierre. */
export interface ServerTerminalExitMessage {
  type: 'terminal.exit';
  terminalId: TerminalId;
  exitCode: number;
  signal: number | null;
}

/**
 * El cliente pide una pagina del historial persistente de una terminal.
 * Las paginas son 0-indexed; la 0 es la mas reciente.
 */
export interface ClientTerminalHistoryPageMessage {
  type: 'terminal.history.page';
  terminalId: TerminalId;
  page: number;
  pageSize?: number;
  /** Direccion de la paginacion: backward (por omision, hacia el pasado) o forward. */
  direction?: 'backward' | 'forward';
  /** ID unico de esta solicitud para cancelacion y deduplicacion. */
  requestId: string;
}

/**
 * Respuesta a `terminal.history.page`.
 */
export interface ServerTerminalHistoryDataMessage {
  type: 'terminal.history.data';
  terminalId: TerminalId;
  requestId: string;
  page: number;
  pageSize: number;
  totalLines: number;
  totalPages: number;
  /** Lineas de salida, con ANSI preservado. Puede estar vacio si page >= totalPages. */
  lines: string[];
  hasMore: boolean;
  /** Total de lineas podadas por politica de retencion. */
  prunedLines?: number;
  /** Bytes lost before persistence, separate from deliberate retention pruning. */
  droppedBytes?: number;
  /** Some output was lost or could not be read or recovered reliably. */
  incomplete?: boolean;
  direction?: 'backward' | 'forward';
}

/**
 * El servidor no pudo atender la solicitud de historial.
 */
export interface ServerTerminalHistoryErrorMessage {
  type: 'terminal.history.error';
  terminalId: TerminalId;
  requestId: string;
  reason: string;
}

/** La pestana se cerro y ya no existe. */
export interface ServerTerminalClosedMessage {
  type: 'terminal.closed';
  terminalId: TerminalId;
}

/** Avance del indexado. La UI muestra progreso en vez de congelarse. */
/**
 * Que esta haciendo la CLI de una pestana.
 *
 * Va aparte de `terminal.list` a proposito: esto cambia cada 700 ms —es un
 * sondeo del estado que la CLI publica por proceso— y la lista de pestanas no.
 * Mandar la lista entera en cada latido seria repetir todo para cambiar una
 * palabra.
 */
export interface ServerTerminalActivityMessage {
  type: 'terminal.activity';
  terminalId: TerminalId;
  activity: TerminalActivity;
  /**
   * Hito 29 (M2), opcional y solo con `offline`: por que una pestana con
   * proceso quedo sin estado. Ausente es el `offline` de siempre.
   */
  offlineReason?: TerminalOfflineReason;
}

/** Every client message of this family. */
export type ClientTerminalMessage =
  | ClientInputMessage
  | ClientResizeMessage
  | ClientOpenTerminalMessage
  | ClientWakeTerminalMessage
  | ClientCloseTerminalMessage
  | ClientAttachTerminalMessage
  | ClientDetachTerminalMessage
  | ClientTerminalHistoryPageMessage
  | ClientRenameTerminalMessage
  | ClientReorderTabsMessage;

/** Every server message of this family. */
export type ServerTerminalMessage =
  | ServerTerminalListMessage
  | ServerTerminalOpenedMessage
  | ServerTerminalOutputMessage
  | ServerTerminalReplayMessage
  | ServerTerminalExitMessage
  | ServerTerminalClosedMessage
  | ServerTerminalHistoryDataMessage
  | ServerTerminalHistoryErrorMessage
  | ServerTerminalActivityMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientTerminalMessage(record: UnknownRecord): ClientTerminalMessage | null | undefined {
  switch (record['type']) {
    case 'input': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      return terminalId === null || data === null
        ? null
        : { type: 'input', terminalId, data };
    }
    case 'resize': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const cols = asPositiveInt(record['cols']);
      const rows = asPositiveInt(record['rows']);
      return terminalId === null || cols === null || rows === null
        ? null
        : { type: 'resize', terminalId, cols, rows };
    }
    case 'terminal.open': {
      const requestId = asNonEmptyString(record['requestId']);
      const cwd = asNonEmptyString(record['cwd']);
      if (requestId === null || cwd === null) return null;

      const message: ClientOpenTerminalMessage = { type: 'terminal.open', requestId, cwd };
      const resumeSessionId = asNonEmptyString(record['resumeSessionId']);
      if (resumeSessionId !== null) message.resumeSessionId = resumeSessionId;
      const label = asString(record['label']);
      if (label !== null) message.label = label;
      const kind = asLiteral(record['kind'], TERMINAL_KINDS);
      if (kind !== null) message.kind = kind;
      const historyId = asNonEmptyString(record['historyId']);
      if (historyId !== null) message.historyId = historyId;
      // Ausente o null es "que decida el servidor"; cualquier otra cosa que no
      // sea un id conocido se conserva para rechazarla, no para ignorarla.
      const rawAgent = record['agent'];
      if (rawAgent !== undefined && rawAgent !== null) {
        const agent = asLiteral(rawAgent, AGENT_IDS);
        if (agent !== null) {
          message.agent = agent;
        } else {
          message.unsupportedAgent = (typeof rawAgent === 'string' ? rawAgent : JSON.stringify(rawAgent)).slice(0, 80);
        }
      }
      return message;
    }
    case 'terminal.close': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.close', terminalId };
    }
    case 'terminal.wake': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.wake', terminalId };
    }
    case 'terminal.attach': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const cols = asPositiveInt(record['cols']);
      const rows = asPositiveInt(record['rows']);
      const sinceOffset = asNonNegativeInt(record['sinceOffset']);
      return terminalId === null || cols === null || rows === null
        ? null
        : {
            type: 'terminal.attach',
            terminalId,
            cols,
            rows,
            ...(sinceOffset !== null ? { sinceOffset } : {}),
          };
    }
    case 'terminal.detach': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.detach', terminalId };
    }
    case 'terminal.history.page': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const page = record['page'];
      const pageSize = record['pageSize'] ?? 1000;
      const direction = record['direction'] ?? 'backward';
      if (terminalId === null || terminalId.length > 128 || requestId === null || requestId.length > 128 ||
          typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0 || page > 1_000_000 ||
          typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
          (direction !== 'backward' && direction !== 'forward')) return null;
      return { type: 'terminal.history.page', terminalId, requestId, page, pageSize, direction };
    }
    case 'terminal.rename': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const label = asString(record['label']);
      return terminalId === null || label === null
        ? null
        : { type: 'terminal.rename', terminalId, label };
    }
    case 'tabs.reorder': {
      const terminalIds = asStringArray(record['terminalIds']);
      return terminalIds === null ? null : { type: 'tabs.reorder', terminalIds };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerTerminalMessage(record: UnknownRecord): ServerTerminalMessage | null | undefined {
  switch (record['type']) {
    case 'terminal.list': {
      // Un descriptor que este lado no entiende —una CLI que no conoce— se
      // descarta solo: no puede dejar la barra de pestanas vacia.
      const terminals = asArrayFiltered(record['terminals'], parseTerminalDescriptor);
      const order = asStringArray(record['order']);
      return terminals === null || order === null
        ? null
        : { type: 'terminal.list', terminals, order };
    }
    case 'terminal.opened': {
      const requestId = asNonEmptyString(record['requestId']);
      const terminal = parseTerminalDescriptor(record['terminal']);
      return requestId === null || terminal === null
        ? null
        : { type: 'terminal.opened', requestId, terminal };
    }
    case 'terminal.output': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      const offset = asNonNegativeInt(record['offset']);
      return terminalId === null || data === null
        ? null
        : {
            type: 'terminal.output',
            terminalId,
            data,
            ...(offset !== null ? { offset } : {}),
          };
    }
    case 'terminal.replay': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      const reset = asBoolean(record['reset']);
      const startOffset = asNonNegativeInt(record['startOffset']);
      const endOffset = asNonNegativeInt(record['endOffset']);
      const offset = asNonNegativeInt(record['offset']);
      const cols = asNonNegativeInt(record['cols']);
      const rows = asNonNegativeInt(record['rows']);
      return terminalId === null || data === null
        ? null
        : {
            type: 'terminal.replay',
            terminalId,
            data,
            truncated: record['truncated'] === true,
            ...(cols !== null && cols > 0 && rows !== null && rows > 0 ? { cols, rows } : {}),
            ...(reset !== null ? { reset } : {}),
            ...(startOffset !== null ? { startOffset } : {}),
            ...(endOffset !== null ? { endOffset } : {}),
            ...(offset !== null ? { offset } : {}),
          };
    }
    case 'terminal.exit': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const exitCode = asFiniteNumber(record['exitCode']);
      if (terminalId === null || exitCode === null) return null;
      const rawSignal = record['signal'];
      return {
        type: 'terminal.exit',
        terminalId,
        exitCode,
        signal: typeof rawSignal === 'number' ? rawSignal : null,
      };
    }
    case 'terminal.closed': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.closed', terminalId };
    }
    case 'terminal.activity': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const activity = asLiteral(record['activity'], TERMINAL_ACTIVITIES);
      if (terminalId === null || activity === null) return null;
      // Un motivo desconocido, o con otra actividad, se descarta sin llevarse el mensaje.
      const offlineReason = activity === 'offline' ? asLiteral(record['offlineReason'], TERMINAL_OFFLINE_REASONS) : null;
      return offlineReason === null
        ? { type: 'terminal.activity', terminalId, activity }
        : { type: 'terminal.activity', terminalId, activity, offlineReason };
    }
    default:
      return undefined;
  }
}
