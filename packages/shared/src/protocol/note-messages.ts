/**
 * Loose notes messages: notes, their images and sending a note to a terminal.
 */

import { parseNote, type Note } from '../files/notes.js';
import type { TerminalId } from '../sessions/models.js';
import { asArrayOf, asNonEmptyString, asString, type UnknownRecord } from '../validation/narrowing.js';
import { parseSubmitImage, type SubmitImage } from './agent-messages.js';

/**
 * Notas sueltas (`notes.*`).
 *
 * No van dirigidas a ninguna pestana: son del usuario, no de un proyecto. El
 * `noteId` lo genera el cliente —asi puede activar la solapa nueva sin esperar
 * la respuesta— y el servidor solo lo acepta si tiene forma de id y no existe.
 * Los `imageId`, en cambio, los pone el servidor: son los que nombran archivos
 * en disco, y una ruta nunca la elige el cliente (CLAUDE.md 2.4).
 */
export interface ClientCreateNoteMessage {
  type: 'notes.create';
  noteId: string;
}

export interface ClientUpdateNoteMessage {
  type: 'notes.update';
  noteId: string;
  text: string;
}

/** Cerrar una nota es borrarla, con sus imagenes. El cliente confirma antes. */
export interface ClientDeleteNoteMessage {
  type: 'notes.delete';
  noteId: string;
}

export interface ClientAddNoteImageMessage {
  type: 'notes.addImage';
  noteId: string;
  image: SubmitImage;
}

export interface ClientRemoveNoteImageMessage {
  type: 'notes.removeImage';
  noteId: string;
  imageId: string;
}

/** Pide el contenido de una imagen de una nota, cuando la miniatura se dibuja. */
export interface ClientNoteImageMessage {
  type: 'notes.image';
  imageId: string;
}

/**
 * Manda una nota entera al agente de una pestana.
 *
 * **Solo viajan los dos ids.** El texto y las imagenes ya estan en el servidor
 * —`notes.json` y `notes-images/`—, asi que hacerlos subir al navegador y
 * volver a bajar en base64 solo para reenviarlos seria mover megas por el
 * socket para nada. El servidor arma el mismo pegado que `agent.submit` y usa
 * el mismo `pty-input.ts`: no hay un segundo camino que escriba en la pty.
 *
 * **La nota no se borra.** Mandarla no es cerrarla; cerrar es lo unico que
 * borra, y por eso pide confirmacion.
 */
export interface ClientSendNoteMessage {
  type: 'notes.send';
  noteId: string;
  /** La pestana a la que va. La abre el cliente antes de mandar esto. */
  terminalId: TerminalId;
}

/**
 * La lista completa de notas. Se manda al conectar y tras cada cambio.
 *
 * Con una excepcion: quien escribe el texto **no** la recibe de vuelta. Un eco
 * de cada tecla pisaria lo que el usuario tecleo entre el envio y la respuesta.
 */
export interface ServerNotesListMessage {
  type: 'notes.list';
  notes: Note[];
}

export interface ServerNoteImageMessage {
  type: 'notes.imageData';
  imageId: string;
  mediaType: string;
  /** base64 sin prefijo, o null si la imagen ya no existe. */
  data: string | null;
}

/** Every client message of this family. */
export type ClientNoteMessage =
  | ClientCreateNoteMessage
  | ClientUpdateNoteMessage
  | ClientDeleteNoteMessage
  | ClientAddNoteImageMessage
  | ClientRemoveNoteImageMessage
  | ClientNoteImageMessage
  | ClientSendNoteMessage;

/** Every server message of this family. */
export type ServerNoteMessage =
  | ServerNotesListMessage
  | ServerNoteImageMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientNoteMessage(record: UnknownRecord): ClientNoteMessage | null | undefined {
  switch (record['type']) {
    case 'notes.create': {
      const noteId = asNonEmptyString(record['noteId']);
      return noteId === null ? null : { type: 'notes.create', noteId };
    }
    case 'notes.update': {
      const noteId = asNonEmptyString(record['noteId']);
      const text = asString(record['text']);
      return noteId === null || text === null ? null : { type: 'notes.update', noteId, text };
    }
    case 'notes.delete': {
      const noteId = asNonEmptyString(record['noteId']);
      return noteId === null ? null : { type: 'notes.delete', noteId };
    }
    case 'notes.addImage': {
      const noteId = asNonEmptyString(record['noteId']);
      const image = parseSubmitImage(record['image']);
      return noteId === null || image === null ? null : { type: 'notes.addImage', noteId, image };
    }
    case 'notes.removeImage': {
      const noteId = asNonEmptyString(record['noteId']);
      const imageId = asNonEmptyString(record['imageId']);
      return noteId === null || imageId === null
        ? null
        : { type: 'notes.removeImage', noteId, imageId };
    }
    case 'notes.image': {
      const imageId = asNonEmptyString(record['imageId']);
      return imageId === null ? null : { type: 'notes.image', imageId };
    }
    case 'notes.send': {
      const noteId = asNonEmptyString(record['noteId']);
      const terminalId = asNonEmptyString(record['terminalId']);
      return noteId === null || terminalId === null
        ? null
        : { type: 'notes.send', noteId, terminalId };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerNoteMessage(record: UnknownRecord): ServerNoteMessage | null | undefined {
  switch (record['type']) {
    case 'notes.list': {
      const notes = asArrayOf(record['notes'], parseNote);
      return notes === null ? null : { type: 'notes.list', notes };
    }
    case 'notes.imageData': {
      const imageId = asNonEmptyString(record['imageId']);
      const mediaType = asString(record['mediaType']);
      if (imageId === null || mediaType === null) return null;
      const data = record['data'];
      return {
        type: 'notes.imageData',
        imageId,
        mediaType,
        data: typeof data === 'string' ? data : null,
      };
    }
    default:
      return undefined;
  }
}
