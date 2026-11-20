/**
 * Conversation messages: the followed transcript, live state, plans and images.
 */

import type { AgentDefaults } from '../agents/agent-controls.js';
import { isPermissionMode, type PermissionMode } from '../agents/permission-modes.js';
import {
  CONVERSATION_IMAGE_SOURCES,
  CONVERSATION_STATES,
  MAX_QUEUED_PROMPTS,
  MAX_REPORTED_SUBAGENTS,
  parseContextUsage,
  parseConversationEvent,
  parseConversationPart,
  parseConversationSubagent,
  parsePlanContent,
  parseQueuedPrompt,
  parseSessionPlan,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationPart,
  type ConversationQuestionPart,
  type ConversationState,
  type ConversationSubagent,
  type PlanContent,
  type QueuedPrompt,
  type SessionPlan,
} from '../sessions/conversation.js';
import type { SessionId, TerminalId } from '../sessions/models.js';
import {
  asArrayFiltered,
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asPositiveInt,
  asRecord,
  asString,
  type UnknownRecord,
} from '../validation/narrowing.js';

/**
 * Empieza a seguir el JSONL de la sesion de esta pestana.
 *
 * La respuesta es un `conversation.reset` con el tramo final de la
 * conversacion; despues llegan `conversation.append` a medida que la CLI
 * escribe.
 */
export interface ClientSubscribeConversationMessage {
  type: 'conversation.subscribe';
  terminalId: TerminalId;
}

/** Deja de seguirla. El seguimiento se apaga cuando no queda nadie mirando. */
export interface ClientUnsubscribeConversationMessage {
  type: 'conversation.unsubscribe';
  terminalId: TerminalId;
}

/**
 * Pide el tramo anterior a un evento ya recibido.
 *
 * Va por id y no por indice a proposito: el cliente puede tener una vista
 * parcial y los indices se corren cuando el servidor descarta eventos viejos.
 */
export interface ClientLoadMoreConversationMessage {
  type: 'conversation.loadMore';
  terminalId: TerminalId;
  beforeEventId: string;
  limit: number;
}

/**
 * Pide el contenido de una imagen del historial.
 *
 * Los eventos llevan la referencia y no los bytes: el JSONL las guarda en
 * base64 y una conversacion con capturas pesaria megas en cada carga. Esto es
 * lo que se manda cuando una miniatura entra en pantalla.
 */
export interface ClientConversationImageMessage {
  type: 'conversation.image';
  terminalId: TerminalId;
  eventId: string;
  /** Posicion dentro de su fuente. */
  index: number;
  /** En cual de las dos formas buscarla. Ver `ConversationImageSource`. */
  source: ConversationImageSource;
}

/**
 * Pide el contenido de un plan de esta pestana.
 *
 * Viaja el **nombre del archivo** que el servidor mando en la lista de planes,
 * nunca una ruta: la carpeta la pone el servidor, y antes de leer comprueba que
 * ese plan sea uno de los que esta conversacion nombro. Es la regla de §2.4
 * aplicada a la tercera carpeta de `~/.claude/` que la app lee.
 */
export interface ClientReadPlanMessage {
  type: 'plans.read';
  terminalId: TerminalId;
  fileName: string;
}

/**
 * Estado completo conocido de una conversacion, en respuesta a
 * `conversation.subscribe`.
 *
 * Reemplaza lo que el cliente tuviera: no es un incremento. Trae el tramo
 * final, que es lo que se quiere ver al abrir el panel; `hasMore` dice si hay
 * mas atras y se pide con `conversation.loadMore`.
 */
export interface ServerConversationResetMessage {
  type: 'conversation.reset';
  terminalId: TerminalId;
  /**
   * Vacio mientras la CLI no dijo que sesion es: una CLI que pone el id ella
   * misma lo escribe recien con el primer mensaje, y hasta entonces la pestana
   * existe y se sigue sin tener sesion.
   */
  sessionId: SessionId;
  state: ConversationState;
  events: ConversationEvent[];
  hasMore: boolean;
  usage: ContextUsage;
  /** Modo de permiso observado en el archivo, o null si todavia no lo dijo. */
  permissionMode: PermissionMode | null;
  /**
   * Modelo y esfuerzo que dice la configuracion, para el rato en que el archivo
   * todavia no tiene ninguna respuesta. Provisional: lo pisa lo observado.
   */
  defaults: AgentDefaults;
  /** Que esta esperando la CLI, o null si no espera nada. Ver `waitingFor`. */
  waitingFor: string | null;
  /**
   * true si la CLI no publica su estado y tiene una llamada a herramienta de
   * este proceso sin resultado. Ver `conversation.toolCall`. Un servidor que no
   * lo manda equivale a false.
   */
  openToolCall: boolean;
  /**
   * Los subagentes de este proceso que siguen trabajando. Ver
   * `conversation.subagents`. Un servidor que no lo manda equivale a ninguno.
   */
  subagents: ConversationSubagent[];
  /**
   * Los mensajes que esperan en la cola de la CLI (hito 45). Ver
   * `conversation.queue`. Un servidor que no lo manda equivale a ninguno.
   */
  queue: QueuedPrompt[];
  /**
   * La pregunta abierta leida de la pantalla de la CLI, o null. Ver
   * `conversation.liveQuestion`. Un servidor que no la manda equivale a null.
   */
  liveQuestion: ConversationQuestionPart | null;
}

/**
 * La pregunta que la CLI tiene abierta, leida de su pantalla (23-10-2026,
 * §5.5.4), o null cuando ya no hay ninguna que se pueda contestar desde el
 * hilo.
 *
 * Existe porque Claude Code no escribe en el historial la linea de la pregunta
 * hasta que se contesta (medido con la 2.1.309: tres de tres), y la tarjeta del
 * hilo sale de esa linea. Mientras tanto la app lee el menu de la pantalla y
 * manda esto. `toolUseId` no es el de la CLI, que no se ve: es un id de la app
 * para esta pregunta, y es el que lleva el `agent.answer` que la contesta. Al
 * contestarla, la CLI escribe la linea de verdad y el hilo la muestra como
 * siempre.
 */
export interface ServerConversationLiveQuestionMessage {
  type: 'conversation.liveQuestion';
  terminalId: TerminalId;
  question: ConversationQuestionPart | null;
}

/**
 * La cola de mensajes que esperan en la CLI cambio, sin mensajes nuevos en el
 * hilo (hito 45, §6.35): se mando uno con el agente trabajando, se forzo el
 * envio, o la CLI quedo libre o sin proceso. Va la cola entera. Cuando cambia
 * junto con mensajes nuevos —la CLI entrego uno— va dentro de ese
 * `conversation.append`, para que la burbuja no se vaya antes de que aparezca
 * el mensaje.
 */
export interface ServerConversationQueueMessage {
  type: 'conversation.queue';
  terminalId: TerminalId;
  queue: QueuedPrompt[];
}

/**
 * Los subagentes que siguen trabajando cambiaron (§4.15, §6.30).
 *
 * Va la lista entera: son pocos y de cuatro campos, y asi el cliente no tiene
 * nada que fusionar. La calcula el servidor porque depende de lineas que no son
 * eventos —el aviso de que uno termino— y de cuando se lanzo el proceso de
 * ahora: uno de un proceso anterior murio con el y no avisa nunca.
 */
export interface ServerConversationSubagentsMessage {
  type: 'conversation.subagents';
  terminalId: TerminalId;
  subagents: ConversationSubagent[];
}

/**
 * Cambio si hay una llamada a herramienta abierta, sin mensajes nuevos.
 *
 * Solo para una CLI que no publica su estado. Con una llamada sin resultado
 * puede estar mostrando un menu de aprobacion que la app no ve, y un mensaje
 * del cuadro de escritura llegaria como teclas a ese menu: el Enter final
 * aprueba. El servidor ya rechaza ese envio; esto es para que el cuadro lo
 * diga antes y no deje apretar Enviar.
 *
 * Lo calcula el servidor y no el cliente porque depende de dos cosas que los
 * eventos no traen: si el turno se cerro (la CLI lo escribe en lineas que no
 * son mensajes) y cuando se lanzo el proceso de ahora (una llamada de un
 * proceso anterior quedo huerfana y no bloquea).
 */
export interface ServerConversationToolCallMessage {
  type: 'conversation.toolCall';
  terminalId: TerminalId;
  open: boolean;
}

/**
 * Cuanto duro un turno cuyo mensaje ya se entrego.
 *
 * La CLI escribe la duracion en la linea siguiente al ultimo mensaje del turno,
 * asi que casi siempre viaja dentro del propio evento. Cuando cae del otro lado
 * del corte de una lectura, llega por aca: el cliente le pone la duracion al
 * evento que ya tiene, en vez de recibirlo dos veces.
 */
export interface ServerConversationTurnsMessage {
  type: 'conversation.turns';
  terminalId: TerminalId;
  turns: { eventId: string; durationMs: number }[];
}

/**
 * Las partes de un mensaje que ya se entrego, rehechas.
 *
 * Mismo caso que `conversation.turns`: la imagen que el cuadro de escritura
 * manda por ruta no viaja en la linea del mensaje sino en una `attachment`
 * aparte, que llega despues. Casi siempre en la misma lectura —y entonces el
 * evento ya sale corregido—, pero un poll puede caer entre las dos lineas.
 *
 * El cliente le reemplaza las partes al evento que ya tiene, en vez de
 * recibirlo dos veces y tener que deduplicar.
 */
export interface ServerConversationPartsMessage {
  type: 'conversation.parts';
  terminalId: TerminalId;
  updates: { eventId: string; parts: ConversationPart[] }[];
}

/** Contenido de una imagen del historial, pedido con `conversation.image`. */
export interface ServerConversationImageMessage {
  type: 'conversation.imageData';
  terminalId: TerminalId;
  eventId: string;
  index: number;
  /** La forma en la que se pidio. Es parte de la clave con la que se guarda. */
  source: ConversationImageSource;
  mediaType: string;
  /** base64 sin prefijo, o null si no se pudo encontrar. */
  data: string | null;
}

/** Eventos nuevos del JSONL. Se agregan al final de lo que ya hay. */
export interface ServerConversationAppendMessage {
  type: 'conversation.append';
  terminalId: TerminalId;
  events: ConversationEvent[];
  usage: ContextUsage;
  /**
   * Modo de permiso segun la ultima linea `permission-mode` del archivo.
   *
   * Viaja aca y no en `defaults` porque no es configuracion sino observacion:
   * es el modo con el que la CLI acaba de trabajar, y cambia solo si alguien
   * lo cambia — desde el combo o con `shift+tab` en la solapa CLI.
   */
  permissionMode: PermissionMode | null;
  /**
   * La cola de la CLI, si cambio con estos mensajes (hito 45): la CLI entrego
   * uno que esperaba, y la burbuja se va en el mismo dibujo en que aparece el
   * mensaje. Ausente: la cola no cambio.
   */
  queue?: QueuedPrompt[];
}

/** Tramo anterior, en respuesta a `conversation.loadMore`. Va al principio. */
export interface ServerConversationPageMessage {
  type: 'conversation.page';
  terminalId: TerminalId;
  events: ConversationEvent[];
  hasMore: boolean;
}

/**
 * El modo de permiso cambio, sin que haya llegado ningun mensaje nuevo.
 *
 * Hace falta como mensaje propio porque el modo viaja pegado a los eventos, y
 * el caso que importa no tiene ninguno: uno cambia el modo y quiere ver que
 * cambio, sin escribirle nada al agente. La CLI escribe su linea
 * `permission-mode` en ese momento; sin esto, el combo se quedaba mostrando el
 * modo viejo hasta el turno siguiente. Encontrado probando.
 */
export interface ServerConversationModeMessage {
  type: 'conversation.mode';
  terminalId: TerminalId;
  mode: PermissionMode;
}

/**
 * La CLI esta esperando una respuesta del usuario.
 *
 * Sale de `~/.claude/sessions/<pid>.json`, que la CLI reescribe cuando cambia
 * de estado (ver `cli-status.ts` en el servidor). Es el unico dato del sistema
 * de archivos que dice que hay algo esperando: **el JSONL no lo dice**, porque
 * mientras un permiso esta pendiente el archivo de sesion tiene el `tool_use` y
 * nada mas.
 *
 * Por lo mismo, esto **no** trae el contenido del pedido. Dice que espera y de
 * que clase, nunca que herramienta pidio permiso ni con que opciones: eso no
 * esta en ningun archivo, y por eso la conversacion avisa y lleva a la solapa
 * CLI en vez de dibujar botones que no puede llenar.
 */
export interface ServerConversationWaitingMessage {
  type: 'conversation.waiting';
  terminalId: TerminalId;
  /**
   * Etiqueta cruda de la CLI, o null si dejo de esperar.
   *
   * Valores vistos en el binario de la 2.1.261: `permission prompt`,
   * `input needed`, `worker request`, `sandbox request`, `dialog open`. Viaja
   * cruda a proposito: si una version futura agrega una etiqueta, el cliente
   * la trata como "algo espera" en vez de perderla.
   */
  waitingFor: string | null;
}

/** Cambio de estado sin eventos: por ejemplo, el archivo aparecio. */
export interface ServerConversationStateMessage {
  type: 'conversation.state';
  terminalId: TerminalId;
  state: ConversationState;
}

/**
 * Los planes que escribio esta conversacion.
 *
 * Se manda entera al suscribirse y cada vez que aparece uno nuevo. La lista es
 * de tres o cuatro entradas de un par de campos, asi que reenviarla completa
 * sale mas barato que ensenarle al cliente a fusionar.
 */
export interface ServerConversationPlansMessage {
  type: 'conversation.plans';
  terminalId: TerminalId;
  plans: SessionPlan[];
}

/** El contenido de un plan, recortado y listo para renderizar. */
export interface ServerPlanContentMessage {
  type: 'plans.content';
  terminalId: TerminalId;
  plan: PlanContent;
}

/**
 * Modelo y esfuerzo anunciados por la configuracion.
 *
 * A diferencia del resto, un valor ausente o mal formado no invalida el
 * mensaje: es un dato de conveniencia. Sin el, el combo vuelve a "sin datos",
 * que es exactamente lo que mostraba antes de que existiera.
 */
export function parseAgentDefaults(value: unknown): AgentDefaults {
  const empty: AgentDefaults = { model: null, effort: null, contextWindow: null };
  if (typeof value !== 'object' || value === null) return empty;
  const record = value as Record<string, unknown>;
  return {
    model: asNonEmptyString(record['model']),
    effort: asNonEmptyString(record['effort']),
    contextWindow: asFiniteNumber(record['contextWindow']),
  };
}

/**
 * La lista de subagentes que siguen trabajando, filtrada y con tope. null si no
 * es una lista. Uno que este lado no entiende se descarta solo.
 */
export function parseSubagentList(value: unknown): ConversationSubagent[] | null {
  return asArrayFiltered(value, parseConversationSubagent)?.slice(0, MAX_REPORTED_SUBAGENTS) ?? null;
}

/** La cola de una pestana, o null si no es una lista. Un mensaje que no se entiende se descarta solo. */
export function parseQueue(value: unknown): QueuedPrompt[] | null {
  return asArrayFiltered(value, parseQueuedPrompt)?.slice(0, MAX_QUEUED_PROMPTS) ?? null;
}

/** La pregunta leida de la pantalla (§5.5.4), o null si no es una pregunta. */
export function parseLiveQuestion(value: unknown): ConversationQuestionPart | null {
  const part = parseConversationPart(value);
  return part !== null && part.kind === 'question' ? part : null;
}

/** Every client message of this family. */
export type ClientConversationMessage =
  | ClientSubscribeConversationMessage
  | ClientUnsubscribeConversationMessage
  | ClientLoadMoreConversationMessage
  | ClientConversationImageMessage
  | ClientReadPlanMessage;

/** Every server message of this family. */
export type ServerConversationMessage =
  | ServerConversationResetMessage
  | ServerConversationAppendMessage
  | ServerConversationModeMessage
  | ServerConversationWaitingMessage
  | ServerConversationToolCallMessage
  | ServerConversationSubagentsMessage
  | ServerConversationQueueMessage
  | ServerConversationLiveQuestionMessage
  | ServerConversationPageMessage
  | ServerConversationStateMessage
  | ServerConversationTurnsMessage
  | ServerConversationPartsMessage
  | ServerConversationImageMessage
  | ServerConversationPlansMessage
  | ServerPlanContentMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientConversationMessage(record: UnknownRecord): ClientConversationMessage | null | undefined {
  switch (record['type']) {
    case 'conversation.subscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'conversation.subscribe', terminalId };
    }
    case 'conversation.unsubscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'conversation.unsubscribe', terminalId };
    }
    case 'conversation.loadMore': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const beforeEventId = asNonEmptyString(record['beforeEventId']);
      const limit = asPositiveInt(record['limit']);
      return terminalId === null || beforeEventId === null || limit === null
        ? null
        : { type: 'conversation.loadMore', terminalId, beforeEventId, limit };
    }
    case 'conversation.image': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const eventId = asNonEmptyString(record['eventId']);
      const index = asFiniteNumber(record['index']);
      // Sin `source` es una imagen del propio mensaje, que es lo unico que
      // habia antes de que existieran las dos formas.
      const source = asLiteral(record['source'], CONVERSATION_IMAGE_SOURCES) ?? 'content';
      return terminalId === null || eventId === null || index === null || index < 0
        ? null
        : { type: 'conversation.image', terminalId, eventId, index, source };
    }
    case 'plans.read': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const fileName = asNonEmptyString(record['fileName']);
      return terminalId === null || fileName === null
        ? null
        : { type: 'plans.read', terminalId, fileName };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerConversationMessage(record: UnknownRecord): ServerConversationMessage | null | undefined {
  switch (record['type']) {
    case 'conversation.reset': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // Vacio es valido: la pestana todavia no sabe su sesion. Ausente no.
      const sessionId = asString(record['sessionId']);
      const state = asLiteral(record['state'], CONVERSATION_STATES);
      /*
        Un evento que este lado no entiende —una parte nueva de un servidor mas
        nuevo— se descarta solo, no se lleva la conversacion entera con el.
        Igual en `append` y en `page`.
      */
      const events = asArrayFiltered(record['events'], parseConversationEvent);
      const usage = parseContextUsage(record['usage']);
      return terminalId === null ||
        sessionId === null ||
        state === null ||
        events === null ||
        usage === null
        ? null
        : {
            type: 'conversation.reset',
            terminalId,
            sessionId,
            state,
            events,
            hasMore: record['hasMore'] === true,
            usage,
            permissionMode: isPermissionMode(record['permissionMode'])
              ? record['permissionMode']
              : null,
            defaults: parseAgentDefaults(record['defaults']),
            waitingFor: asNonEmptyString(record['waitingFor']),
            // Ausente es false: un servidor anterior no bloquea nada.
            openToolCall: record['openToolCall'] === true,
            // Ausente es ninguno: un servidor anterior no los sigue.
            subagents: parseSubagentList(record['subagents']) ?? [],
            // Ausente es vacia: un servidor anterior no muestra la cola (hito 45).
            queue: parseQueue(record['queue']) ?? [],
            // Ausente es ninguna: un servidor anterior no lee la pantalla (§5.5.4).
            liveQuestion: parseLiveQuestion(record['liveQuestion']),
          };
    }
    case 'conversation.liveQuestion': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // null es "ya no hay"; algo que no es una pregunta no se toma por null.
      const question = record['question'] === null ? null : parseLiveQuestion(record['question']);
      return terminalId === null || (record['question'] !== null && question === null)
        ? null
        : { type: 'conversation.liveQuestion', terminalId, question };
    }
    case 'conversation.subagents': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const subagents = parseSubagentList(record['subagents']);
      return terminalId === null || subagents === null
        ? null
        : { type: 'conversation.subagents', terminalId, subagents };
    }
    case 'conversation.queue': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const queue = parseQueue(record['queue']);
      return terminalId === null || queue === null ? null : { type: 'conversation.queue', terminalId, queue };
    }
    case 'conversation.append': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const events = asArrayFiltered(record['events'], parseConversationEvent);
      const usage = parseContextUsage(record['usage']);
      if (terminalId === null || events === null || usage === null) return null;
      const append: ServerConversationAppendMessage = {
        type: 'conversation.append',
        terminalId,
        events,
        usage,
        permissionMode: isPermissionMode(record['permissionMode']) ? record['permissionMode'] : null,
      };
      // Solo si vino y se entiende: ausente es "la cola no cambio", no "vacia".
      const queue = parseQueue(record['queue']);
      if (queue !== null) append.queue = queue;
      return append;
    }
    case 'conversation.mode': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const mode = record['mode'];
      return terminalId === null || !isPermissionMode(mode)
        ? null
        : { type: 'conversation.mode', terminalId, mode };
    }
    case 'conversation.waiting': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null
        ? null
        : {
            type: 'conversation.waiting',
            terminalId,
            // Cruda: una etiqueta nueva de una version futura tiene que llegar
            // igual, y el cliente ya sabe que no la conoce.
            waitingFor: asNonEmptyString(record['waitingFor']),
          };
    }
    case 'conversation.toolCall': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const open = asBoolean(record['open']);
      return terminalId === null || open === null
        ? null
        : { type: 'conversation.toolCall', terminalId, open };
    }
    case 'conversation.page': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const events = asArrayFiltered(record['events'], parseConversationEvent);
      return terminalId === null || events === null
        ? null
        : {
            type: 'conversation.page',
            terminalId,
            events,
            hasMore: record['hasMore'] === true,
          };
    }
    case 'conversation.turns': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const turns = asArrayOf(record['turns'], (value) => {
        const entry = asRecord(value);
        if (entry === null) return null;
        const eventId = asNonEmptyString(entry['eventId']);
        const durationMs = asFiniteNumber(entry['durationMs']);
        return eventId === null || durationMs === null ? null : { eventId, durationMs };
      });
      return terminalId === null || turns === null
        ? null
        : { type: 'conversation.turns', terminalId, turns };
    }
    case 'conversation.parts': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const updates = asArrayOf(record['updates'], (value) => {
        const entry = asRecord(value);
        if (entry === null) return null;
        const eventId = asNonEmptyString(entry['eventId']);
        const parts = asArrayOf(entry['parts'], parseConversationPart);
        return eventId === null || parts === null ? null : { eventId, parts };
      });
      return terminalId === null || updates === null
        ? null
        : { type: 'conversation.parts', terminalId, updates };
    }
    case 'conversation.imageData': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const eventId = asNonEmptyString(record['eventId']);
      const index = asFiniteNumber(record['index']);
      const mediaType = asString(record['mediaType']);
      if (terminalId === null || eventId === null || index === null || mediaType === null) {
        return null;
      }
      const data = record['data'];
      return {
        type: 'conversation.imageData',
        terminalId,
        eventId,
        index,
        source: asLiteral(record['source'], CONVERSATION_IMAGE_SOURCES) ?? 'content',
        mediaType,
        data: typeof data === 'string' ? data : null,
      };
    }
    case 'conversation.state': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const state = asLiteral(record['state'], CONVERSATION_STATES);
      return terminalId === null || state === null
        ? null
        : { type: 'conversation.state', terminalId, state };
    }
    case 'conversation.plans': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const plans = asArrayOf(record['plans'], parseSessionPlan);
      return terminalId === null || plans === null
        ? null
        : { type: 'conversation.plans', terminalId, plans };
    }
    case 'plans.content': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const plan = parsePlanContent(record['plan']);
      return terminalId === null || plan === null
        ? null
        : { type: 'plans.content', terminalId, plan };
    }
    default:
      return undefined;
  }
}
