/**
 * Composer messages: per-terminal drafts and server prefills.
 */

import { parseComposerDraft, type ComposerDraft } from '../sessions/composer-draft.js';
import type { TerminalId } from '../sessions/models.js';
import {
  asArrayFiltered,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asStringArray,
  type UnknownRecord,
} from '../validation/narrowing.js';

export interface ClientComposerDraftMessage {
  type: 'composer.draft';
  terminalId: TerminalId;
  draft: ComposerDraft;
}

/** Por que llega un texto al cuadro de escritura. */
export type ComposerPrefillReason =
  | 'no-delivery'
  | 'not-ready'
  | 'send-failed'
  | 'returned-by-cli'
  | 'stopped-early'
  | 'rewound'
  /** Hito 48: lo pidio el usuario en un dialogo de la app (las notas de una rama aparte). Sin aviso. */
  | 'requested'
  /** §6.35.1: lo que esperaba en la cola de la CLI, que el usuario saco para editarlo. */
  | 'queue-edit';

export const COMPOSER_PREFILL_REASONS: readonly ComposerPrefillReason[] = [
  'no-delivery',
  'not-ready',
  'send-failed',
  'returned-by-cli',
  'stopped-early',
  'rewound',
  'requested',
  'queue-edit',
];

/**
 * Texto para el cuadro de escritura de una pestana. **Nunca se manda solo**: lo
 * manda el usuario con Enter, despues de leerlo (hito 29, D19).
 *
 *  - `no-delivery`: la CLI no tiene como recibirlo sin teclear a ciegas.
 *  - `not-ready`: se iba a mandar y la CLI no llego a estar lista a tiempo.
 *  - `send-failed`: se intento mandar y fallo.
 *  - `returned-by-cli`: un mensaje que se mando con el agente trabajando y que
 *    la CLI no llego a entregar: al interrumpir lo devolvio a su editor, la app
 *    lo saco de ahi y lo trae de vuelta (hito 43, §16.5). Un cliente anterior
 *    no conoce el motivo y descarta el mensaje.
 *  - `stopped-early`: un mensaje que se detuvo antes de que el agente hiciera
 *    nada; la CLI lo deshizo y lo devolvio a su caja, y la app lo trae al
 *    cuadro para corregirlo (hito 44, §4.16).
 *  - `rewound`: el mensaje antes del que se volvio con `agent.rewind`.
 *  - `requested`: lo pidio el usuario en un dialogo de la app (hito 48), sin
 *    aviso.
 */
export interface ServerComposerPrefillMessage {
  type: 'composer.prefill';
  terminalId: TerminalId;
  text: string;
  reason: ComposerPrefillReason;
  /**
   * Hito 49. Textos que van como fichas de texto pegado, cada uno con su marca
   * al final de `text`: la respuesta del revisor que se le pasa a la rama. Un
   * cliente anterior no lo conoce, pero tampoco tiene el boton que lo pide.
   */
  pasted?: string[];
  /**
   * Hito 49. El pedido al que contesta un prellenado `requested`: el cliente
   * pasa a la vista la pestana del pedido que hizo, y no la de otro que llego
   * al mismo tiempo. Un servidor anterior no lo manda.
   */
  requestId?: string;
}

/** El borrador guardado de una pestana. */
export interface ComposerDraftEntry {
  terminalId: TerminalId;
  draft: ComposerDraft;
}

/**
 * Los borradores guardados de las pestanas (§6.29). Al conectar, los de todas,
 * con uno vacio para la que no tiene —la lista puede venir vacia: tambien dice
 * que este servidor los guarda—; cuando aparecen pestanas, los de esas: la
 * restauracion del arranque llega despues de que la pagina se conecto. Y desde
 * el 09-10-2026, cada cambio a todas las ventanas, tambien a la que lo
 * escribio, y uno vacio cuando se manda el cuadro. La web los pone en el cuadro
 * de una pestana donde no hay nada sin guardar; lo que se esta escribiendo no
 * se pisa.
 */
export interface ServerComposerDraftsMessage {
  type: 'composer.drafts';
  drafts: ComposerDraftEntry[];
}

/** Un borrador de `composer.drafts`, o null si no tiene la forma. */
export function parseComposerDraftEntry(value: unknown): ComposerDraftEntry | null {
  const record = asRecord(value);
  if (record === null) return null;
  const terminalId = asNonEmptyString(record['terminalId']);
  const draft = parseComposerDraft(record['draft']);
  return terminalId === null || draft === null ? null : { terminalId, draft };
}

/** Every client message of this family. */
export type ClientComposerMessage =
  | ClientComposerDraftMessage;

/** Every server message of this family. */
export type ServerComposerMessage =
  | ServerComposerPrefillMessage
  | ServerComposerDraftsMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientComposerMessage(record: UnknownRecord): ClientComposerMessage | null | undefined {
  switch (record['type']) {
    case 'composer.draft': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const draft = parseComposerDraft(record['draft']);
      return terminalId === null || draft === null ? null : { type: 'composer.draft', terminalId, draft };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerComposerMessage(record: UnknownRecord): ServerComposerMessage | null | undefined {
  switch (record['type']) {
    case 'composer.prefill': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const text = asNonEmptyString(record['text']);
      // Un motivo desconocido invalida el mensaje: el cuadro dice por que llego
      // el texto, y un texto sin motivo no se escribe en el borrador de nadie.
      const reason = asLiteral(record['reason'], COMPOSER_PREFILL_REASONS);
      if (terminalId === null || text === null || reason === null) return null;
      const message: ServerComposerPrefillMessage = { type: 'composer.prefill', terminalId, text, reason };
      // Hito 49: las fichas de texto pegado. Una que no es texto invalida el mensaje: faltaria lo que nombra su marca.
      if (record['pasted'] !== undefined) {
        const pasted = asStringArray(record['pasted']);
        if (pasted === null) return null;
        if (pasted.length > 0) message.pasted = pasted;
      }
      const requestId = asNonEmptyString(record['requestId']);
      if (requestId !== null) message.requestId = requestId;
      return message;
    }
    case 'composer.drafts': {
      // Uno mal formado se descarta solo: no se lleva los de las demas pestanas.
      const drafts = asArrayFiltered(record['drafts'], parseComposerDraftEntry);
      return drafts === null ? null : { type: 'composer.drafts', drafts };
    }
    default:
      return undefined;
  }
}
