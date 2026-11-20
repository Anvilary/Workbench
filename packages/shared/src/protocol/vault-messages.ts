/**
 * Vault messages: the owned copy of sessions on disk.
 */

import { SESSION_AGENT_IDS, type SessionAgentId } from '../agents/agents.js';
import type { SessionId } from '../sessions/models.js';
import { isVaultSessionId, parseVaultStatus, type VaultStatus } from '../sessions/vault.js';
import { asBoolean, asFiniteNumber, asLiteral, asNonEmptyString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * La copia propia (`vault.*`, hito 28).
 *
 * El servidor contesta con `vault.status` a todos los sockets en cada cambio;
 * los pedidos no llevan `requestId` porque el estado es uno solo y el dialogo
 * dibuja el ultimo que llego. Un fallo es un `error` con `vault-failed`.
 */

/** Pasada en seco: cuanto ocuparia, sin escribir nada. */
export interface ClientVaultMeasureMessage {
  type: 'vault.measure';
}

/** Enciende o apaga la copia. Apagarla no borra nada. */
export interface ClientVaultEnableMessage {
  type: 'vault.enable';
  enabled: boolean;
}

/**
 * Mueve la copia a otra carpeta.
 *
 * **No lleva la carpeta**: la carpeta es donde esta parado ese selector del
 * servidor (`picker.*`). Es el mismo criterio que abrir un proyecto nuevo.
 */
export interface ClientVaultSetDirMessage {
  type: 'vault.setDir';
  pickerId: string;
}

/** Exporta a Markdown las sesiones de un proyecto de la barra, por su `key`. */
export interface ClientVaultExportProjectMessage {
  type: 'vault.exportProject';
  projectKey: string;
}

/** Abre una fila "copia" en Markdown. Por id, nunca por ruta. */
export interface ClientVaultOpenSessionMessage {
  type: 'vault.openSession';
  agent: SessionAgentId;
  /** Con la forma de `VAULT_SESSION_ID_PATTERN`: el parser rechaza otra. */
  sessionId: SessionId;
}

/** Abre la carpeta de la copia con el explorador del sistema. */
export interface ClientVaultRevealMessage {
  type: 'vault.reveal';
}

/**
 * Estado de la copia propia. Al conectar, junto con `notes.list`, y a todos en
 * cada cambio (durante una pasada, no mas de uno cada 500 ms).
 */
export interface ServerVaultStatusMessage {
  type: 'vault.status';
  status: VaultStatus;
}

/** Un proyecto quedo exportado a Markdown. Acusa recibo del boton. */
export interface ServerVaultExportedMessage {
  type: 'vault.exported';
  projectKey: string;
  sessions: number;
}

/** Every client message of this family. */
export type ClientVaultMessage =
  | ClientVaultMeasureMessage
  | ClientVaultEnableMessage
  | ClientVaultSetDirMessage
  | ClientVaultExportProjectMessage
  | ClientVaultOpenSessionMessage
  | ClientVaultRevealMessage;

/** Every server message of this family. */
export type ServerVaultMessage =
  | ServerVaultStatusMessage
  | ServerVaultExportedMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientVaultMessage(record: UnknownRecord): ClientVaultMessage | null | undefined {
  switch (record['type']) {
    case 'vault.measure':
      return { type: 'vault.measure' };
    case 'vault.enable': {
      const enabled = asBoolean(record['enabled']);
      return enabled === null ? null : { type: 'vault.enable', enabled };
    }
    case 'vault.setDir': {
      const pickerId = asNonEmptyString(record['pickerId']);
      return pickerId === null ? null : { type: 'vault.setDir', pickerId };
    }
    case 'vault.exportProject': {
      const projectKey = asNonEmptyString(record['projectKey']);
      return projectKey === null ? null : { type: 'vault.exportProject', projectKey };
    }
    case 'vault.openSession': {
      // El id se valida aca con la forma de la copia: el servidor lo junta con
      // una carpeta, y un `../x` no puede llegar hasta ahi.
      const agent = asLiteral(record['agent'], SESSION_AGENT_IDS);
      const sessionId = asNonEmptyString(record['sessionId']);
      return agent === null || sessionId === null || !isVaultSessionId(sessionId)
        ? null
        : { type: 'vault.openSession', agent, sessionId };
    }
    case 'vault.reveal':
      return { type: 'vault.reveal' };
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerVaultMessage(record: UnknownRecord): ServerVaultMessage | null | undefined {
  switch (record['type']) {
    case 'vault.status': {
      const status = parseVaultStatus(record['status']);
      return status === null ? null : { type: 'vault.status', status };
    }
    case 'vault.exported': {
      const projectKey = asNonEmptyString(record['projectKey']);
      const sessions = asFiniteNumber(record['sessions']);
      return projectKey === null || sessions === null
        ? null
        : { type: 'vault.exported', projectKey, sessions };
    }
    default:
      return undefined;
  }
}
