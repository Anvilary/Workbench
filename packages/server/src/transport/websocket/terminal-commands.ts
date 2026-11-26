/**
 * Operations on terminals that more than one message family needs.
 *
 * These helpers translate a request about a terminal (write to it, interrupt
 * its agent, close its tab, describe its agent's input style) into calls on the
 * registry and the write queue, and report refusals to the requesting socket.
 * They hold no state of their own.
 */

import {
  serverText,
  type AgentDefaults,
  type ImageReferenceStyle,
  type ServerMessage,
  type ServerText,
  type TerminalId,
} from '@anvilary/workbench-shared';
import type { WebSocket } from 'ws';
import type { AgentAdapter, AgentInput } from '../../agents/adapter.js';
import type { DeliverDeps } from '../../features/composer/deliver-when-ready.js';
import { draftOwnerOf } from '../../features/composer/draft-store.js';
import {
  ANSWER_KEY_INTERVAL_MS,
  CLEAR_EDITOR,
  buildInterruptKeys,
  buildSubmissionWrites,
} from '../../features/composer/pty-input.js';
import { reclaimQueuedSubmits } from '../../features/composer/queued-submits.js';
import type { ContinueDeps } from '../../features/history/handoff.js';
import type { PieceWriter } from '../../features/terminals/terminal-write-queue.js';
import { debugLog } from '../../shared/debug.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalHistoryAccess } from './terminal-history-access.js';

/** Lo que se anuncia cuando no hay configuracion que leer. */
const NO_DEFAULTS: AgentDefaults = { model: null, effort: null, contextWindow: null };

/**
 * Como se escribe un envio en una pestana sin CLI conocida: el texto en un solo
 * pegado con el Enter al final, sin imagenes. Es lo que se hacia con cualquier
 * pestana antes de que cada CLI declarara su forma.
 */
const PLAIN_INPUT: AgentInput = {
  imageReference: null,
  pieceGapMs: 0,
  pasteMarkers: true,
  enterSeparately: false,
  interruptPresses: 1,
  transcriptReference: 'quoted-path',
};

export interface TerminalCommands {
  adapterOf(terminalId: TerminalId): AgentAdapter | null;
  imageStyleFor(socket: WebSocket, terminalId: TerminalId, unsupported: ServerText): ImageReferenceStyle | null;
  inputOf(terminalId: TerminalId): AgentInput;
  terminalListMessage(): ServerMessage;
  agentsMessage(): ServerMessage;
  writeToTerminal(socket: WebSocket, terminalId: TerminalId, data: string): boolean;
  defaultsFor(terminalId: TerminalId, sessionModel: string | null): Promise<AgentDefaults>;
  pieceWriter(socket: WebSocket, terminalId: TerminalId): PieceWriter;
  interruptAgent(socket: WebSocket, terminalId: TerminalId, options: { resend: boolean }): boolean;
  dropTab(terminalId: TerminalId): boolean;
  readonly deliverDeps: DeliverDeps;
  readonly continueDeps: ContinueDeps;
}

export interface TerminalCommandsDeps {
  services: Pick<
    WorkbenchServices,
    | 'registry'
    | 'agents'
    | 'writeQueue'
    | 'queuedSubmits'
    | 'conversations'
    | 'drafts'
    | 'repos'
    | 'memory'
    | 'pasteStore'
    | 'vault'
    | 'index'
  >;
  hub: Pick<SocketHub, 'send' | 'sendError' | 'broadcast'>;
  history: Pick<TerminalHistoryAccess, 'retireHistoryStore'>;
}

export function createTerminalCommands(deps: TerminalCommandsDeps): TerminalCommands {
  const { registry, agents, writeQueue, queuedSubmits, conversations, drafts, repos, memory, pasteStore, vault, index } =
    deps.services;
  const { send, sendError, broadcast } = deps.hub;
  const { retireHistoryStore } = deps.history;

  /** El adaptador de la CLI de una pestana de agente, o null. */
  const adapterOf = (terminalId: TerminalId): AgentAdapter | null => {
    const descriptor = registry.get(terminalId);
    if (descriptor === null || descriptor.kind !== 'agent' || descriptor.agent === null) return null;
    return agents.get(descriptor.agent)?.adapter ?? null;
  };

  /**
   * Como nombra imagenes la CLI de una pestana, o null despues de avisar por
   * que no se pueden mandar.
   *
   * Se pregunta **antes** de guardar nada en disco: una imagen que la CLI no va
   * a recibir no tiene por que dejar un temporal.
   */
  const imageStyleFor = (
    socket: WebSocket,
    terminalId: TerminalId,
    unsupported: ServerText,
  ): ImageReferenceStyle | null => {
    if (registry.get(terminalId) === null) {
      sendError(socket, 'unknown-terminal', serverText('terminalGone'));
      return null;
    }
    const style = adapterOf(terminalId)?.input.imageReference ?? null;
    if (style === null) sendError(socket, 'agent-unsupported', unsupported);
    return style;
  };

  /** Como se le escribe un envio a la CLI de una pestana. */
  const inputOf = (terminalId: TerminalId): AgentInput => adapterOf(terminalId)?.input ?? PLAIN_INPUT;

  const terminalListMessage = (): ServerMessage => ({
    type: 'terminal.list',
    terminals: registry.list(),
    order: registry.getOrder(),
  });

  /** La lista de CLIs fuera del `hello`: lo que anuncia una puede cambiar con el servidor andando. */
  const agentsMessage = (): ServerMessage => ({
    type: 'agents',
    agents: agents.list(),
    defaultAgent: agents.defaultAgent(),
  });

  /**
   * Escribe en una pty y explica bien cuando no se puede.
   *
   * Desde el hito 21 hay pestanas **sin proceso** —las que devuelve una
   * restauracion, y las que murieron con Ctrl+C— y para esas "la terminal ya no
   * existe" es falso: la pestana esta ahi, se lee, y lo que falta es la CLI.
   * El cliente distingue los dos casos por el codigo y ofrece abrirla.
   *
   * Lo que se teclea en la terminal no pasa por aca: a una pestana sin proceso
   * se descarta callado (ver `input`).
   */
  const writeToTerminal = (socket: WebSocket, terminalId: TerminalId, data: string): boolean => {
    if (registry.write(terminalId, data)) return true;
    if (registry.get(terminalId) === null) {
      sendError(socket, 'unknown-terminal', serverText('terminalGone'));
    } else {
      sendError(socket, 'terminal-asleep', serverText('terminalAsleep'));
    }
    return false;
  };

  /**
   * Modelo y esfuerzo que la configuracion anuncia para una pestana.
   *
   * Se lee en cada reset y no se cachea: son tres archivos chicos y un reset es
   * raro (suscribirse, o que el archivo de sesion se reemplace). Cachearlo
   * dejaria el combo mintiendo hasta reiniciar si el usuario edita su
   * configuracion.
   *
   * La lee el adaptador de la CLI de la pestana. Una consola no tiene CLI y no
   * anuncia nada: el cuadro de escritura solo se dibuja para pestanas de agente.
   */
  const defaultsFor = async (terminalId: TerminalId, sessionModel: string | null): Promise<AgentDefaults> => {
    const descriptor = registry.get(terminalId);
    const adapter = adapterOf(terminalId);
    if (descriptor === null || adapter === null) return NO_DEFAULTS;
    // Con el modelo de la sesion: el esfuerzo que se anuncia es el suyo (§5.4).
    return (await adapter.defaults(descriptor.cwd, sessionModel)) ?? NO_DEFAULTS;
  };

  /**
   * Lo que escribe cada pieza de un trabajo de la fila.
   *
   * Si la pestana desaparece a mitad, la fila corta ahi y se avisa una sola
   * vez: seguir escribiendo en una terminal que ya no esta no arregla nada.
   */
  const pieceWriter =
    (socket: WebSocket, terminalId: TerminalId): PieceWriter =>
    (piece) =>
      writeToTerminal(socket, terminalId, piece);

  /**
   * Interrumpe lo que la CLI de una pestana este haciendo: el boton Detener, y
   * "Forzar envio ahora" en la CLI que no tiene tecla para eso (hito 45, Pi,
   * §16.18). Esc no hace fila: tiene que llegar ya. Lo que faltaba escribir en
   * esa terminal se descarta antes, para que no caiga detras del Esc un Enter
   * que mande lo que el usuario acaba de interrumpir.
   *
   * Una CLI que al interrumpir devuelve a su editor lo que tenia en cola (hito
   * 43): cuando su historial cierre el turno, se vacia ese editor y el texto
   * vuelve al cuadro. Con `resend`, en vez de volver al cuadro se le manda de
   * nuevo a la CLI, que ya quedo libre: el agente lo lee como pedido nuevo.
   *
   * true si la primera tecla se escribio.
   */
  const interruptAgent = (socket: WebSocket, terminalId: TerminalId, options: { resend: boolean }): boolean => {
    writeQueue.interrupt(terminalId);
    const [first, ...rest] = buildInterruptKeys(inputOf(terminalId).interruptPresses);
    if (first === undefined || !writeToTerminal(socket, terminalId, first)) return false;
    const adapter = adapterOf(terminalId);
    /*
      La cola que llevaba la app ya no esta en la CLI (hito 45): Pi la devolvio a
      su editor, y de ahi vuelve al cuadro; o ya habia llegado al hilo. Al forzar
      el envio, en cambio, la burbuja sigue (marcada) hasta que el mensaje que se
      manda de nuevo aparece en el hilo: sin eso, quedaba un segundo sin ninguno
      de los dos (medido en vivo).
    */
    if (!options.resend && adapter?.queuedSubmits !== undefined && adapter.promptQueue?.source === 'app') {
      conversations.clearQueued(terminalId);
    }
    /*
      La lista se toma ya, antes de que el aviso de "libre" la olvide, y el
      trabajo va por la fila sin dejarse cortar: un envio que llegue justo
      despues cae detras de la tecla.
    */
    const reclaimFrom = adapter?.queuedSubmits;
    if (reclaimFrom !== undefined) {
      const taken = queuedSubmits.take(terminalId);
      const interruptedAt = Date.now();
      if (taken.length > 0) {
        void writeQueue.enqueue(
          terminalId,
          async (lane) => {
            const outcome = await reclaimQueuedSubmits({
              source: reclaimFrom,
              target: () => {
                const tab = registry.get(terminalId);
                return tab === null || !tab.alive || tab.sessionId.length === 0
                  ? null
                  : { cwd: tab.cwd, sessionId: tab.sessionId };
              },
              submissions: taken,
              interruptedAt,
              lastClearKeyAt: () => queuedSubmits.lastClearKeyAt(terminalId),
              writeClearKey: () => {
                if (!registry.write(terminalId, CLEAR_EDITOR)) return false;
                queuedSubmits.noteClearKey(terminalId, Date.now());
                return true;
              },
              prefill: options.resend
                ? async (returned) => {
                    // El mismo envio de un mensaje del cuadro, con lo que la CLI devolvio.
                    const input = inputOf(terminalId);
                    const pieces = buildSubmissionWrites(returned, [], input, { send: true });
                    if (pieces === null) return;
                    registry.noteSubmitted(terminalId, returned);
                    const written = await lane.writePieces(pieces, input.pieceGapMs, pieceWriter(socket, terminalId));
                    if (written === 'written') queuedSubmits.note(terminalId, returned, Date.now());
                    debugLog('write', `force send to ${terminalId.slice(0, 8)}: resent, ${written}`);
                  }
                : (returned) =>
                    send(socket, {
                      type: 'composer.prefill',
                      terminalId,
                      text: returned,
                      reason: reclaimFrom.returnReason,
                    }),
              // La CLI deshizo el mensaje sin escribirlo (hito 44): el hilo lo esconde desde el primero.
              withdraw: (eventIds) => {
                const first = eventIds[0];
                if (first !== undefined) conversations.withdraw(terminalId, first);
              },
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              now: Date.now,
            });
            debugLog('write', `queued messages of ${terminalId.slice(0, 8)} after an interrupt: ${outcome}`);
          },
          { interruptible: false },
        );
      }
    }
    /*
      Una CLI que pide mas de un Esc: el resto va por la fila, espaciado, y sin
      dejarse cortar. Por la fila para que un envio que llegue justo despues
      caiga detras del ultimo Esc y no entre dos; sin cortarse porque otro clic
      en interrumpir no deshace el primero. Con un solo Esc no se encola nada.
    */
    if (rest.length > 0) {
      void writeQueue.enqueue(
        terminalId,
        async (lane) => {
          await new Promise((resolve) => setTimeout(resolve, ANSWER_KEY_INTERVAL_MS));
          await lane.writePieces(rest, ANSWER_KEY_INTERVAL_MS, pieceWriter(socket, terminalId));
        },
        { interruptible: false },
      );
    }
    return true;
  };

  /**
   * Cierra una pestana y suelta todo lo que la seguia, para todos: el hub, git,
   * la memoria y lo que se pego en ella. Lo usan `terminal.close` y una
   * continuacion que abrio su pestana y no llego a servir. false si ya no estaba.
   */
  const dropTab = (terminalId: TerminalId): boolean => {
    const draftOwner = draftOwnerOf(registry.get(terminalId));
    if (!registry.close(terminalId)) return false;
    // Cerrar la pestana es tirar lo que quedo escrito en su cuadro (§6.29).
    if (draftOwner !== null) drafts.delete(draftOwner);
    // Sin pestana no hay nada que seguir, la mire quien la mire.
    conversations.drop(terminalId);
    repos.drop(terminalId);
    memory.drop(terminalId);
    queuedSubmits.drop(terminalId);
    // Cierra y descarta el almacen de historial persistente de esta pestana.
    retireHistoryStore(terminalId);
    // Las imagenes que se pegaron en esta pestana ya no le sirven a nadie: la
    // conversacion que las nombraba se fue con ella. Y el transcript de una
    // continuacion, tampoco (hito 29, D17).
    void pasteStore.clearTerminal(terminalId);
    broadcast({ type: 'terminal.closed', terminalId });
    return true;
  };

  /**
   * Mandarle un texto a la CLI de una pestana cuando esta lista: una nota, o la
   * continuacion de una conversacion (hito 29, M3). Ver `deliver-when-ready.ts`.
   */
  const deliverDeps: DeliverDeps = {
    describe: (terminalId) => registry.get(terminalId),
    onChanged: (listener) => {
      registry.on('changed', listener);
      return () => {
        registry.off('changed', listener);
      };
    },
    adapterOf,
    saveImage: async (terminalId, mediaType, data) => (await pasteStore.save(terminalId, mediaType, data)).path,
    noteSubmitted: (terminalId, text) => registry.noteSubmitted(terminalId, text),
    enqueue: (terminalId, job, enqueueOptions) => writeQueue.enqueue(terminalId, job, enqueueOptions),
  };

  /** Lo que la continuacion en otra CLI usa del servidor (hito 29). */
  const continueDeps: ContinueDeps = {
    registry,
    closeTab: (terminalId) => {
      dropTab(terminalId);
    },
    agents,
    index,
    pasteStore,
    // La copia propia, si tiene la sesion y sirve (D15). Con la copia apagada y
    // vacia no encuentra nada y lee el seguidor de la CLI.
    archive: { events: (agent, sessionId) => vault.handoffEvents(agent, sessionId) },
  };

  return {
    adapterOf,
    imageStyleFor,
    inputOf,
    terminalListMessage,
    agentsMessage,
    writeToTerminal,
    defaultsFor,
    pieceWriter,
    interruptAgent,
    dropTab,
    deliverDeps,
    continueDeps,
  };
}
