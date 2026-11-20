/**
 * The application services the socket transport talks to.
 *
 * `createWorkbenchServices` takes what the host (`index.ts`) injects, creates
 * the private defaults for anything that was not injected, and wires the
 * services that depend on each other (tab coordinator, activity tracking).
 * Handlers never create services; they receive the ones they declare.
 */

import type { ServerMessage, TerminalId } from '@agent-workbench/shared';
import type { AgentRegistry } from '../../agents/registry.js';
import { AgentsUsageCollector } from '../../agents/usage/collector.js';
import { BrowserProfileStore } from '../../features/browser/browser-profile-store.js';
import { BrowserTabAdapter } from '../../features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from '../../features/browser/browser-tab-store.js';
import { DraftTabs, type DraftStore } from '../../features/composer/draft-store.js';
import { PasteStore } from '../../features/composer/paste-store.js';
import { QueuedSubmitBook } from '../../features/composer/queued-submits.js';
import type { ConversationHub } from '../../features/conversations/conversation-hub.js';
import { PlanLimitsBoard } from '../../features/conversations/plan-limits-board.js';
import { EditorTabAdapter } from '../../features/editor/editor-tab-adapter.js';
import { EditorTabStore } from '../../features/editor/editor-tab-store.js';
import type { RepoHub } from '../../features/git/repo-hub.js';
import type { ArchivedSessions } from '../../features/history/archived-sessions.js';
import type { ClassicWorkbenchLifecycle } from '../../features/history/classic-workbench-lifecycle.js';
import type { SessionIndex } from '../../features/history/session-index.js';
import type { MemoryHub } from '../../features/memory/memory-hub.js';
import type { NotesStore } from '../../features/notes/notes-store.js';
import { ChatGPTActivityProvider } from '../../features/notifications/browser-activity-provider.js';
import { AgencyNotificationStore } from '../../features/notifications/notification-store.js';
import { TabActivityManager } from '../../features/notifications/tab-activity-manager.js';
import { AgencyProfileStore } from '../../features/profiles/profile-store.js';
import type { RemoteAccessService } from '../../features/remote-access/remote-access-service.js';
import type { NativeIdentities } from '../../features/sessions/native-identity.js';
import { AgencySessionRuntime } from '../../features/sessions/session-runtime.js';
import type { AppSettingsService } from '../../features/settings/app-settings-service.js';
import { TerminalHistoryStore } from '../../features/terminals/terminal-history-store.js';
import type { TerminalRegistry } from '../../features/terminals/terminal-registry.js';
import { TerminalWriteQueue } from '../../features/terminals/terminal-write-queue.js';
import type { VaultService } from '../../features/vault/service.js';
import { AgencyLayoutStore } from '../../features/workspaces/layout-store.js';
import { AgencyTabCoordinator } from '../../features/workspaces/tab-coordinator.js';
import { WorkspaceMutex } from '../../features/workspaces/workspace-lock.js';
import { AgencyWorkspaceStore } from '../../features/workspaces/workspace-store.js';
import type { WorktreeService } from '../../features/worktrees/service.js';

/** What the host injects. Anything optional gets a private default and is flushed on shutdown. */
export interface WorkbenchServiceOptions {
  /** When true, MAW_UNSAFE_LOCAL_NO_AUTH=1 is active; skip token check on WS upgrade. */
  noAuth?: boolean;
  /** La consola de las nuevas y las CLIs apagadas (`settings.*`, Hito 41, §6.32). */
  appSettings: AppSettingsService;
  registry: TerminalRegistry;
  index: SessionIndex;
  classicLifecycle?: ClassicWorkbenchLifecycle;
  archived: ArchivedSessions;
  notes: NotesStore;
  /** Los borradores del cuadro de escritura, entre arranques (§6.29). */
  drafts: DraftStore;
  conversations: ConversationHub;
  repos: RepoHub;
  /** Memoria compartida del proyecto de cada pestana (`memory.*`). */
  memory: MemoryHub;
  /**
   * Las CLIs registradas. Se anuncian en `hello`, y de la de cada pestana sale
   * lo que esa pestana puede hacer: cada accion que la CLI no declara se
   * rechaza con `agent-unsupported` antes de escribir nada en la pty.
   */
  agents: AgentRegistry;
  defaultCwd: string;
  /** Donde aterrizan las imagenes pegadas. Inyectable para las pruebas. */
  pasteStore?: PasteStore;
  /** Injectable persistence factory for isolated history tests. */
  historyStoreFactory?: (terminalId: TerminalId) => TerminalHistoryStore;
  /** La copia propia (`vault.*`, hito 28). */
  vault: VaultService;
  /** El acceso remoto (`remote.*`, hito 37): quien entra, y que se le niega al que entro como equipo. */
  remote: RemoteAccessService;
  /** Las ramas aparte (`worktree.*`, hito 48, §6.38). */
  worktrees: WorktreeService;
  agencyWorkspaceStore: AgencyWorkspaceStore;
  agencyBrowserProfileStore?: BrowserProfileStore;
  agencyProfileStore: AgencyProfileStore;
  agencyIdentities?: NativeIdentities;
  agencyRuntime: AgencySessionRuntime;
  workspaceLock: WorkspaceMutex;
  agencyNotificationStore?: AgencyNotificationStore;
  agencyActivityManager?: TabActivityManager;
  agencyBrowserTabs?: BrowserTabAdapter;
  agencyEditorTabs?: EditorTabAdapter;
  agencyLayoutStore?: AgencyLayoutStore;
  agentsUsageCollector?: AgentsUsageCollector;
}

export interface WorkbenchServices {
  readonly noAuth: boolean;
  readonly appSettings: AppSettingsService;
  readonly registry: TerminalRegistry;
  readonly index: SessionIndex;
  readonly classicLifecycle: ClassicWorkbenchLifecycle | undefined;
  readonly archived: ArchivedSessions;
  readonly notes: NotesStore;
  readonly drafts: DraftStore;
  readonly conversations: ConversationHub;
  readonly repos: RepoHub;
  readonly memory: MemoryHub;
  readonly agents: AgentRegistry;
  readonly defaultCwd: string;
  readonly vault: VaultService;
  readonly remote: RemoteAccessService;
  readonly worktrees: WorktreeService;
  readonly agencyWorkspaceStore: AgencyWorkspaceStore;
  readonly agencyProfileStore: AgencyProfileStore;
  readonly agencyIdentities: NativeIdentities | undefined;
  readonly agencyRuntime: AgencySessionRuntime;
  readonly workspaceLock: WorkspaceMutex;
  readonly agencyNotificationStore: AgencyNotificationStore;
  readonly agencyActivityManager: TabActivityManager;
  readonly agencyLayoutStore: AgencyLayoutStore;
  readonly agencyBrowserTabs: BrowserTabAdapter;
  readonly agencyBrowserProfileStore: BrowserProfileStore;
  readonly agencyEditorTabs: EditorTabAdapter;
  readonly agentsUsageCollector: AgentsUsageCollector;
  readonly pasteStore: PasteStore;
  /** Una fila de escrituras por terminal, compartida por todos los sockets. */
  readonly writeQueue: TerminalWriteQueue;
  readonly queuedSubmits: QueuedSubmitBook;
  readonly tabCoordinator: AgencyTabCoordinator;
  /** Resolves once the persisted workspace state is loaded and reconciled. `agency.*` requests wait for it. */
  readonly tabReady: Promise<void>;
  readonly projectMutations: WorkspaceMutex;
  readonly browserProfileMutations: WorkspaceMutex;
  readonly planLimits: PlanLimitsBoard;
  readonly draftTabs: DraftTabs;
}

export interface WorkbenchServiceHandle {
  readonly services: WorkbenchServices;
  readonly historyStoreFactory: ((terminalId: TerminalId) => TerminalHistoryStore) | undefined;
  /** Stop timers and flush the stores this module created itself. Injected stores belong to the host. */
  shutdown(): Promise<unknown>;
}

export function createWorkbenchServices(
  options: WorkbenchServiceOptions,
  broadcast: (message: ServerMessage) => void,
): WorkbenchServiceHandle {
  const {
    appSettings,
    registry,
    index,
    archived,
    notes,
    drafts,
    conversations,
    repos,
    memory,
    agents,
    defaultCwd,
    vault,
    remote,
    worktrees,
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock,
  } = options;

  const agencyNotificationStore = options.agencyNotificationStore ?? new AgencyNotificationStore();

  const agencyActivityManager = options.agencyActivityManager ?? new TabActivityManager({ notificationStore: agencyNotificationStore });

  const agencyLayoutStore = options.agencyLayoutStore ?? new AgencyLayoutStore();

  const chatgptProvider = new ChatGPTActivityProvider();

  agencyActivityManager.registerBrowserProvider(chatgptProvider);

  const agencyBrowserTabs = options.agencyBrowserTabs ?? new BrowserTabAdapter({ store: new BrowserTabStore(), workspaceStore: agencyWorkspaceStore });

  const agencyBrowserProfileStore = options.agencyBrowserProfileStore ?? new BrowserProfileStore();

  const projectMutations = new WorkspaceMutex();

  const browserProfileMutations = new WorkspaceMutex();

  const agencyEditorTabs = options.agencyEditorTabs ?? new EditorTabAdapter({
    store: new EditorTabStore(),
    workspaceStore: agencyWorkspaceStore,
    protectedDirsProvider: () => agents.protectedDirs(),
  });

  const agentsUsageCollector = options.agentsUsageCollector ?? new AgentsUsageCollector();

  const agencyReady = Promise.all([
    agencyNotificationStore.initialize(),
    agencyActivityManager.initialize(),
    agencyLayoutStore.initialize(),
    options.agencyBrowserProfileStore ? Promise.resolve() : agencyBrowserProfileStore.load(),
    options.agencyBrowserTabs ? Promise.resolve() : agencyBrowserTabs.restore(),
    options.agencyEditorTabs ? Promise.resolve() : agencyEditorTabs.restore(),
  ]);

  const pasteStore = options.pasteStore ?? new PasteStore();

  /*
    Una fila de escrituras por terminal, compartida por todos los sockets: lo
    que dos ventanas le mandan a la misma pestana tambien se turna. Ver
    `terminal-write-queue.ts`.
  */
  const writeQueue = new TerminalWriteQueue();

  /*
    Lo que el cuadro le mando a cada pestana de una CLI que devuelve a su editor
    los mensajes en cola al interrumpir (hito 43, `queued-submits.ts`). Con las
    demas CLIs no se anota nada.
  */
  const queuedSubmits = new QueuedSubmitBook();

  const tabCoordinator = new AgencyTabCoordinator(
    agencyRuntime,
    agencyBrowserTabs,
    agencyWorkspaceStore,
    broadcast,
    agencyLayoutStore,
    agencyEditorTabs,
    {
      closeTab: (workspaceId, tabId) => agencyActivityManager.closeTab(workspaceId, tabId),
      purgeWorkspace: async (workspaceId) => {
        await agencyActivityManager.purgeWorkspace(workspaceId);
        const removed = await agencyNotificationStore.purgeWorkspace(workspaceId);
        if (removed > 0) {
          broadcast({
            type: 'agency.notifications.snapshot',
            requestId: '',
            notifications: agencyNotificationStore.list(),
            activityStates: agencyActivityManager.snapshot(),
          });
        }
      },
    },
  );

  const hasOpenActivityTab = (workspaceId: import('@agent-workbench/shared').WorkspaceId, tabId: string): boolean => {
    if (!agencyWorkspaceStore.getWorkspace(workspaceId)) return false;
    return agencyRuntime.list(workspaceId).some(session => session.tab?.id === tabId && session.tab.current && !session.tab.closedAt) ||
      agencyBrowserTabs.listTabs(workspaceId).some(tab => tab.id === tabId) ||
      agencyEditorTabs.listTabs(workspaceId).some(tab => tab.id === tabId);
  };

  const tabReady = agencyReady.then(async () => {
    await tabCoordinator.restoreSelection();
    for (const session of agencyRuntime.list()) {
      if (session.tab?.current && !session.tab.closedAt) {
        await agencyActivityManager.ensureTab({ workspaceId: session.workspaceId, tabId: session.tab.id,
          sessionId: session.id, source: session.kind === 'agent' ? 'cli' : 'shell' });
      }
    }
    for (const tab of agencyBrowserTabs.listTabs()) {
      await agencyActivityManager.ensureTab({ workspaceId: tab.workspaceId, tabId: tab.id, source: 'browser' });
    }
    await agencyActivityManager.flushPendingNotifications(hasOpenActivityTab);
  });

  void tabReady.catch(error => console.error('[agency] state initialization failed:', String(error)));

  // Notification delivery retries are independent of any browser renderer.
  const notificationRetry = setInterval(() => {
    void tabReady.then(() => agencyActivityManager.flushPendingNotifications(hasOpenActivityTab)).catch(() => {});
  }, 5000);

  notificationRetry.unref();

  /*
    Las pestanas de un cambio al siguiente, por su borrador: el de una que
    aparece va a todas las ventanas —la restauracion del arranque llega despues
    de que la pagina se conecto—, y el de una que cambia de conversacion se muda
    con ella, que es con lo que se va a guardar.
  */
  const draftTabs = new DraftTabs();

  draftTabs.update(registry.list());

  /*
    Los limites del plan de cada CLI encontrada que los publica (hito 47,
    §6.37). Son de la cuenta, no de una pestana: van a todas las ventanas. Las
    fuentes que sondean una carpeta solo lo hacen con alguna ventana conectada.
  */
  const planLimits = new PlanLimitsBoard(() =>
    agents
      .all()
      .flatMap(({ adapter, location }) =>
        location !== null && adapter.planLimits !== undefined ? [{ agent: adapter.id, source: adapter.planLimits }] : [],
      ),
  );

  return {
    services: {
      noAuth: options.noAuth === true,
      appSettings,
      registry,
      index,
      classicLifecycle: options.classicLifecycle,
      archived,
      notes,
      drafts,
      conversations,
      repos,
      memory,
      agents,
      defaultCwd,
      vault,
      remote,
      worktrees,
      agencyWorkspaceStore,
      agencyProfileStore,
      agencyIdentities: options.agencyIdentities,
      agencyRuntime,
      workspaceLock,
      agencyNotificationStore,
      agencyActivityManager,
      agencyLayoutStore,
      agencyBrowserTabs,
      agencyBrowserProfileStore,
      agencyEditorTabs,
      agentsUsageCollector,
      pasteStore,
      writeQueue,
      queuedSubmits,
      tabCoordinator,
      tabReady,
      projectMutations,
      browserProfileMutations,
      planLimits,
      draftTabs,
    },
    historyStoreFactory: options.historyStoreFactory,
    shutdown: () => {
      clearInterval(notificationRetry);
      const privateFlushes: Promise<unknown>[] = [];
      if (!options.agencyEditorTabs) privateFlushes.push(agencyEditorTabs.flush());
      if (!options.agencyBrowserProfileStore) privateFlushes.push(agencyBrowserProfileStore.flush());
      if (!options.agencyBrowserTabs) privateFlushes.push(agencyBrowserTabs.flush());
      if (!options.agencyLayoutStore) privateFlushes.push(agencyLayoutStore.flush());
      if (!options.agencyActivityManager) privateFlushes.push(agencyActivityManager.flush());
      if (!options.agencyNotificationStore) privateFlushes.push(agencyNotificationStore.flush());
      return Promise.allSettled(privateFlushes);
    },
  };
}
