import { workbenchEnv } from '@anvilary/workbench-shared/env';
/**
 * Arranque de Agent Workbench.
 *
 * Un solo proceso: sirve la UI y el WebSocket en el mismo puerto. Eso no es
 * casualidad — con un unico origen, el chequeo de Origin y el token funcionan
 * igual en desarrollo y en produccion, sin excepciones que despues se olvidan
 * de sacar.
 */

import { TOKEN_QUERY_PARAM, type TerminalId } from '@anvilary/workbench-shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRegistry } from './agents/registry.js';
import { migrateConfigDir } from '../../../scripts/workbench/migrate-config.mjs';
import { migrateLegacyConfigDir } from './bootstrap/config-dir-migration.js';
import { openBrowser } from './bootstrap/open-browser.js';
import { ensurePtyHelperExecutable } from './bootstrap/pty-helper.js';
import { describeStartup, remoteAccessStartupLine } from './bootstrap/startup-summary.js';
import { BrowserProfileStore } from './features/browser/browser-profile-store.js';
import { BrowserTabAdapter } from './features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from './features/browser/browser-tab-store.js';
import { DraftStore, workspaceDraftOwners } from './features/composer/draft-store.js';
import { PasteStore } from './features/composer/paste-store.js';
import { ConversationHub } from './features/conversations/conversation-hub.js';
import { EditorTabAdapter } from './features/editor/editor-tab-adapter.js';
import { EditorTabStore } from './features/editor/editor-tab-store.js';
import { RepoHub } from './features/git/repo-hub.js';
import { ArchivedSessions } from './features/history/archived-sessions.js';
import { ClassicWorkbenchLifecycle } from './features/history/classic-workbench-lifecycle.js';
import { SessionIndex } from './features/history/session-index.js';
import { MemoryHub } from './features/memory/memory-hub.js';
import { NotesStore } from './features/notes/notes-store.js';
import { AgencyNotificationStore } from './features/notifications/notification-store.js';
import { TabActivityManager } from './features/notifications/tab-activity-manager.js';
import { buildAgencyProfileLaunch } from './features/profiles/profile-capabilities.js';
import { AgencyProfileStore } from './features/profiles/profile-store.js';
import { RemoteAccessService } from './features/remote-access/remote-access-service.js';
import { RemoteDevicesStore } from './features/remote-access/remote-devices-store.js';
import { NativeIdentities } from './features/sessions/native-identity.js';
import { nativeRecoveryCapacity } from './features/sessions/recovery-capacity.js';
import {
  AgencySessionRuntime,
  type AgencyProfileLaunchProvider,
  type AgencyWorkspaceSource,
} from './features/sessions/session-runtime.js';
import { SplitAgencySessionStore } from './features/sessions/session-store.js';
import { AppSettingsService } from './features/settings/app-settings-service.js';
import { SettingsStore } from './features/settings/settings-store.js';
import { OpenTabsStore } from './features/terminals/open-tabs-store.js';
import { locateShells, pickShell, type ShellLocation } from './features/terminals/shell-locator.js';
import { TerminalRegistry } from './features/terminals/terminal-registry.js';
import { VaultCatalog } from './features/vault/catalog.js';
import { defaultVaultDir } from './features/vault/paths.js';
import { VaultService } from './features/vault/service.js';
import { AgencyLayoutStore } from './features/workspaces/layout-store.js';
import { WorkspaceMutex } from './features/workspaces/workspace-lock.js';
import { AgencyWorkspaceStore } from './features/workspaces/workspace-store.js';
import { WorktreeLinks } from './features/worktrees/links.js';
import { WorktreeService } from './features/worktrees/service.js';
import { WorktreeStore } from './features/worktrees/store.js';
import { acquireStoreOwnership, publishReadiness, readReleaseIdentity } from './workbench-host.js';
import { createNoAuthMiddleware } from './security/no-auth-middleware.js';
import {
  LOOPBACK_HOST,
  applyFrameProtectionHeaders,
  createSessionToken,
  isLocalNoAuthEnabled,
} from './security/request-guards.js';
import { appConfigDir, configDirFor } from './shared/app-paths.js';
import { createAuthMiddleware } from './transport/http/auth-middleware.js';
import { isPortUnavailable, listenOnLoopback } from './transport/http/listen.js';
import { mountBuiltUi, mountDevUi } from './transport/http/ui-hosting.js';
import { attachWorkbenchSocket } from './transport/websocket/socket-server.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Verdadero solo dentro del paquete que se publica en npm. Lo inyecta esbuild
 * al empaquetar (`scripts/build-npm.mjs`); corriendo desde el repositorio la
 * variable no existe, y `typeof` sobre algo no declarado responde `undefined`
 * en vez de lanzar.
 *
 * Se decide al compilar y no mirando el disco, por lo mismo que `isProduction`
 * mas abajo: "si existe tal carpeta, entonces…" es justo lo que hace que un dia
 * arranque distinto sin que nadie sepa por que.
 *
 * Cambia tres cosas, las tres porque un paquete instalado no es este
 * repositorio: la interfaz compilada viaja al lado del servidor en vez de
 * `packages/web/dist`; el directorio por defecto es desde donde el usuario
 * corrio el comando; y no hay modo desarrollo que ofrecer, porque el paquete no
 * lleva ni las fuentes de la interfaz ni Vite.
 */
declare const __PACKAGED__: boolean | undefined;
const isPackaged = typeof __PACKAGED__ !== 'undefined' && __PACKAGED__ === true;

const webRoot = isPackaged ? serverDir : path.resolve(serverDir, '../../web');
const webDist = isPackaged ? path.join(serverDir, 'web') : path.join(webRoot, 'dist');
const repoRoot = path.resolve(serverDir, '../../..');

/**
 * Modo de servido de la interfaz.
 *
 * Explicito y no adivinado. La alternativa —"si existe `dist/`, servirlo"—
 * parece comoda hasta que alguien corre `pnpm build` una vez y a partir de ahi
 * `pnpm dev` deja de recargar en caliente sin decir por que.
 *
 * `pnpm dev` monta Vite; `pnpm start` sirve los archivos ya compilados.
 */
const isProduction = isPackaged || process.argv.includes('--prod');

/** Sugerencia de directorio para la primera pestana. */
function resolveDefaultCwd(): string {
  const override = workbenchEnv('CWD');
  if (override !== undefined && override.length > 0) return path.resolve(override);
  // Instalado desde npm, el comando se corre parado en el proyecto donde se va
  // a trabajar, y eso es exactamente `process.cwd()`. Desde el repositorio no
  // sirve: pnpm ejecuta el script dentro de packages/server.
  if (isPackaged) return process.cwd();
  return repoRoot;
}

async function main(): Promise<void> {
  const ownership = await acquireStoreOwnership(appConfigDir());
  const token = createSessionToken();
  const noAuth = isLocalNoAuthEnabled();
  const defaultCwd = resolveDefaultCwd();
  // Antes de que nadie lea la configuracion: si quedo en el directorio del
  // nombre viejo, se mueve al nuevo (ver `config-dir-migration.ts`).
  const configCopy = migrateConfigDir({ legacyDir: configDirFor('agent-workbench'), canonicalDir: appConfigDir() });
  if (configCopy.migrated) console.log('Previous Workbench settings copied to the canonical configuration directory.');
  const movedFrom = await migrateLegacyConfigDir();
  if (movedFrom !== null) console.log(`Configuration moved from ${movedFrom} to ${appConfigDir()}`);
  /*
    Los ajustes, antes que las CLIs (Hito 41): dicen cuales apago el usuario
    —esas no se buscan ni se lee su historial— y con que consola abre una nueva.
    Leer nunca escribe (`settings-store.ts`).
  */
  const settings = new SettingsStore();
  await settings.load();
  // Buscar las CLIs no bloquea el arranque: si falta, la UI lo explica. Las
  // consolas del pie se buscan a la vez y son opcionales: sin ninguna, el resto
  // de la app funciona igual.
  const agents = createAgentRegistry(settings.get().agents.disabled);
  const [, shells] = await Promise.all([agents.locateAll(), locateShells()]);
  const shell: ShellLocation | null = pickShell(shells, settings.get().console.shell);
  // Lo que cada CLI encontrada instala en la carpeta de la app: recien ahora,
  // con la carpeta ya en su lugar (A1 del hito 27).
  await agents.prepareAll();
  // Antes del primer `spawn`: en macOS node-pty llega con su binario auxiliar
  // sin permiso de ejecucion, y sin esto ninguna pestana abre (`pty-helper.ts`).
  ensurePtyHelperExecutable();

  const store = new OpenTabsStore();
  // Que sesiones escondio el usuario de la barra lateral. Se carga antes del
  // indice: si no, el primer envio las mostraria todas y desapareceria solas.
  const archived = new ArchivedSessions();
  await archived.load();
  /*
    La copia propia (hito 28), en este orden y todo antes de `index.start()`
    (C4): los ajustes dicen la carpeta, el catalogo lee sus cabeceras —con la
    copia apagada y sin carpeta, un `readdir` que falla y nada mas; no escribe—,
    el indice mezcla esas sesiones con las nativas al emitir, y el servicio
    decide cuando corre cada pasada.
  */
  const catalog = new VaultCatalog();
  await catalog.load(settings.get().vault.dir ?? defaultVaultDir());
  /*
    Las ramas aparte que creo la app (hito 48, §6.38). Antes del indice: de
    ahi sale en que proyecto cae la sesion de una rama ya quitada.
  */
  const worktreeStore = new WorktreeStore();
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);
  /*
    El indice lee el historial de cada CLI a traves de su adaptador, y al leer
    le ensena al adaptador lo que haga falta —con Claude Code, que variante de
    modelo usa la instalacion—. Va antes que el registro de terminales porque
    le dice de que CLI es una sesion que se reanuda.
  */
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });
  const registry = new TerminalRegistry(
    agents,
    shell,
    store,
    (sessionId) => index.agentOf(sessionId),
    (cwd) => worktreeLinks.tabWorktree(cwd),
  );
  const worktrees = new WorktreeService({
    store: worktreeStore,
    registry,
    projectCwd: (projectKey) => index.getProjects().find((project) => project.key === projectKey)?.cwd ?? null,
    findSession: (agent, sessionId) => index.find(agent, sessionId),
    // Hito 49: las conversaciones de una rama (para dejarle un pedido a su autor) y la respuesta del revisor.
    sessionsUnder: (folder) => {
      const root = path.resolve(folder);
      return index
        .getProjects()
        .flatMap((project) => project.sessions)
        .filter((session) => {
          if (session.archived || session.cwd.length === 0) return false;
          const relative = path.relative(root, path.resolve(session.cwd));
          return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });
    },
    history: (agent) => agents.get(agent)?.adapter.history ?? null,
  });
  // Crear o quitar una rama cambia en que proyecto cae cada sesion y la etiqueta de cada pestana.
  worktrees.on('changed', () => {
    void index.refreshWorktrees();
    void registry.refreshWorktrees();
  });
  // Hito 49: la conversacion de un revisor se anota cuando su CLI la descubre, haya o no una ventana mirando.
  registry.on('session', (terminalId: TerminalId) => {
    worktrees.noteReviewSession(terminalId).catch((error: unknown) => {
      console.warn(`[worktrees] couldn't note the review session of ${terminalId.slice(0, 8)}:`, error);
    });
  });
  // La consola de las nuevas y las CLIs apagadas, desde Ajustes (Hito 41, §6.32).
  const appSettings = new AppSettingsService({
    settings,
    agents,
    shells,
    onShellChange: (next) => registry.setShell(next),
  });
  // Notas sueltas del usuario. Se cargan antes de aceptar conexiones: el
  // primer mensaje de cada socket ya lleva la lista.
  const notes = new NotesStore();
  await notes.load();
  // Lo escrito y sin mandar en el cuadro de cada pestana (§6.29). Tambien antes
  // de aceptar conexiones: el primer mensaje de cada socket lleva los suyos.
  const drafts = new DraftStore();
  await drafts.load();
  /*
    Las conversaciones siguen cada sesion con el seguidor de su adaptador, y
    avisan que la CLI espera algo con el estado que publica ese mismo adaptador.
    El vigilante de estado y el registro de variantes son de cada adaptador y
    nadie mas los construye: un solo sondeo por CLI, y el medidor ve lo que
    aprendio el indice.
  */
  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  // Memoria compartida de cada proyecto: `.agents/memory/`. Es lo unico que
  // escribe dentro de un proyecto, y solo cuando el usuario lo confirma.
  const memory = new MemoryHub(registry);
  const pasteStore = new PasteStore();

  const classicLifecycle = new ClassicWorkbenchLifecycle({
    index,
    vault,
    conversations,
    agents,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    applyFrameProtectionHeaders(response);
    next();
  });

  const httpServer = createServer(app);

  /*
    Puerto efimero en loopback, como siempre. Con el acceso remoto encendido
    (hito 37), el puerto fijo de los ajustes: un tunel SSH necesita uno que no
    cambie. **Sigue siendo loopback**: el otro equipo llega por el tunel, no por
    la red. Si el fijo esta tomado —otra instancia de la app, otro programa— se
    cae al efimero y se avisa, antes que no arrancar.
  */
  const remoteSettings = settings.get().remote;
  let listeningFixed = false;
  let fixedPortBusy = false;
  if (noAuth && remoteSettings.enabled) {
    throw new Error(
      'WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1 cannot be used with remote access enabled.\n' +
      'Disable remote access in settings before starting in token-free mode.',
    );
  }
  if (remoteSettings.enabled) {
    try {
      await listenOnLoopback(httpServer, remoteSettings.port);
      listeningFixed = true;
    } catch (error) {
      if (!isPortUnavailable(error)) throw error;
      fixedPortBusy = true;
    }
  }
  if (!listeningFixed) await listenOnLoopback(httpServer, 0);

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error("Couldn't determine the assigned port.");
  }
  const { port } = address;
  if (noAuth && address.address !== LOOPBACK_HOST) {
    throw new Error(
      `WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1 requires binding exclusively to ${LOOPBACK_HOST}, got ${address.address}`,
    );
  }

  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(),
    listening: { port, fixed: listeningFixed, fixedPortBusy },
  });
  await remote.load();

  app.use(noAuth ? createNoAuthMiddleware(port) : createAuthMiddleware(port, token, remote));

  // Durable Agency stores and session runtime (Phase 2 & Phase 3)
  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(appConfigDir(), 'agency-state.json'));
  await agencyWorkspaceStore.load();

  const agencyBrowserProfileStore = new BrowserProfileStore(path.join(appConfigDir(), 'agency-browser-profiles.json'));
  await agencyBrowserProfileStore.load();

  const agencyIdentities = await NativeIdentities.loadForInteractive(path.join(appConfigDir(), 'agency-native-identities.json'));
  agents.protectNativeHomes(agencyIdentities.protectedDirs());
  const agencyProfileStore = new AgencyProfileStore(path.join(appConfigDir(), 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();

  const workspaceLock = new WorkspaceMutex();

  const agencyProfileLaunchProvider: AgencyProfileLaunchProvider = {
    async resolveLaunch(input) {
      const plan = await buildAgencyProfileLaunch(agencyProfileStore, agents, input, { identities: agencyIdentities });
      return {
        ...plan,
        launchToken: input.launchToken,
        proposedSessionId: input.proposedSessionId,
      };
    },
  };

  const agencyWorkspaceSource: AgencyWorkspaceSource = {
    protectedDirectories: () => agents.protectedDirs(),
    withSessionReservation: (id, action) =>
      workspaceLock.runExclusive(id, () => {
        const workspace = agencyWorkspaceStore.getWorkspace(id);
        const archived = workspace && agencyWorkspaceStore.listProjects().some(project => project.id === workspace.projectId && project.status === 'archived');
        return action(archived ? null : workspace);
      }),
  };

  await registry.initialize();
  const agencySessionStore = new SplitAgencySessionStore(path.join(appConfigDir(), 'agency-sessions.json'));
  const agencyRuntime = new AgencySessionRuntime({
    registry,
    workspaces: agencyWorkspaceSource,
    profiles: agencyProfileLaunchProvider,
    store: agencySessionStore,
  });
  await agencyRuntime.initialize();

  const agencyBrowserTabs = new BrowserTabAdapter({ store: new BrowserTabStore(), workspaceStore: agencyWorkspaceStore });
  await agencyBrowserTabs.restore();
  const agencyEditorTabs = new EditorTabAdapter({
    store: new EditorTabStore(),
    workspaceStore: agencyWorkspaceStore,
    protectedDirsProvider: () => agents.protectedDirs(),
  });
  await agencyEditorTabs.restore();
  const agencyNotificationStore = new AgencyNotificationStore();
  const agencyActivityManager = new TabActivityManager({ notificationStore: agencyNotificationStore });
  const agencyLayoutStore = new AgencyLayoutStore();
  await agencyNotificationStore.initialize();
  await agencyActivityManager.initialize();
  await agencyLayoutStore.initialize();

  // Administrative performance endpoint for local Workbench Resource Monitor
  app.get('/api/performance/terminals', (request: Request, response: Response) => {
    const clientIp = request.socket.remoteAddress;
    const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    if (!isLoopback) {
      response.status(403).json({ ok: false, error: 'Loopback access only' });
      return;
    }
    const reqAuth = (request as unknown as { workbenchCredential?: { kind: string } }).workbenchCredential;
    if (!reqAuth || (reqAuth.kind !== 'session' && reqAuth.kind !== 'local')) {
      response.status(reqAuth?.kind === 'device' ? 403 : 401).json({
        ok: false,
        error: reqAuth?.kind === 'device' ? 'Forbidden: paired devices cannot inspect processes' : 'Unauthorized: valid local session required',
      });
      return;
    }

    const list = registry.list();
    const terminals = list.map((descriptor) => {
      const pid = registry.pidOf(descriptor.terminalId);
      const identity = registry.nativeIdentityOf?.(descriptor.terminalId);
      return {
        terminalId: descriptor.terminalId,
        sessionId: descriptor.sessionId || null,
        title: descriptor.label,
        kind: descriptor.kind,
        agent: descriptor.agent,
        pid,
        cwd: descriptor.cwd,
        provider: identity?.provider ?? descriptor.agent ?? null,
      };
    });

    response.json({
      ok: true,
      backendPid: process.pid,
      supervisorPid: registry.supervisorPid,
      terminals,
    });
  });

  const closeUi = isProduction ? mountBuiltUi(app, webDist) : await mountDevUi(app, httpServer, webRoot);

  const detachSocket = attachWorkbenchSocket({
    agencyWorkspaceStore,
    agencyBrowserProfileStore,
    agencyProfileStore,
    agencyIdentities,
    agencyRuntime,
    agencyBrowserTabs,
    agencyEditorTabs,
    agencyNotificationStore,
    agencyActivityManager,
    agencyLayoutStore,
    workspaceLock,
    pasteStore,
    httpServer,
    port,
    token,
    appSettings,
    registry,
    index,
    classicLifecycle,
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
    noAuth,
  });

  // El indice arranca en segundo plano: 3,2 s en frio no pueden demorar la URL.
  /*
    Temporales de arranques anteriores.

    Un cierre sin gracia no pasa por el borrado de cada pestana, asi que la
    carpeta puede traer imagenes de la sesion pasada. Se limpia en segundo
    plano: nada del arranque depende de esto.
  */
  void pasteStore.purgeStale();

  if (workbenchEnv('EAGER_CLASSIC') === '1') {
    void classicLifecycle.ensureStarted();
  }

  /*
    Las pestanas del arranque anterior tambien van en segundo plano: relanzar
    varias sesiones lleva su tiempo y la UI las va viendo aparecer.

    Se cargan aunque no haya ninguna CLI disponible: la restauracion es la que
    guarda aparte las pestanas que no puede mostrar, y sin ella el primer cambio
    —abrir una consola— reescribiria el archivo sin ninguna.
  */
  if (workbenchEnv('NO_RESTORE') !== '1') {
    void store.load().then((state) => {
      /*
        Un borrador sin pestana en el archivo no lo va a pedir nadie: la cerro
        una build anterior, que no los borra, o su carpeta ya no existe (§6.29).
        Sin restaurar no se sabe cuales son, y no se toca ninguno.
      */
      drafts.retainOnly(workspaceDraftOwners(state));
      if (state.tabs.length === 0 && state.foreignTabs.length === 0) return;
      if (agents.anyAvailable()) {
        console.log(`Restoring ${state.tabs.length} tab(s) from the previous run...`);
      }
      return registry.restore(state);
    });
  }

  const url = noAuth
    ? `http://${LOOPBACK_HOST}:${port}/`
    : `http://${LOOPBACK_HOST}:${port}/?${TOKEN_QUERY_PARAM}=${token}`;
  void agencyRuntime.recoverActive(workspace => agencyWorkspaceStore.listProjects().some(project => project.id === workspace.projectId && project.status !== 'archived'), nativeRecoveryCapacity).catch(error => console.error('[maw] recovery stopped:', String(error)));
  const remoteStatus = remote.status();
  describeStartup(
    isProduction,
    workbenchEnv('RUNTIME_DIR') ? `http://${LOOPBACK_HOST}:${port}/ (use anvi-bench open)` : url,
    defaultCwd,
    agents,
    shell,
    remoteAccessStartupLine(remoteStatus.state, remoteStatus.port, remote.pairedDevices),
  );
  if (noAuth) {
    console.warn(
      '\n  ⚠  TOKEN-FREE LOCAL MODE (WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1)\n' +
      '  Any process on this machine that can reach 127.0.0.1 can access Anvilary Workbench.\n' +
      '  Anvilary Workbench executes shell commands. Loopback-only binding does not eliminate all risks.\n'
    );
  }
  const runtimeDir = workbenchEnv('RUNTIME_DIR')
    ?? (process.env['XDG_RUNTIME_DIR'] ? path.join(process.env['XDG_RUNTIME_DIR'], 'workbench') : null)
    ?? (typeof process.getuid === 'function' && existsSync(`/run/user/${process.getuid()}`) ? path.join(`/run/user/${process.getuid()}`, 'workbench') : null)
    ?? path.join(os.tmpdir(), 'workbench');
  const clearReadiness = await publishReadiness(runtimeDir, url, await readReleaseIdentity(repoRoot));
  // Escape para desarrollo y pruebas automatizadas: arrancar sin abrir nada.
  if (workbenchEnv('NO_OPEN') !== '1') openBrowser(url);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nClosing Anvilary Workbench...');

    classicLifecycle.dispose();
    const historyFlushed = detachSocket();
    conversations.disposeAll();
    /*
      Suelta los adaptadores ya, y la promesa espera lo que alguno tiene que
      terminar: el `serve` de OpenCode (hito 29), que corre sin consola
      compartida y no muere con el Ctrl+C. Nunca rechaza.
    */
    const agentsDisposed = agents.disposeAll();
    repos.disposeAll();
    void memory.disposeAll();
    // Los procesos no sobreviven al cierre; las pestanas si, en disco.
    agencyRuntime.dispose();
    registry.disposeAll();
    remote.dispose();

    void Promise.allSettled([
      historyFlushed,
      agencyBrowserTabs.flush(),
      agencyEditorTabs.flush(),
      agencyBrowserProfileStore.flush(),
      settings.flush(),
      store.flush(),
      agencySessionStore.flush(),
      agencyWorkspaceStore.flush(),
      agencyProfileStore.flush(),
      agencyActivityManager.flush(),
      agencyNotificationStore.flush(),
      agencyLayoutStore.flush(),
      clearReadiness(),
      archived.flush(),
      notes.flush(),
      drafts.flush(),
      remote.flush(),
      worktreeStore.flush(),
      agentsDisposed,
    ])
      .catch(() => undefined)
      .then(() => closeUi())
      .catch(() => undefined)
      .finally(() => {
        ownership?.close();
        httpServer.close(() => process.exit(0));
        // Si alguna conexion no cierra, no nos quedamos colgados.
        setTimeout(() => process.exit(0), 2_000).unref();
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  // Los errores de red y de spawn traen `code`/`errno` pero no `message`, y
  // salen como "{}" si se los imprime directo. Los desarmamos a mano.
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error, Object.getOwnPropertyNames(error))
        : String(error);
  console.error(`Anvilary Workbench couldn't start:\n${detail}`);
  process.exit(1);
});
