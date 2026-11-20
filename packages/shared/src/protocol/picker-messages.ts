/**
 * Directory picker messages. A picker belongs to the socket that opened it.
 */

import { parseDirectoryPickerListing, type DirectoryPickerListing } from '../files/files.js';
import { asFiniteNumber, asNonEmptyString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Selector de carpetas, para abrir un proyecto en una que la app no conoce.
 *
 * **El cliente nunca compone una ruta.** El servidor guarda donde esta parado
 * el selector; el cliente solo puede nombrar *un segmento de lo que el servidor
 * le acaba de listar* (`picker.enter`), subir con `..`, o saltar a una raiz por
 * su posicion. Es el criterio de la seccion 2.4 aplicado a un caso nuevo, y es
 * lo que permite que este sea el unico sitio de la app que lista fuera del
 * `cwd` de una pestana sin abrir la puerta a leer cualquier ruta.
 */
export interface ClientPickerOpenMessage {
  type: 'picker.open';
  /** Client correlation allocated before opening; enables immediate cancellation. */
  pickerId?: string;
}

export interface ClientPickerEnterMessage {
  type: 'picker.enter';
  pickerId: string;
  /** Un nombre del listado actual, o `..` para subir. Nunca una ruta. */
  name: string;
}

export interface ClientPickerRootMessage {
  type: 'picker.root';
  pickerId: string;
  /** Posicion en la lista de raices que mando el servidor. */
  rootIndex: number;
}

export interface ClientPickerCreateMessage {
  type: 'picker.create';
  pickerId: string;
  /** Nombre de la carpeta nueva. Un segmento; el servidor lo valida. */
  name: string;
}

export interface ClientPickerCloseMessage {
  type: 'picker.close';
  pickerId: string;
}

/** Un paso del selector de carpetas: donde estamos y que hay adentro. */
export interface ServerPickerListingMessage {
  type: 'picker.listing';
  listing: DirectoryPickerListing;
}

/** Every client message of this family. */
export type ClientPickerMessage =
  | ClientPickerOpenMessage
  | ClientPickerEnterMessage
  | ClientPickerRootMessage
  | ClientPickerCreateMessage
  | ClientPickerCloseMessage;

/** Every server message of this family. */
export type ServerPickerMessage =
  | ServerPickerListingMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientPickerMessage(record: UnknownRecord): ClientPickerMessage | null | undefined {
  switch (record['type']) {
    case 'picker.open': {
      if (record['pickerId'] === undefined) return { type: 'picker.open' };
      const pickerId = asNonEmptyString(record['pickerId']);
      return pickerId === null || !/^[0-9a-f-]{36}$/i.test(pickerId) ? null : { type: 'picker.open', pickerId };
    }
    case 'picker.enter': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const name = asNonEmptyString(record['name']);
      return pickerId === null || name === null
        ? null
        : { type: 'picker.enter', pickerId, name };
    }
    case 'picker.root': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const rootIndex = asFiniteNumber(record['rootIndex']);
      return pickerId === null || rootIndex === null || rootIndex < 0
        ? null
        : { type: 'picker.root', pickerId, rootIndex };
    }
    case 'picker.create': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const name = asNonEmptyString(record['name']);
      return pickerId === null || name === null
        ? null
        : { type: 'picker.create', pickerId, name };
    }
    case 'picker.close': {
      const pickerId = asNonEmptyString(record['pickerId']);
      return pickerId === null ? null : { type: 'picker.close', pickerId };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerPickerMessage(record: UnknownRecord): ServerPickerMessage | null | undefined {
  switch (record['type']) {
    case 'picker.listing': {
      const listing = parseDirectoryPickerListing(record['listing']);
      return listing === null ? null : { type: 'picker.listing', listing };
    }
    default:
      return undefined;
  }
}
