/**
 * Connection level messages: the `hello` handshake, the agent list, the error envelope and its codes.
 */

import { AGENT_IDS, parseAgentInfo, type AgentId, type AgentInfo } from '../agents/agents.js';
import {
  asArrayFiltered,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asString,
  type UnknownRecord,
} from '../validation/narrowing.js';
import { parseServerText, type ServerText } from './server-text.js';

/**
 * Pide que el servidor vuelva a leer lo que cada CLI anuncia de su
 * configuracion (la status line) y conteste con `agents`. Es el boton
 * "Comprobar" del dialogo: el servidor tambien avisa solo cuando cambia.
 */
export interface ClientAgentsRefreshMessage {
  type: 'agents.refresh';
}

/** Primer mensaje tras conectar. Describe el entorno, no una terminal. */
export interface ServerHelloMessage {
  type: 'hello';
  protocolVersion: number;
  /**
   * Las CLIs que este servidor sabe lanzar, instaladas o no, en orden de
   * preferencia.
   *
   * Cada una trae si esta disponible, su version, el texto para cuando falta,
   * sus capacidades —lo que la interfaz dibuja o esconde para sus pestanas— y
   * el aviso de entorno que haya levantado. El caso que motivo ese aviso: si el
   * servidor arranco con `CLAUDE_CODE_CHILD_SESSION` heredado, el adaptador lo
   * quita del entorno de las pestanas —esa variable apaga el guardado del
   * JSONL— y lo anuncia con `child-session-marker`, para que la app no toque el
   * entorno de la CLI sin que se note.
   *
   * Una CLI que este cliente no conoce se descarta sola: no se lleva el resto
   * del mensaje.
   */
  agents: AgentInfo[];
  /** La primera disponible, o null si no hay ninguna: la UI no abre pestanas. */
  defaultAgent: AgentId | null;
  platform: string;
  /** Sugerencia de cwd para la primera pestana. */
  defaultCwd: string;
  /**
   * Nombre de la consola del sistema que se puede abrir en el panel derecho
   * ("PowerShell", "bash"), o null si no se encontro ninguna.
   *
   * Es el nombre y no un booleano porque la UI lo escribe en el boton: decir
   * "PowerShell" cuando eso es lo que se va a abrir vale mas que un rotulo
   * generico, y en macOS o Linux ese rotulo seria directamente falso.
   */
  shellName: string | null;
  /**
   * Esta ventana entro como **equipo remoto** (hito 37): con la credencial de
   * un equipo emparejado y no con el token del arranque. La interfaz esconde lo
   * que el servidor igual le negaria: administrar el acceso remoto y lo que abre
   * una ventana en el escritorio del anfitrion. Ausente —un servidor anterior—
   * es false.
   */
  remoteClient: boolean;
  /**
   * Este servidor contesta `files.check` (§6.33). Ausente —un servidor
   * anterior— es false, y la pagina no lo pregunta: el hilo queda sin enlaces a
   * archivos, como antes.
   */
  fileCheck: boolean;
  /**
   * Este servidor guarda un archivo editado en el visor (`files.write`, Hito
   * 46, §6.36). Ausente, un servidor anterior, es false: el visor no ofrece
   * Editar.
   */
  fileWrite: boolean;
}

/**
 * La lista de CLIs otra vez, fuera del `hello`.
 *
 * Existe porque lo que anuncia una CLI puede cambiar con el servidor andando:
 * si el usuario configura su status line, sus capacidades cambian. Misma forma
 * y mismo parser que en `hello`: una CLI que este cliente no conoce se descarta
 * sola. No sube `PROTOCOL_VERSION`: un cliente anterior ignora el mensaje.
 */
export interface ServerAgentsMessage {
  type: 'agents';
  agents: AgentInfo[];
  defaultAgent: AgentId | null;
}

export type ServerErrorCode =
  | 'cli-not-found'
  | 'shell-not-found'
  | 'spawn-failed'
  | 'bad-message'
  | 'unknown-terminal'
  /** La pestana existe pero no tiene CLI corriendo: dormida o terminada. */
  | 'terminal-asleep'
  | 'invalid-cwd'
  | 'too-many-terminals'
  | 'invalid-path'
  | 'read-failed'
  | 'submit-failed'
  | 'answer-failed'
  | 'mode-failed'
  | 'archive-failed'
  | 'notes-failed'
  | 'picker-failed'
  | 'memory-failed'
  /** Un pedido `vault.*` que no se pudo cumplir. El texto dice por que. */
  | 'vault-failed'
  /** Una continuacion en otra CLI que no se pudo armar. El texto dice por que. */
  | 'continue-failed'
  /** Un `search.global` que no se pudo hacer (no la sesion que no se leyo: esa se salta). */
  | 'search-failed'
  /** Un pedido `remote.*` que no se pudo cumplir. El texto dice por que. */
  | 'remote-failed'
  /** Un cambio de Ajustes (Hito 41) que no se pudo guardar. El texto dice por que. */
  | 'settings-failed'
  /** Un `agent.rewind` que no se pudo hacer (hito 44). El menu de la CLI quedo cerrado. */
  | 'rewind-failed'
  /** Un `agent.forceSend` que no se hizo (hito 45). No se escribio nada en la pty. */
  | 'force-send-failed'
  /**
   * Un `agent.editQueue` que no se hizo (§6.35.1). El texto dice por que y
   * donde quedo el mensaje: en la cola, en la caja de la CLI o ya entregado.
   */
  | 'queue-edit-failed'
  /** Un `files.write` que no se pudo hacer (Hito 46). El archivo quedo como estaba. */
  | 'write-failed'
  /** Un pedido `worktree.*` que no se pudo cumplir (hito 48). El texto dice por que. */
  | 'worktree-failed'
  /** Un pedido que a un equipo remoto no se le atiende (hito 37). No se hizo nada. */
  | 'remote-refused'
  /**
   * La CLI de la pestana no tiene esa accion —o se pidio una CLI que el
   * servidor no conoce—. Va aparte de `mode-failed` y compania porque no es un
   * fallo: es algo que no existe, y no se escribio nada en la pty.
   */
  | 'agent-unsupported'
  | 'internal';

export const SERVER_ERROR_CODES: readonly ServerErrorCode[] = [
  'cli-not-found',
  'shell-not-found',
  'spawn-failed',
  'bad-message',
  'unknown-terminal',
  'terminal-asleep',
  'invalid-cwd',
  'too-many-terminals',
  'invalid-path',
  'read-failed',
  'submit-failed',
  'answer-failed',
  'mode-failed',
  'archive-failed',
  'notes-failed',
  'picker-failed',
  'memory-failed',
  'vault-failed',
  'continue-failed',
  'search-failed',
  'remote-failed',
  'settings-failed',
  'rewind-failed',
  'force-send-failed',
  'queue-edit-failed',
  'write-failed',
  'worktree-failed',
  'remote-refused',
  'agent-unsupported',
  'internal',
];

export interface ServerErrorMessage {
  type: 'error';
  code: ServerErrorCode;
  /** Lo que se le muestra al usuario, como clave: la web arma la frase en su idioma (§6.23). */
  text: ServerText;
  /** Para la consola del navegador. */
  detail?: string;
  /** Presente si el error responde a una peticion concreta. */
  requestId?: string;
}

/** Every client message of this family. */
export type ClientConnectionMessage =
  | ClientAgentsRefreshMessage;

/** Every server message of this family. */
export type ServerConnectionMessage =
  | ServerHelloMessage
  | ServerAgentsMessage
  | ServerErrorMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientConnectionMessage(record: UnknownRecord): ClientConnectionMessage | null | undefined {
  switch (record['type']) {
    case 'agents.refresh':
      return { type: 'agents.refresh' };
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerConnectionMessage(record: UnknownRecord): ServerConnectionMessage | null | undefined {
  switch (record['type']) {
    case 'hello': {
      const protocolVersion = asFiniteNumber(record['protocolVersion']);
      const platform = asString(record['platform']);
      const defaultCwd = asString(record['defaultCwd']);
      if (protocolVersion === null || platform === null || defaultCwd === null) return null;
      return {
        type: 'hello',
        protocolVersion,
        // Filtrada y no estricta: una CLI que este lado no conoce no puede
        // llevarse el `hello` entero, y con el la plataforma y el cwd.
        agents: asArrayFiltered(record['agents'], parseAgentInfo) ?? [],
        defaultAgent: asLiteral(record['defaultAgent'], AGENT_IDS),
        platform,
        defaultCwd,
        shellName: asNonEmptyString(record['shellName']),
        remoteClient: record['remoteClient'] === true,
        fileCheck: record['fileCheck'] === true,
        fileWrite: record['fileWrite'] === true,
      };
    }
    case 'agents': {
      // Como en `hello`: filtrada, y un mensaje sin lista no dice nada.
      const agents = asArrayFiltered(record['agents'], parseAgentInfo);
      return agents === null
        ? null
        : { type: 'agents', agents, defaultAgent: asLiteral(record['defaultAgent'], AGENT_IDS) };
    }
    case 'error': {
      const text = parseServerText(record['text']);
      if (text === null) return null;
      const code = asLiteral(record['code'], SERVER_ERROR_CODES) ?? 'internal';
      const parsed: ServerErrorMessage = { type: 'error', code, text };
      const detail = asString(record['detail']);
      if (detail !== null) parsed.detail = detail;
      const requestId = asNonEmptyString(record['requestId']);
      if (requestId !== null) parsed.requestId = requestId;
      return parsed;
    }
    default:
      return undefined;
  }
}
