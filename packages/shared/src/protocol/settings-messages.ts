/**
 * Settings, agents usage and plan limit messages.
 */

import type { AgentsUsageSnapshot } from '../agents/agents-usage.js';
import { parsePlanLimits, type PlanLimits } from '../agents/plan-limits.js';
import {
  parseAppSettingsChange,
  parseAppSettingsStatus,
  type AppSettingsChange,
  type AppSettingsStatus,
} from '../settings/settings.js';
import { asArrayFiltered, asNonEmptyString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Lo escrito en el cuadro de una pestana y todavia no mandado (§6.29), para
 * que sobreviva a cerrar la app. Llega despues de una pausa del teclado. El
 * servidor lo guarda por la conversacion de la pestana y no contesta; un
 * borrador vacio borra el guardado. Solo texto: ninguna ruta, y las imagenes
 * no viajan.
 */
/**
 * Cambia lo que Ajustes guarda del lado del servidor (Hito 41, §6.32): con que
 * consola abre una nueva, y que CLIs no se usan. Lleva al menos uno. La consola
 * se nombra por su id, nunca por su ruta. Solo lo atiende una ventana del
 * anfitrion.
 */
export type ClientSettingsUpdateMessage = {
  type: 'settings.update';
  requestId?: string;
} & AppSettingsChange;

export interface ClientAgentsUsageGetMessage {
  type: 'agents.usage.get';
  requestId: string;
  forceRefresh?: boolean;
}

/**
 * Lo que Ajustes muestra del servidor (Hito 41, §6.32). Al conectar, y a todos
 * en cada cambio.
 */
export interface ServerSettingsStatusMessage {
  type: 'settings.status';
  settings: AppSettingsStatus;
  requestId?: string;
}

export interface ServerAgentsUsageSnapshotMessage {
  type: 'agents.usage.snapshot';
  requestId: string;
  usage: AgentsUsageSnapshot;
}

export interface ServerAgentsUsageFailedMessage {
  type: 'agents.usage.failed';
  requestId: string;
  error: string;
}

/**
 * Los limites del plan de cada CLI que los publica (hito 47, §6.37). Al
 * conectar, si hay algo, y a todas las ventanas en cada cambio. Siempre la
 * lista entera: son unas pocas ventanas por CLI.
 */
export interface ServerPlanLimitsMessage {
  type: 'plan.limits';
  limits: PlanLimits[];
}

/** Every client message of this family. */
export type ClientSettingsMessage =
  | ClientSettingsUpdateMessage
  | ClientAgentsUsageGetMessage;

/** Every server message of this family. */
export type ServerSettingsMessage =
  | ServerSettingsStatusMessage
  | ServerPlanLimitsMessage
  | ServerAgentsUsageSnapshotMessage
  | ServerAgentsUsageFailedMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientSettingsMessage(record: UnknownRecord): ClientSettingsMessage | null | undefined {
  switch (record['type']) {
    case 'settings.update': {
      const change = parseAppSettingsChange(record);
      if (change === null) return null;
      const requestId = asNonEmptyString(record['requestId']);
      return requestId !== null
        ? { type: 'settings.update', requestId, ...change }
        : { type: 'settings.update', ...change };
    }
    case 'agents.usage.get': {
      const requestId = asNonEmptyString(record['requestId']);
      if (requestId === null) return null;
      const forceRefresh = record['forceRefresh'] === true;
      return { type: 'agents.usage.get', requestId, forceRefresh };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerSettingsMessage(record: UnknownRecord): ServerSettingsMessage | null | undefined {
  switch (record['type']) {
    case 'settings.status': {
      const settings = parseAppSettingsStatus(record['settings']);
      if (settings === null) return null;
      const requestId = asNonEmptyString(record['requestId']);
      return requestId !== null
        ? { type: 'settings.status', settings, requestId }
        : { type: 'settings.status', settings };
    }
    case 'plan.limits': {
      // Filtrada: una CLI que este lado no conoce no se lleva la de las demas.
      const limits = asArrayFiltered(record['limits'], parsePlanLimits);
      return limits === null ? null : { type: 'plan.limits', limits };
    }
    case 'agents.usage.snapshot': {
      const requestId = asNonEmptyString(record['requestId']);
      const usage = record['usage'] as AgentsUsageSnapshot | undefined;
      return requestId === null || !usage ? null : { type: 'agents.usage.snapshot', requestId, usage };
    }
    case 'agents.usage.failed': {
      const requestId = asNonEmptyString(record['requestId']);
      const error = typeof record['error'] === 'string' ? record['error'] : 'Failed to collect agents usage';
      return requestId === null ? null : { type: 'agents.usage.failed', requestId, error };
    }
    default:
      return undefined;
  }
}
