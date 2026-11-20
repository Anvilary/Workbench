/**
 * Agent interaction messages: submitting prompts, answering questions, permission mode, interrupts, queue edits and rewinds.
 */

import { isPermissionMode, type PermissionMode } from '../agents/permission-modes.js';
import type { TerminalId } from '../sessions/models.js';
import {
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  type UnknownRecord,
} from '../validation/narrowing.js';

/**
 * Topes del cuadro de escritura.
 *
 * Viven en `shared` porque los dos lados los necesitan y por motivos distintos:
 * el cliente para avisar antes de mandar 12 MB por el socket, el servidor para
 * hacerlos cumplir. Un limite que solo conoce el cliente no es un limite.
 */
export const MAX_SUBMIT_IMAGE_BYTES = 12 * 1024 * 1024;

export const MAX_SUBMIT_IMAGES = 8;

/**
 * Los archivos adjuntos, aparte de las imagenes (hito 33, §6.21). Un PDF o un
 * log: cualquier documento que el agente pueda abrir por ruta.
 */
export const MAX_SUBMIT_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_SUBMIT_FILES = 4;

/** Una imagen pegada en el cuadro de escritura. */
export interface SubmitImage {
  /** Tipo declarado por el navegador. El servidor comprueba la firma real. */
  mediaType: string;
  /** Contenido en base64, sin el prefijo `data:`. */
  data: string;
}

/**
 * Un archivo adjunto en el cuadro de escritura (hito 33, §6.21).
 *
 * Viajan los bytes y un nombre, nunca una ruta. El nombre es una **pista**: el
 * servidor lo reduce a letras, numeros, punto, guion y guion bajo antes de
 * usarlo dentro del nombre que arma el, y la carpeta la pone el (CLAUDE.md 2.4).
 */
export interface SubmitFile {
  /** El nombre del archivo tal como lo eligio el usuario, sin carpeta. */
  name: string;
  /** Contenido en base64, sin el prefijo `data:`. */
  data: string;
}

/**
 * Un mensaje escrito en el cuadro de escritura de la conversacion.
 *
 * No es un `input` con mas cosas: es una operacion distinta. `input` son teclas
 * y va crudo al pty; esto es *un mensaje*, que el servidor convierte en un
 * pegado con su Enter, guarda las imagenes en disco y las nombra por ruta.
 * Separarlos es lo que permite que las teclas sigan sin pasar por ningun filtro
 * (CLAUDE.md 5) mientras el cuadro de escritura tiene reglas propias.
 */
export interface ClientSubmitMessage {
  type: 'agent.submit';
  terminalId: TerminalId;
  /** Texto tal como lo escribio el usuario, con sus saltos de linea. */
  text: string;
  /** Imagenes pegadas, en el orden en que se pegaron. */
  images: SubmitImage[];
  /**
   * Archivos adjuntos, en el orden en que se agregaron (hito 33). Ausente es
   * ninguno: un cliente anterior no lo manda y un servidor anterior lo ignora,
   * asi que el protocolo no cambia de version.
   */
  files?: SubmitFile[];
  /** false para dejarlo escrito en el prompt sin enviarlo. */
  send?: boolean;
  /**
   * Con el, el servidor contesta una sola vez con `agent.submitted`: si el
   * mensaje llego a la CLI o no (§6.30). Ausente, no contesta nada, como antes.
   */
  requestId?: string;
  /**
   * true si esto **no salio del cuadro**: un comando que manda un control, como
   * el combo de esfuerzo o el de modelo (§5.4). El borrador de la pestana no se
   * toca (§6.29): lo que el usuario venia escribiendo sigue siendo suyo. Ausente
   * —el cuadro, o un cliente anterior— el borrador se vacia, como siempre.
   */
  keepDraft?: boolean;
}

/**
 * Respuesta a una pregunta de eleccion, elegida desde la conversacion.
 *
 * **Viaja lo elegido, no las teclas.** El cliente manda indices de opciones
 * contra la pregunta que el propio servidor le mando; traducirlos a la
 * secuencia que entiende el menu de la CLI es cosa de `pty-input.ts`, que es el
 * unico lugar del proyecto que sabe de secuencias de escape (§5.3). Si esto
 * viajara como teclas, cualquier bug de la UI —o una pagina que consiga
 * hablarle al servidor— escribiria lo que quisiera en la terminal.
 *
 * `toolUseId` no es decorativo: identifica **que** pregunta se esta
 * respondiendo, y el servidor rechaza el mensaje si no es la que esta abierta.
 * Sin eso, una respuesta que sale tarde —porque el usuario ya contesto en la
 * solapa CLI— entra como teclas sueltas en el prompt.
 */
/**
 * Una respuesta escrita en vez de elegida.
 *
 * La CLI ofrece `Type something` al final de cada pregunta, y hasta el hito 16
 * eso obligaba a irse a la solapa CLI — que es justo lo que la tarjeta viene a
 * evitar. Verificado contra la 2.1.260 en las tres posiciones posibles: unica
 * pregunta, primera de dos y ultima de dos.
 */
export interface FreeTextSelection {
  kind: 'free';
  /** Lo que escribio el usuario. El servidor lo sanea antes de escribirlo. */
  text: string;
}

/** Lo elegido en una pregunta: indices de opciones, o texto propio. */
export type AnswerSelection = number[] | FreeTextSelection;

export interface ClientAnswerMessage {
  type: 'agent.answer';
  terminalId: TerminalId;
  /** El `id` del `tool_use` que hizo la pregunta. */
  toolUseId: string;
  /** Lo elegido, una entrada por pregunta y en el mismo orden. */
  selections: AnswerSelection[];
}

/**
 * Cambia el modo de permiso de una pestana.
 *
 * Viaja **el modo destino**, no las teclas: la CLI no tiene comando de barra
 * para esto y la unica forma de cambiarlo en una sesion viva es `shift+tab`,
 * que cicla. Cuantas veces hay que mandarlo lo decide el servidor, que es el
 * que sabe en que modo esta la pestana (§5.4.2). Si el cliente mandara las
 * pulsaciones, cualquier desincronizacion dejaria al usuario en un modo que no
 * eligio.
 */
export interface ClientPermissionModeMessage {
  type: 'agent.mode';
  terminalId: TerminalId;
  /** Uno de `PERMISSION_MODE_CYCLE`. */
  mode: PermissionMode;
}

/** Interrumpe lo que la CLI este haciendo. Es un `Esc`, ni mas ni menos. */
export interface ClientInterruptMessage {
  type: 'agent.interrupt';
  terminalId: TerminalId;
}

/**
 * Que el agente lea ya lo que espera en la cola de la CLI (hito 45, §6.35).
 *
 * Es para cuando el agente va por mal camino: en lo demas conviene que la CLI
 * elija cuando entregarlo. Viaja el pedido y no las teclas: cual es la forma
 * de cada CLI —su tecla de "enviar ya", o detener y volver a mandar— lo decide
 * el servidor. Solo con la capacidad `forceSend`, algo en cola y la CLI sin
 * esperar al usuario. Responde `agent.forceSent` una sola vez, con un `error`
 * antes si no se hizo.
 */
export interface ClientForceSendMessage {
  type: 'agent.forceSend';
  terminalId: TerminalId;
  requestId: string;
}

/**
 * Sacar de la cola de la CLI lo que espera, para editarlo en el cuadro
 * (§6.35.1), como la flecha arriba de la CLI. Salen **todos** los mensajes en
 * cola, juntos: la CLI no saca uno solo. Viaja el pedido y no las teclas: las
 * de cada CLI, y como se comprueba en su pantalla que salieron, las decide el
 * servidor. Solo con la capacidad `editQueue`, algo en cola y la CLI sin
 * esperar al usuario. El texto llega en un `composer.prefill` con `queue-edit`,
 * y despues `agent.queueEdited`, una sola vez, con un `error` antes si no se
 * hizo.
 */
export interface ClientEditQueueMessage {
  type: 'agent.editQueue';
  terminalId: TerminalId;
  requestId: string;
}

/** Que se deshace al volver a antes de un mensaje (hito 44). */
export type RewindRestore = 'conversation' | 'conversation-and-code';

export const REWIND_RESTORES: readonly RewindRestore[] = ['conversation', 'conversation-and-code'];

/**
 * Volver a antes de un mensaje propio (hito 44, §4.16): la app maneja el menu de
 * rewind de la CLI, comprobando en su pantalla cada paso, y el mensaje vuelve
 * al cuadro (`composer.prefill` con `rewound`). Solo con la capacidad
 * `rewind` y la CLI libre. Responde `agent.rewound`, o un `error`
 * `rewind-failed` con el mismo `requestId`.
 */
export interface ClientRewindMessage {
  type: 'agent.rewind';
  terminalId: TerminalId;
  /** El mensaje del hilo: el del usuario antes del que se vuelve. */
  eventId: string;
  restore: RewindRestore;
  requestId: string;
}

/**
 * Como termino un `agent.forceSend` (hito 45). Solo al socket que lo pidio, y
 * una sola vez. `sent`: se escribio lo que fuerza el envio; false, el motivo
 * ya llego en su `error`.
 */
export interface ServerAgentForceSentMessage {
  type: 'agent.forceSent';
  terminalId: TerminalId;
  requestId: string;
  sent: boolean;
}

/**
 * Como termino un `agent.editQueue` (§6.35.1). Solo al socket que lo pidio, y
 * una sola vez. `edited`: la cola salio de la CLI y su texto ya llego en un
 * `composer.prefill`; false, el motivo ya llego en su `error`.
 */
export interface ServerAgentQueueEditedMessage {
  type: 'agent.queueEdited';
  terminalId: TerminalId;
  requestId: string;
  edited: boolean;
}

/**
 * Como termino un `agent.submit` que traia `requestId` (§6.30). Solo al socket
 * que lo mando, y una sola vez.
 *
 * `delivered` es que se escribio en la CLI hasta el Enter. false es que no se
 * escribio entero: el motivo ya llego en su `error`, si lo hubo.
 */
export interface ServerAgentSubmittedMessage {
  type: 'agent.submitted';
  terminalId: TerminalId;
  requestId: string;
  delivered: boolean;
}

/**
 * Un `agent.rewind` que salio bien (hito 44). Solo al socket que lo pidio. El
 * mensaje ya va en un `composer.prefill` y el hilo, en un `conversation.reset`.
 * `codeRestored`: false si se pidio deshacer el codigo y la CLI no tenia
 * cambios que deshacer.
 */
export interface ServerAgentRewoundMessage {
  type: 'agent.rewound';
  terminalId: TerminalId;
  requestId: string;
  codeRestored: boolean;
}

/**
 * Una imagen del cuadro de escritura.
 *
 * Solo se comprueba la forma. Que el contenido **sea** una imagen lo decide el
 * servidor mirando la firma de los bytes, no este parser ni el navegador.
 */
export function parseSubmitImage(value: unknown): SubmitImage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const mediaType = asNonEmptyString(record['mediaType']);
  const data = asNonEmptyString(record['data']);
  return mediaType === null || data === null ? null : { mediaType, data };
}

/** Un archivo adjunto. Solo la forma: el tope y el nombre los decide el servidor. */
export function parseSubmitFile(value: unknown): SubmitFile | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asNonEmptyString(record['name']);
  const data = asNonEmptyString(record['data']);
  return name === null || data === null ? null : { name, data };
}

/**
 * Lo elegido en una pregunta: indices de opciones, o texto propio.
 *
 * El texto propio es la opcion `Type something` que la CLI agrega al final de
 * cada pregunta. Viaja como una forma distinta y no como un indice magico
 * —`-1`, o `optionCount`— para que nada pueda confundirlo con una opcion real:
 * lo que se elige aca termina en teclas escritas en un TUI.
 */
export function parseSelection(value: unknown): AnswerSelection | null {
  if (Array.isArray(value)) {
    const chosen: number[] = [];
    for (const entry of value) {
      const index = asFiniteNumber(entry);
      if (index === null || !Number.isInteger(index) || index < 0) return null;
      chosen.push(index);
    }
    return chosen;
  }

  const record = asRecord(value);
  if (record === null || record['kind'] !== 'free') return null;
  const text = asString(record['text']);
  return text === null ? null : { kind: 'free', text };
}

/** Every client message of this family. */
export type ClientAgentMessage =
  | ClientSubmitMessage
  | ClientAnswerMessage
  | ClientPermissionModeMessage
  | ClientInterruptMessage
  | ClientForceSendMessage
  | ClientEditQueueMessage
  | ClientRewindMessage;

/** Every server message of this family. */
export type ServerAgentMessage =
  | ServerAgentSubmittedMessage
  | ServerAgentForceSentMessage
  | ServerAgentQueueEditedMessage
  | ServerAgentRewoundMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientAgentMessage(record: UnknownRecord): ClientAgentMessage | null | undefined {
  switch (record['type']) {
    case 'agent.submit': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const text = asString(record['text']);
      const images = asArrayOf(record['images'], parseSubmitImage);
      if (terminalId === null || text === null || images === null) return null;
      const message: ClientSubmitMessage = { type: 'agent.submit', terminalId, text, images };
      // Ausente es ninguno; presente y mal formado invalida el mensaje entero,
      // como una imagen: mandar el texto sin su adjunto es peor que no mandarlo.
      if (record['files'] !== undefined) {
        const files = asArrayOf(record['files'], parseSubmitFile);
        if (files === null) return null;
        if (files.length > 0) message.files = files;
      }
      // Ausente significa enviar: dejarlo escrito es el caso raro.
      if (record['send'] === false) message.send = false;
      const requestId = asNonEmptyString(record['requestId']);
      if (requestId !== null) message.requestId = requestId;
      if (record['keepDraft'] === true) message.keepDraft = true;
      return message;
    }
    case 'agent.mode': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const mode = record['mode'];
      return terminalId === null || !isPermissionMode(mode)
        ? null
        : { type: 'agent.mode', terminalId, mode };
    }
    case 'agent.answer': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const toolUseId = asNonEmptyString(record['toolUseId']);
      const selections = asArrayOf(record['selections'], parseSelection);
      return terminalId === null || toolUseId === null || selections === null
        ? null
        : { type: 'agent.answer', terminalId, toolUseId, selections };
    }
    case 'agent.interrupt': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'agent.interrupt', terminalId };
    }
    case 'agent.forceSend': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      return terminalId === null || requestId === null ? null : { type: 'agent.forceSend', terminalId, requestId };
    }
    case 'agent.editQueue': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      return terminalId === null || requestId === null ? null : { type: 'agent.editQueue', terminalId, requestId };
    }
    case 'agent.rewind': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const eventId = asNonEmptyString(record['eventId']);
      const restore = asLiteral(record['restore'], REWIND_RESTORES);
      const requestId = asNonEmptyString(record['requestId']);
      return terminalId === null || eventId === null || restore === null || requestId === null
        ? null
        : { type: 'agent.rewind', terminalId, eventId, restore, requestId };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerAgentMessage(record: UnknownRecord): ServerAgentMessage | null | undefined {
  switch (record['type']) {
    case 'agent.forceSent': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const sent = asBoolean(record['sent']);
      return terminalId === null || requestId === null || sent === null
        ? null
        : { type: 'agent.forceSent', terminalId, requestId, sent };
    }
    case 'agent.queueEdited': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const edited = asBoolean(record['edited']);
      return terminalId === null || requestId === null || edited === null
        ? null
        : { type: 'agent.queueEdited', terminalId, requestId, edited };
    }
    case 'agent.submitted': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const delivered = asBoolean(record['delivered']);
      return terminalId === null || requestId === null || delivered === null
        ? null
        : { type: 'agent.submitted', terminalId, requestId, delivered };
    }
    case 'agent.rewound': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const requestId = asNonEmptyString(record['requestId']);
      const codeRestored = asBoolean(record['codeRestored']);
      return terminalId === null || requestId === null || codeRestored === null
        ? null
        : { type: 'agent.rewound', terminalId, requestId, codeRestored };
    }
    default:
      return undefined;
  }
}
