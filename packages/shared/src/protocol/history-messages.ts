/**
 * Session history messages: the session index, archiving, continuing a session in another agent and global search.
 */

import { AGENT_IDS, SESSION_AGENT_IDS, type AgentId, type SessionAgentId } from '../agents/agents.js';
import {
  GLOBAL_SEARCH_MAX_QUERY_CHARS,
  parseGlobalSearchProgress,
  parseGlobalSearchResult,
  type GlobalSearchProgress,
  type GlobalSearchResult,
} from '../files/search.js';
import {
  parseIndexStatus,
  parseProjectSummary,
  type IndexStatus,
  type ProjectSummary,
  type SessionId,
  type TerminalId,
} from '../sessions/models.js';
import {
  asArrayFiltered,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  asStringArray,
  type UnknownRecord,
} from '../validation/narrowing.js';

/**
 * Esconde de la barra lateral, o vuelve a mostrar, un grupo de sesiones.
 *
 * **No borra nada.** El `.jsonl` es de la CLI —es lo que usa `--resume`— y de
 * `~/.claude/` solo leemos (CLAUDE.md 2.1). Lo que se guarda es una lista de
 * ids en el directorio de configuracion propio.
 *
 * Un solo mensaje para las dos direcciones: archivar y restaurar son el mismo
 * cambio con el booleano al reves, y separarlos duplicaria el camino entero
 * para no ganar nada.
 */
export interface ClientArchiveSessionsMessage {
  type: 'session.archive';
  sessionIds: SessionId[];
  archived: boolean;
}

/** Fuerza un reindexado completo. */
export interface ClientRefreshIndexMessage {
  type: 'index.refresh';
}

/**
 * Continuar una sesion con otra CLI, en la carpeta de esa sesion (hito 29).
 *
 * El servidor arma un transcript de los ultimos turnos, abre una pestana de
 * `target` y le entrega el mensaje que lo nombra. **No viaja ninguna ruta ni
 * ningun texto**: la sesion se busca en el indice por `(agent, sessionId)`,
 * igual que `vault.openSession`.
 */
interface ClientContinueSessionBase {
  type: 'session.continue';
  /** Eco: la pestana nueva llega en un `terminal.opened` con este `requestId`. */
  requestId: string;
  /**
   * CLI y sesion de origen: las de la fila o de la pestana. Es `SessionAgentId`
   * y no `AgentId` porque una fila de la barra puede ser de la copia propia con
   * un id importado (hito 28); si se puede continuar lo decide el servidor.
   */
  agent: SessionAgentId;
  sessionId: SessionId;
  /**
   * La etiqueta de la pestana nueva, ya en el idioma de la ventana (hito 34,
   * D12): el servidor no sabe cual es. Es lo mismo que un `terminal.rename`: un
   * texto que solo se muestra. Sin ella, la del servidor.
   */
  label?: string;
}

/** Tope de la etiqueta de una continuacion: una linea, lo que entra en una pestana. */
export const CONTINUE_LABEL_MAX_CHARS = 120;

export type ClientContinueSessionMessage =
  | (ClientContinueSessionBase & {
      /** La CLI que continua. */
      target: AgentId;
      unsupportedAgent?: undefined;
    })
  | (ClientContinueSessionBase & {
      /**
       * Lo pone el **parser**, nunca un cliente: `target` pidio una CLI que este
       * lado no conoce, con el valor tal cual llego (como `terminal.open`). El
       * servidor responde `agent-unsupported` y no abre nada.
       */
      target: null;
      unsupportedAgent: string;
    });

/**
 * Buscar en las conversaciones de la copia propia (hito 29, D22).
 *
 * Solo el texto escrito: ninguna ruta ni carpeta, y el servidor decide en que
 * sesiones busca. Una busqueda nueva del mismo socket cancela la anterior, y
 * la cancelada no contesta.
 */
export interface ClientGlobalSearchMessage {
  type: 'search.global';
  /** Eco en `search.results`, y en el `error` si falla (`requestId`). */
  searchId: string;
  /** Recortada a `GLOBAL_SEARCH_MAX_QUERY_CHARS` por el parser. */
  query: string;
  /** true con "ver archivadas" encendido: la barra tampoco las muestra sin eso. */
  includeArchived: boolean;
}

/**
 * Cortar la busqueda en curso: se cerro el buscador, o se volvio a los titulos.
 * Solo si la que corre es esa: una nueva ya reemplazo a la vieja, y el pedido
 * tardio de cancelar la vieja no puede cortar la nueva. La cortada no contesta.
 */
export interface ClientCancelGlobalSearchMessage {
  type: 'search.cancel';
  searchId: string;
}

export interface ServerIndexStatusMessage {
  type: 'index.status';
  status: IndexStatus;
}

/**
 * Proyectos indexados. Puede llegar varias veces: el indexador va emitiendo a
 * medida que termina cada proyecto, y `replace` distingue un lote parcial de un
 * reemplazo completo del arbol.
 */
export interface ServerIndexProjectsMessage {
  type: 'index.projects';
  projects: ProjectSummary[];
  replace: boolean;
}

/** Como llega a la CLI nueva el mensaje de continuacion. */
export type HandoffDelivery = 'sending' | 'prefilled';

export const HANDOFF_DELIVERIES: readonly HandoffDelivery[] = ['sending', 'prefilled'];

/**
 * Una continuacion quedo armada (hito 29). Llega **despues** del
 * `terminal.opened` con el mismo `requestId`, que es el que abre la pestana.
 */
export interface ServerSessionContinuedMessage {
  type: 'session.continued';
  requestId: string;
  /** La pestana nueva. */
  terminalId: TerminalId;
  /** De donde viene, para el aviso encima del cuadro. */
  source: { agent: SessionAgentId; sessionId: SessionId; title: string };
  /** Turnos que entraron en el transcript. */
  includedTurns: number;
  totalTurns: number;
  /**
   * true si la lectura de la sesion se corto antes del principio (tope de
   * eventos): `totalTurns` es un minimo y el aviso no puede decir "de M".
   */
  totalTurnsIsMinimum: boolean;
  /** `sending`: el servidor la manda; `prefilled`: llega un `composer.prefill`. */
  delivery: HandoffDelivery;
}

/**
 * Lo que va encontrando un `search.global` mientras recorre, solo al socket que
 * lo pidio: los aciertos nuevos y cuantas sesiones lleva. Como mucho uno cada
 * `GLOBAL_SEARCH_PROGRESS_MS`. Termina con `search.results`.
 */
export interface ServerGlobalSearchProgressMessage {
  type: 'search.progress';
  searchId: string;
  progress: GlobalSearchProgress;
}

/** Lo que encontro un `search.global` al terminar, solo al socket que lo pidio. Trae todos los aciertos. */
export interface ServerGlobalSearchMessage {
  type: 'search.results';
  searchId: string;
  result: GlobalSearchResult;
}

/** Entero mayor o igual a cero: una cuenta de turnos. */
export function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Every client message of this family. */
export type ClientHistoryMessage =
  | ClientArchiveSessionsMessage
  | ClientRefreshIndexMessage
  | ClientContinueSessionMessage
  | ClientGlobalSearchMessage
  | ClientCancelGlobalSearchMessage;

/** Every server message of this family. */
export type ServerHistoryMessage =
  | ServerIndexStatusMessage
  | ServerIndexProjectsMessage
  | ServerSessionContinuedMessage
  | ServerGlobalSearchProgressMessage
  | ServerGlobalSearchMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientHistoryMessage(record: UnknownRecord): ClientHistoryMessage | null | undefined {
  switch (record['type']) {
    case 'session.archive': {
      const sessionIds = asStringArray(record['sessionIds']);
      const archived = record['archived'];
      return sessionIds === null || typeof archived !== 'boolean'
        ? null
        : { type: 'session.archive', sessionIds, archived };
    }
    case 'index.refresh':
      return { type: 'index.refresh' };
    case 'session.continue': {
      const requestId = asNonEmptyString(record['requestId']);
      // El origen es una fila que mando este servidor: un id que no se conoce no
      // es "otra CLI", es un mensaje mal formado.
      const agent = asLiteral(record['agent'], SESSION_AGENT_IDS);
      const sessionId = asNonEmptyString(record['sessionId']);
      if (requestId === null || agent === null || sessionId === null) return null;
      const rawLabel = asString(record['label']);
      const label = rawLabel === null ? '' : rawLabel.replace(/\s+/g, ' ').trim().slice(0, CONTINUE_LABEL_MAX_CHARS);
      const base = {
        type: 'session.continue' as const,
        requestId,
        agent,
        sessionId,
        ...(label.length > 0 ? { label } : {}),
      };

      // Como `terminal.open`: un destino desconocido se conserva para
      // rechazarlo con `agent-unsupported`, no para abrir otra CLI en su lugar.
      // Ausente o null no es un destino: sin el no hay nada que continuar.
      const rawTarget = record['target'];
      if (rawTarget === undefined || rawTarget === null) return null;
      const target = asLiteral(rawTarget, AGENT_IDS);
      return target !== null
        ? { ...base, target }
        : {
            ...base,
            target: null,
            unsupportedAgent: (typeof rawTarget === 'string' ? rawTarget : JSON.stringify(rawTarget)).slice(0, 80),
          };
    }
    case 'search.global': {
      const searchId = asNonEmptyString(record['searchId']);
      const query = asString(record['query']);
      // Vacia o corta es valida: el servidor contesta sin leer nada.
      return searchId === null || query === null
        ? null
        : {
            type: 'search.global',
            searchId,
            query: query.slice(0, GLOBAL_SEARCH_MAX_QUERY_CHARS),
            includeArchived: record['includeArchived'] === true,
          };
    }
    case 'search.cancel': {
      const searchId = asNonEmptyString(record['searchId']);
      return searchId === null ? null : { type: 'search.cancel', searchId };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerHistoryMessage(record: UnknownRecord): ServerHistoryMessage | null | undefined {
  switch (record['type']) {
    case 'index.status': {
      const status = parseIndexStatus(record['status']);
      return status === null ? null : { type: 'index.status', status };
    }
    case 'index.projects': {
      // Un proyecto que este lado no entiende no vacia la barra lateral entera.
      const projects = asArrayFiltered(record['projects'], parseProjectSummary);
      return projects === null
        ? null
        : { type: 'index.projects', projects, replace: record['replace'] === true };
    }
    case 'session.continued': {
      const requestId = asNonEmptyString(record['requestId']);
      const terminalId = asNonEmptyString(record['terminalId']);
      const sourceRecord = asRecord(record['source']);
      const sourceAgent = asLiteral(sourceRecord?.['agent'], SESSION_AGENT_IDS);
      const sourceSessionId = asNonEmptyString(sourceRecord?.['sessionId']);
      const sourceTitle = asString(sourceRecord?.['title']);
      const includedTurns = asCount(record['includedTurns']);
      const totalTurns = asCount(record['totalTurns']);
      const delivery = asLiteral(record['delivery'], HANDOFF_DELIVERIES);
      if (
        requestId === null ||
        terminalId === null ||
        sourceAgent === null ||
        sourceSessionId === null ||
        sourceTitle === null ||
        includedTurns === null ||
        totalTurns === null ||
        includedTurns > totalTurns ||
        delivery === null
      ) {
        return null;
      }
      return {
        type: 'session.continued',
        requestId,
        terminalId,
        source: { agent: sourceAgent, sessionId: sourceSessionId, title: sourceTitle },
        includedTurns,
        totalTurns,
        totalTurnsIsMinimum: record['totalTurnsIsMinimum'] === true,
        delivery,
      };
    }
    case 'search.progress': {
      const searchId = asNonEmptyString(record['searchId']);
      const progress = parseGlobalSearchProgress(record['progress']);
      return searchId === null || progress === null ? null : { type: 'search.progress', searchId, progress };
    }
    case 'search.results': {
      const searchId = asNonEmptyString(record['searchId']);
      const result = parseGlobalSearchResult(record['result']);
      return searchId === null || result === null ? null : { type: 'search.results', searchId, result };
    }
    default:
      return undefined;
  }
}
