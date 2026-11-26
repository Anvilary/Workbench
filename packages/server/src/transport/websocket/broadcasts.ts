/**
 * Server wide events fanned out to every socket.
 *
 * Registry, index, conversation, repository, worktree, settings and remote
 * access events are broadcast with the terminal id attached and each client
 * discards what it is not looking at. This module only translates events into
 * protocol messages; the state they describe belongs to the feature that emits
 * them.
 */

import {
  REMOTE_REVOKED_CLOSE_CODE,
  isEmptyComposerDraft,
  type AppSettingsStatus,
  type ContextUsage,
  type ConversationEvent,
  type ConversationQuestionPart,
  type ConversationState,
  type ConversationSubagent,
  type GitStatus,
  type IndexStatus,
  type MemoryStatus,
  type PermissionMode,
  type ProjectSummary,
  type QueuedPrompt,
  type SessionPlan,
  type TerminalActivity,
  type TerminalId,
  type TerminalOfflineReason,
} from '@anvilary/workbench-shared';
import type { PartsUpdate } from '../../agents/adapter.js';
import { draftEntriesOf } from '../../features/composer/draft-store.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalCommands } from './terminal-commands.js';
import type { TerminalHistoryAccess } from './terminal-history-access.js';

export interface ServerEventDeps {
  services: Pick<
    WorkbenchServices,
    | 'registry'
    | 'index'
    | 'conversations'
    | 'repos'
    | 'memory'
    | 'worktrees'
    | 'agents'
    | 'planLimits'
    | 'vault'
    | 'remote'
    | 'appSettings'
    | 'queuedSubmits'
    | 'drafts'
    | 'draftTabs'
  >;
  hub: Pick<SocketHub, 'broadcast' | 'broadcastToHost' | 'remoteSockets'>;
  history: Pick<
    TerminalHistoryAccess,
    'historyBindings' | 'refreshHistoryBindings' | 'retireMissingStores' | 'getHistoryStore'
  >;
  commands: Pick<TerminalCommands, 'defaultsFor' | 'agentsMessage'>;
}

/** Subscribe to every server wide event. Returns the function that removes the subscriptions. */
export function wireServerEvents(deps: ServerEventDeps): () => void {
  const { registry, index, conversations, repos, memory, worktrees, agents, planLimits, vault, remote, appSettings, queuedSubmits, drafts, draftTabs } =
    deps.services;
  const { broadcast, broadcastToHost, remoteSockets } = deps.hub;
  const { historyBindings, refreshHistoryBindings, retireMissingStores, getHistoryStore } = deps.history;
  const { defaultsFor, agentsMessage } = deps.commands;

  // ---- eventos del registro y del indice, hacia todos los clientes ----

  const onRegistryChanged = (): void => {
    refreshHistoryBindings();
    const terminals = registry.list();
    retireMissingStores();
    broadcast({ type: 'terminal.list', terminals, order: registry.getOrder() });
    const { appeared, moved } = draftTabs.update(terminals);
    for (const { from, to } of moved) drafts.move(from, to);
    // De una pestana nueva, solo los que hay: ninguna ventana tiene nada viejo que vaciar.
    const entries = draftEntriesOf(appeared, drafts).filter((entry) => !isEmptyComposerDraft(entry.draft));
    if (entries.length > 0) broadcast({ type: 'composer.drafts', drafts: entries });
  };

  const onRegistryExit = (
    terminalId: TerminalId,
    exitCode: number | null,
    signal: number | null,
  ): void => {
    // A lost supervisor cannot supply a real exit code. The following list snapshot marks it unavailable.
    if (exitCode !== null) broadcast({ type: 'terminal.exit', terminalId, exitCode, signal });
  };

  /*
    Que esta haciendo la CLI de cada pestana. Va a todos los clientes y no solo
    al que mira esa pestana: lo dibuja la barra de pestanas, que las muestra
    todas a la vez.
  */
  const onRegistryActivity = (
    terminalId: TerminalId,
    activity: TerminalActivity,
    offlineReason: TerminalOfflineReason | null,
  ): void => {
    // Libre o sin proceso: el turno termino solo y lo que habia en cola ya se entrego.
    if (activity === 'idle' || activity === 'offline') queuedSubmits.forget(terminalId);
    broadcast(
      offlineReason === null
        ? { type: 'terminal.activity', terminalId, activity }
        : { type: 'terminal.activity', terminalId, activity, offlineReason },
    );
    // Hito 49: el revisor empezo o termino. La fila de su rama vuelve a preguntar.
    if (registry.get(terminalId)?.review === true) worktrees.reviewActivity();
  };

  const onIndexStatus = (status: IndexStatus): void =>
    broadcast({ type: 'index.status', status });

  const onIndexProjects = (projects: ProjectSummary[], replace: boolean): void =>
    broadcast({ type: 'index.projects', projects, replace });

  // Los eventos de conversacion se difunden con el terminalId puesto y cada
  // cliente descarta los que no esta mirando. Es el mismo criterio que la
  // salida de las terminales: el filtro vive en el cliente.
  const onConversationAppend = (
    terminalId: TerminalId,
    events: ConversationEvent[],
    usage: ContextUsage,
    permissionMode: PermissionMode | null,
    queue?: QueuedPrompt[],
  ): void => {
    // La cola va solo si cambio con estos mensajes (hito 45): ausente es "igual que antes".
    broadcast(
      queue === undefined
        ? { type: 'conversation.append', terminalId, events, usage, permissionMode }
        : { type: 'conversation.append', terminalId, events, usage, permissionMode, queue },
    );
    // Si el agente escribio en el JSONL, es probable que acabe de tocar
    // archivos. Es el refresco del panel de cambios "al terminar un turno".
    repos.onConversationActivity(terminalId);
    // Hito 49: el revisor escribio algo, quizas su veredicto (sin estado publicado, Codex, es lo unico que avisa).
    if (registry.get(terminalId)?.review === true) worktrees.reviewActivity();
  };

  const onGitStatus = (terminalId: TerminalId, status: GitStatus): void => {
    broadcast({ type: 'git.status', terminalId, status });
    // Hito 48: un `git checkout` en la terminal cambia la etiqueta de rama de la pestana.
    const worktree = registry.get(terminalId)?.worktree ?? null;
    if (worktree !== null && status.state === 'ready' && status.branch !== worktree.branch) {
      void registry.refreshWorktrees(terminalId);
    }
  };

  /** Se creo, se quito, se volvio a abrir o se integro una rama aparte, o cambio una revision: el panel de Cambios de cada ventana vuelve a preguntar. */
  const onWorktreesChanged = (): void => broadcast({ type: 'worktree.changed' });

  const onMemoryStatus = (terminalId: TerminalId, status: MemoryStatus): void =>
    broadcast({ type: 'memory.status', terminalId, status });

  const onConversationState = (terminalId: TerminalId, state: ConversationState): void =>
    broadcast({ type: 'conversation.state', terminalId, state });

  const onConversationMode = (terminalId: TerminalId, mode: PermissionMode): void =>
    broadcast({ type: 'conversation.mode', terminalId, mode });

  /*
    La CLI empezo —o dejo— de esperar algo del usuario. No sale del JSONL: ahi
    un permiso pendiente no deja ninguna linea mientras espera.
  */
  const onConversationWaiting = (terminalId: TerminalId, waitingFor: string | null): void =>
    broadcast({ type: 'conversation.waiting', terminalId, waitingFor });

  /*
    Una CLI que no publica su estado abrio —o cerro— una llamada a herramienta.
    El cuadro de escritura lo usa para no dejar apretar Enviar mientras puede
    haber un menu de aprobacion esperando (A1 del hito 25).
  */
  const onConversationToolCall = (terminalId: TerminalId, open: boolean): void =>
    broadcast({ type: 'conversation.toolCall', terminalId, open });

  /*
    Los subagentes que siguen trabajando cambiaron (§4.15). El hilo lo muestra
    cuando el agente principal ya termino su turno y queda esperandolos.
  */
  const onConversationSubagents = (terminalId: TerminalId, subagents: ConversationSubagent[]): void =>
    broadcast({ type: 'conversation.subagents', terminalId, subagents });

  /*
    La pregunta que la CLI tiene abierta, leida de su pantalla (§5.5.4):
    aparecio, cambio o se fue. El hilo la dibuja como una tarjeta mas.
  */
  const onConversationLiveQuestion = (terminalId: TerminalId, question: ConversationQuestionPart | null): void =>
    broadcast({ type: 'conversation.liveQuestion', terminalId, question });

  /*
    La cola de la CLI cambio sin mensajes nuevos (hito 45, §6.35): se mando uno
    con el agente trabajando, se forzo el envio, o la CLI quedo libre o sin
    proceso. Cuando la cambia un mensaje que llega, va dentro de su `append`.
  */
  const onConversationQueue = (terminalId: TerminalId, queue: QueuedPrompt[]): void =>
    broadcast({ type: 'conversation.queue', terminalId, queue });

  const onConversationPlans = (terminalId: TerminalId, plans: SessionPlan[]): void =>
    broadcast({ type: 'conversation.plans', terminalId, plans });

  const onConversationTurns = (
    terminalId: TerminalId,
    turns: { eventId: string; durationMs: number }[],
  ): void => broadcast({ type: 'conversation.turns', terminalId, turns });

  /*
    Un mensaje al que se le agrego la imagen que la CLI adjunto en la linea
    siguiente. Igual que las duraciones: llega despues del mensaje, y casi
    siempre pegado a el.
  */
  const onConversationParts = (terminalId: TerminalId, updates: PartsUpdate[]): void =>
    broadcast({ type: 'conversation.parts', terminalId, updates });

  /** El archivo se reemplazo: hay que rehacer la vista, no agregarle nada. */
  const onConversationReset = (terminalId: TerminalId): void => {
    const snapshot = conversations.getSnapshot(terminalId);
    if (snapshot === null) return;
    void defaultsFor(terminalId, snapshot.usage.lastModel).then((defaults) => {
      broadcast({
        type: 'conversation.reset',
        terminalId,
        sessionId: snapshot.sessionId,
        state: snapshot.state,
        events: snapshot.events,
        hasMore: snapshot.hasMore,
        usage: snapshot.usage,
        permissionMode: snapshot.permissionMode,
        defaults,
        waitingFor: snapshot.waitingFor,
        // El de ahora y no el del snapshot: leer la configuracion es asincrono,
        // y un aviso que salio mientras tanto no puede quedar pisado por uno viejo.
        openToolCall: conversations.isToolCallOpen(terminalId),
        subagents: conversations.getSubagents(terminalId),
        queue: conversations.getQueue(terminalId),
        liveQuestion: conversations.getLiveQuestion(terminalId),
      });
    });
  };

  // Almacena la salida del terminal en el historial persistente (Lane F).
  const onRegistryOutput = (terminalId: TerminalId, chunk: string): void => {
    const store = getHistoryStore(terminalId);
    if (store) {
      store.push(chunk);
    }
  };

  registry.on('output', onRegistryOutput);

  registry.on('changed', onRegistryChanged);

  registry.on('exit', onRegistryExit);

  registry.on('activity', onRegistryActivity);

  index.on('status', onIndexStatus);

  index.on('projects', onIndexProjects);

  conversations.on('append', onConversationAppend);

  conversations.on('state', onConversationState);

  conversations.on('reset', onConversationReset);

  conversations.on('mode', onConversationMode);

  conversations.on('waiting', onConversationWaiting);

  conversations.on('toolCall', onConversationToolCall);

  conversations.on('subagents', onConversationSubagents);

  conversations.on('liveQuestion', onConversationLiveQuestion);

  conversations.on('queue', onConversationQueue);

  conversations.on('turns', onConversationTurns);

  conversations.on('plans', onConversationPlans);

  conversations.on('parts', onConversationParts);

  repos.on('status', onGitStatus);

  memory.on('status', onMemoryStatus);

  worktrees.on('changed', onWorktreesChanged);

  // Hito 49: un revisor empezo o termino. Las filas vuelven a preguntar, igual que con un cambio.
  worktrees.on('rows', onWorktreesChanged);

  /*
    El usuario configuro —o quito— la status line de una CLI con la app abierta:
    cambian sus capacidades, o el medidor del plan (hito 47), y todas las
    ventanas tienen que dibujar lo nuevo sin recargar. Solo sondea la
    configuracion de las CLIs encontradas. Con Claude Code sola, desde el hito
    47, es un `stat` de su `settings.json` cada 2 s (§3.2.6).
  */
  const stopAgentChanges = agents.subscribeChanges(() => broadcast(agentsMessage()));

  const stopPlanLimits = planLimits.onChange(() => broadcast({ type: 'plan.limits', limits: planLimits.snapshot() }));

  // La copia propia avisa a todas las ventanas, y el servicio ya espacia los avisos.
  const stopVaultStatus = vault.onStatus((status) => broadcast({ type: 'vault.status', status }));

  const stopRemoteStatus = remote.onChange(() =>
    broadcastToHost({ type: 'remote.status', status: remote.status() }),
  );

  // Ajustes (Hito 41) avisa a todas las ventanas: el nombre de la consola nueva lo usan todas.
  const onAppSettingsStatus = (settings: AppSettingsStatus): void => broadcast({ type: 'settings.status', settings });

  appSettings.on('status', onAppSettingsStatus);

  /*
    Un equipo revocado, o el acceso apagado (null): sus ventanas se cierran ya.
    Con su codigo, para que la pagina deje de reconectar y lo diga. La
    credencial ya no entra, asi que reintentar no llevaria a nada.
  */
  const stopRemoteRevoked = remote.onRevoked((deviceId) => {
    for (const [socket, id] of remoteSockets) {
      if (deviceId === null || id === deviceId) {
        historyBindings.get(socket)?.clear();
        socket.close(REMOTE_REVOKED_CLOSE_CODE, 'revoked');
      }
    }
  });

  return () => {
    registry.off('output', onRegistryOutput);
    registry.off('changed', onRegistryChanged);
    registry.off('activity', onRegistryActivity);
    registry.off('exit', onRegistryExit);
    index.off('status', onIndexStatus);
    index.off('projects', onIndexProjects);
    conversations.off('append', onConversationAppend);
    conversations.off('state', onConversationState);
    conversations.off('reset', onConversationReset);
    conversations.off('turns', onConversationTurns);
    conversations.off('plans', onConversationPlans);
    conversations.off('parts', onConversationParts);
    conversations.off('mode', onConversationMode);
    conversations.off('waiting', onConversationWaiting);
    conversations.off('toolCall', onConversationToolCall);
    conversations.off('subagents', onConversationSubagents);
    conversations.off('liveQuestion', onConversationLiveQuestion);
    conversations.off('queue', onConversationQueue);
    repos.off('status', onGitStatus);
    memory.off('status', onMemoryStatus);
    worktrees.off('changed', onWorktreesChanged);
    worktrees.off('rows', onWorktreesChanged);
    stopAgentChanges();
    stopPlanLimits();
    stopVaultStatus();
    appSettings.off('status', onAppSettingsStatus);
    stopRemoteStatus();
    stopRemoteRevoked();
  };
}
