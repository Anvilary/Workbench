import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgencyAgentSession,
  AgencyRuntimeSession,
  AgencyWorkspace,
  CliProfileId,
  CliProvider,
  RuntimeSessionId,
  SessionActivity,
  WorkspaceId,
} from '@agent-workbench/shared';
import type { AgentId, TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { OpenTerminalOptions, TerminalRegistry } from '../terminal-registry.js';
import { isInsideProtected } from '../directory-picker.js';
import type { LaunchSession } from '../agents/adapter.js';
import type { NativeIdentity } from './native-identity.js';
import { AgencySessionStore } from './agency-session-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['starting', 'running', 'stopping']);
const NOW = (): string => new Date().toISOString();

export type AgencySessionCreateInput =
  | { workspaceId: WorkspaceId; kind: 'terminal'; cols: number; rows: number }
  | {
      workspaceId: WorkspaceId;
      kind: 'agent';
      profileId: CliProfileId;
      cols: number;
      rows: number;
      resumeNativeSessionId?: string;
      model?: string;
      effort?: string;
    };

export interface ValidatedNativeLaunch {
  /** Exact requested named profile. Cross-account fallback is forbidden. */
  profileId: CliProfileId;
  nativeIdentity?: NativeIdentity | null;
  provider: CliProvider;
  file: string;
  args: readonly string[];
  /** A fresh isolated environment approved by Lane B, never persisted here. */
  env: Record<string, string>;
  /** Lane B's original adapter.launch result, never synthesized by Lane C. */
  session: LaunchSession;
  /** Echo of the single preparation token, checked before spawning a PTY. */
  launchToken: string;
  /** Server-proposed UUID used only when the native adapter explicitly accepts it. */
  proposedSessionId: string;
  /** Lane B must return the same canonical cwd without relocation. */
  cwd: string;
  /** Values actually applied to the native invocation. Unconfirmed values stay null. */
  appliedModel?: string | null;
  appliedEffort?: string | null;
}

export interface AgencyProfileLaunchProvider {
  resolveLaunch(input: {
    profileId: CliProfileId;
    cwd: string;
    resumeNativeSessionId: string | null;
    proposedSessionId: string;
    launchToken: string;
    model?: string;
    effort?: string;
  }): Promise<ValidatedNativeLaunch>;
  /** Optional future native control. Must reject if a setting cannot actually be applied. */
  applySelection?(input: {
    profileId: CliProfileId;
    terminalId: string;
    nativeSessionId: string | null;
    model: string | null;
    effort: string | null;
  }): Promise<{ model: string | null; effort: string | null }>;
}

export interface AgencyWorkspaceSource {
  /** The same adapter-supplied protected CLI homes used by Lane A's picker. */
  protectedDirectories(): readonly string[];
  /**
   * Required integration-owner gate, shared with Lane A's guarded deletion.
   * Under the same per-workspace lock: load the canonical row, validate it,
   * reserve the Agency slot and durably save 'starting'. Only then release.
   * The deletion path MUST take the identical lock, and MUST reject every
   * historical/active Agency session reference while holding it.
   * A missing lock is unsafe; there is deliberately no unlocked fallback.
   */
  withSessionReservation<T>(
    workspaceId: WorkspaceId,
    action: (workspace: AgencyWorkspace | null) => Promise<T>,
  ): Promise<T>;
}

export type AgencyTerminalRegistry = Pick<
  TerminalRegistry,
  'open' | 'get' | 'list' | 'has' | 'close' | 'activityOf' | 'on' | 'off'
>;

export interface AgencyRuntimeOptions {
  registry: AgencyTerminalRegistry;
  workspaces: AgencyWorkspaceSource;
  profiles: AgencyProfileLaunchProvider;
  store?: AgencySessionStore;
}

/** Stable error codes are mapped by the integration owner to agency.error. */
export class AgencyRuntimeError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'not-found' | 'conflict' | 'invalid-directory' |
      'profile-unavailable' | 'unsupported-capability' | 'session-unavailable' | 'internal-error',
    message: string,
  ) {
    super(message);
    this.name = 'AgencyRuntimeError';
  }
}

function activityFor(activity: TerminalActivity | null): SessionActivity {
  switch (activity) {
    case 'busy': return 'working';
    case 'idle': return 'idle';
    case 'waiting': return 'awaiting-user';
    case 'offline': return 'offline';
    default: return 'unknown';
  }
}

function providerAgent(provider: CliProvider): AgentId {
  return provider;
}

function checkDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 ||
      !Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw new AgencyRuntimeError('invalid-request', 'Invalid terminal dimensions');
  }
}

function checkId(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AgencyRuntimeError('invalid-request', 'Invalid Agency ID');
  }
}

function validateLaunch(plan: ValidatedNativeLaunch): void {
  if (!['codex', 'claude-code', 'antigravity'].includes(plan.provider) ||
      typeof plan.file !== 'string' || plan.file.trim().length === 0 ||
      plan.file.includes('\0') || !Array.isArray(plan.args) ||
      !plan.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
      typeof plan.env !== 'object' || plan.env === null || Array.isArray(plan.env) ||
      typeof plan.cwd !== 'string' || typeof plan.launchToken !== 'string' ||
      typeof plan.proposedSessionId !== 'string' ||
      (plan.session?.kind !== 'discover' && (plan.session?.kind !== 'known' ||
        typeof plan.session.sessionId !== 'string' || plan.session.sessionId.length === 0)) ||
      !Object.entries(plan.env).every(([key, value]) =>
        typeof value === 'string' && !key.includes('\0') && !value.includes('\0'))) {
    throw new AgencyRuntimeError('profile-unavailable', 'Invalid validated CLI launch specification');
  }
}

/**
 * One controller for Agency metadata, one upstream TerminalRegistry for all PTYs.
 * No socket ownership, no second PTY, no new transport and no native API calls.
 */
export class AgencySessionRuntime extends EventEmitter {
  private readonly sessions = new Map<RuntimeSessionId, AgencyRuntimeSession>();
  private readonly store: AgencySessionStore;
  private readonly registry: AgencyTerminalRegistry;
  private readonly workspaces: AgencyWorkspaceSource;
  private readonly profiles: AgencyProfileLaunchProvider;
  private readonly byTerminal = new Map<TerminalId, RuntimeSessionId>();
  /** No two live Agency PTYs may control one provider-native conversation. */
  private readonly nativeClaims = new Map<string, RuntimeSessionId>();
  private initialized = false;
  private recoveryFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(options: AgencyRuntimeOptions) {
    super();
    this.registry = options.registry;
    this.workspaces = options.workspaces;
    this.profiles = options.profiles;
    this.store = options.store ?? new AgencySessionStore();
  }

  /** Called once after TerminalRegistry setup, before accepting Agency requests. */
  async initialize(): Promise<void> {
    if (this.initialized) throw new Error('Agency runtime already initialized');
    let changed = false;
    for (const previous of await this.store.load()) {
      const needsRecovery = ACTIVE.has(previous.lifecycle) || previous.recovery?.status === 'resuming';
      const session: AgencyRuntimeSession = needsRecovery ? {
        ...previous,
        lifecycle: 'exited',
        ...(previous.kind === 'agent' && previous.lifecycle !== 'stopping' ? { recovery: { status: 'pending' as const, message: null } } : {}),
        activity: 'offline',
        // A backend restart loses the owned PTY. No exit code can be inferred.
        exitCode: null,
        stoppedAt: previous.stoppedAt ?? NOW(),
        updatedAt: NOW(),
      } : previous;
      changed ||= needsRecovery;
      this.sessions.set(session.id, session);
    }
    if (changed) await this.persist();
    this.registry.on('exit', this.onExit);
    this.registry.on('activity', this.onActivity);
    this.registry.on('session', this.onNativeSession);
    this.initialized = true;
  }

  /** Startup only. Single-flight and sequential: never invoked by browser reconnect. */
  recoverActive(projectActive: (workspace: AgencyWorkspace) => boolean): Promise<void> {
    this.assertReady();
    if (this.recoveryFlight) return this.recoveryFlight;
    this.recoveryFlight = this.runRecovery(projectActive);
    return this.recoveryFlight;
  }

  private async runRecovery(projectActive: (workspace: AgencyWorkspace) => boolean): Promise<void> {
    for (const previous of [...this.sessions.values()]) {
      if (this.disposed) return;
      if (previous.kind !== 'agent' || previous.recovery?.status !== 'pending') continue;
      const recordOutcome = async (status: 'resuming' | 'resumed' | 'manual' | 'failed' | 'superseded', message: string | null) => {
        const next = { ...previous, recovery: { status, message }, updatedAt: NOW() };
        this.sessions.set(previous.id, next);
        await this.publish(next);
      };
      try {
        await this.workspaces.withSessionReservation(previous.workspaceId, async workspace => {
          if (!workspace || workspace.status !== 'active' || !projectActive(workspace)) throw new Error('Workspace or project is inactive');
          await this.assertSafeDirectory(workspace.cwd);
        });
        if (!previous.nativeIdentity || !previous.nativeSessionId) throw new Error('Manual resume required: native identity or conversation is unverified');
        if (previous.nativeIdentity.provider !== 'codex') throw new Error('Manual resume required: provider ownership validation unavailable');
        await recordOutcome('resuming', null);
        const resumed = await this.create({ kind: 'agent', workspaceId: previous.workspaceId,
          profileId: previous.profileId, resumeNativeSessionId: previous.nativeSessionId, cols: 100, rows: 30 });
        const next = { ...resumed, recovery: { status: 'resumed' as const, message: null } };
        this.sessions.set(next.id, next);
        await this.publish(next);
        await recordOutcome('superseded', null);
      } catch (error) {
        await recordOutcome('manual', error instanceof Error ? error.message : 'Native recovery failed');
      }
    }
  }

  list(workspaceId?: WorkspaceId): AgencyRuntimeSession[] {
    this.assertReady();
    if (workspaceId !== undefined) checkId(workspaceId);
    return [...this.sessions.values()].filter((session) =>
      workspaceId === undefined || session.workspaceId === workspaceId);
  }

  get(sessionId: RuntimeSessionId): AgencyRuntimeSession | null {
    this.assertReady();
    checkId(sessionId);
    return this.sessions.get(sessionId) ?? null;
  }

  /** No implicit process removal. Lane A can use this for guarded deletion. */
  hasWorkspaceReferences(workspaceId: WorkspaceId): boolean {
    this.assertReady();
    checkId(workspaceId);
    return [...this.sessions.values()].some((s) => s.workspaceId === workspaceId);
  }

  /**
   * Reserve the slot synchronously after resolving the workspace. A concurrent
   * request cannot pass the active-session gate, even across awaited disk/CLI work.
   */
  async create(input: AgencySessionCreateInput): Promise<AgencyRuntimeSession> {
    this.assertReady();
    checkId(input.workspaceId);
    checkDimensions(input.cols, input.rows);
    if (input.kind === 'agent' && (typeof input.profileId !== 'string' || input.profileId.trim() === '')) {
      throw new AgencyRuntimeError('invalid-request', 'A named CLI profile is required');
    }
    const id = randomUUID() as RuntimeSessionId;
    // Distinct IDs: Agency session, proposed native session, and launch correlation.
    const proposedSessionId = randomUUID();
    const launchToken = randomUUID();
    const workspace = await this.workspaces.withSessionReservation(input.workspaceId, async (row) => {
      if (row === null || row.id !== input.workspaceId) {
        throw new AgencyRuntimeError('not-found', 'Workspace does not exist');
      }
      if (row.status !== 'active') throw new AgencyRuntimeError('conflict', 'Workspace is Done');
      await this.assertSafeDirectory(row.cwd);
      if ([...this.sessions.values()].some((s) =>
        s.workspaceId === input.workspaceId && s.kind === input.kind && ACTIVE.has(s.lifecycle))) {
        throw new AgencyRuntimeError('conflict', 'Workspace already has an active session of this kind');
      }
      if (input.kind === 'agent' && input.resumeNativeSessionId !== undefined &&
          (input.resumeNativeSessionId.length === 0 || input.resumeNativeSessionId.length > 512)) {
        throw new AgencyRuntimeError('invalid-request', 'Invalid native resume session ID');
      }
      const now = NOW();
      const base = {
        id,
        workspaceId: input.workspaceId,
        terminalId: null,
        lifecycle: 'starting' as const,
        activity: 'unknown' as const,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
      };
      const session: AgencyRuntimeSession = input.kind === 'agent'
        ? {
            ...base,
            kind: 'agent',
            profileId: input.profileId,
            nativeSessionId: null,
            selectedModel: null,
            selectedEffort: null,
          }
        : {
            ...base,
            kind: 'terminal',
            profileId: null,
            nativeSessionId: null,
            selectedModel: null,
            selectedEffort: null,
          };
      this.sessions.set(id, session);
      try {
        if (input.kind === 'agent' && input.resumeNativeSessionId !== undefined) {
          this.claimNative('profile:' + input.profileId + ':' + input.resumeNativeSessionId, id);
        }
        await this.publish(session);
      } catch (error) {
        this.sessions.delete(id);
        this.releaseNative(id);
        throw error;
      }
      return row;
    });
    let observedNativeId: string | null = null;

    try {
      const options: OpenTerminalOptions = {
        cwd: workspace.cwd,
        cols: input.cols,
        rows: input.rows,
        kind: input.kind === 'terminal' ? 'shell' : 'agent',
        agencyManaged: true,
      };
      let native: ValidatedNativeLaunch | null = null;
      if (input.kind === 'agent') {
        native = await this.profiles.resolveLaunch({
          profileId: input.profileId,
          cwd: workspace.cwd,
          resumeNativeSessionId: input.resumeNativeSessionId ?? null,
          proposedSessionId,
          launchToken,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
        });
        validateLaunch(native);
        if (native.profileId !== input.profileId || native.cwd !== workspace.cwd ||
            native.launchToken !== launchToken || native.proposedSessionId !== proposedSessionId) {
          throw new AgencyRuntimeError('profile-unavailable', 'Profile launch changed the validated identity or token');
        }
        if ((input.model ?? null) !== (native.appliedModel ?? null) ||
            (input.effort ?? null) !== (native.appliedEffort ?? null)) {
          throw new AgencyRuntimeError('unsupported-capability', 'Native CLI did not confirm requested selection');
        }
        if (input.resumeNativeSessionId !== undefined &&
            (native.session.kind !== 'known' || native.session.sessionId !== input.resumeNativeSessionId)) {
          throw new AgencyRuntimeError('session-unavailable', 'Native resume identity was not preserved');
        }
        const identity = native.nativeIdentity ?? null;
        if (identity !== null && (identity.provider !== native.provider || !path.isAbsolute(identity.home))) {
          throw new AgencyRuntimeError('profile-unavailable', 'Native home identity changed provider or is invalid');
        }
        if (input.resumeNativeSessionId !== undefined) {
          if (identity === null || this.list().some((s) => s.id !== id && s.kind === 'agent' &&
              s.nativeSessionId === input.resumeNativeSessionId &&
              (s.nativeIdentity?.provider !== identity.provider || s.nativeIdentity?.home !== identity.home))) {
            throw new AgencyRuntimeError('session-unavailable', 'Native resume ownership is unverified or belongs to another home');
          }
        }
        const reserved = this.sessions.get(id)!;
        if (reserved.kind === 'agent') {
          this.sessions.set(id, { ...reserved, nativeIdentity: identity,
            nativeSessionId: native.session.kind === 'known' ? native.session.sessionId : null,
            historyAvailability: native.provider === 'codex' && identity === null ? 'unavailable' : 'available' });
        }
        const initialNative = native.session.kind === 'known' ? native.session.sessionId : null;
        const provider = native.provider;
        if (initialNative !== null) {
          if (this.registry.list().some((terminal) =>
            terminal.alive && terminal.kind === 'agent' && terminal.agent === provider &&
            terminal.sessionId === initialNative)) {
            throw new AgencyRuntimeError('conflict', 'Native conversation already has a terminal controller');
          }
          this.claimNative('provider:' + provider + ':' + initialNative, id);
        }
        await this.publish(this.sessions.get(id)!);
        options.agent = providerAgent(provider);
        if (input.resumeNativeSessionId !== undefined) options.resumeSessionId = input.resumeNativeSessionId;
        options.agencyLaunch = {
          nativeIdentity: identity,
          file: native.file,
          args: native.args,
          env: native.env,
          session: native.session,
          launchToken,
          proposedSessionId,
          acceptNativeSessionId: (terminalId, discovered) => {
            const current = this.sessions.get(id);
            if (provider === 'codex' && identity === null) return false;
            if (current === undefined || !ACTIVE.has(current.lifecycle) ||
                discovered.length === 0 || discovered.length > 512) return false;
            if (this.registry.list().some((terminal) =>
              terminal.terminalId !== terminalId && terminal.kind === 'agent' &&
              terminal.agent === provider && terminal.sessionId === discovered &&
              terminal.alive)) return false;
            try {
              this.claimNative('provider:' + provider + ':' + discovered, id);
            } catch {
              return false;
            }
            observedNativeId = discovered;
            if (current.kind === 'agent') {
              const updated = { ...current, nativeSessionId: discovered, updatedAt: NOW() };
              this.sessions.set(id, updated);
              void this.publish(updated).catch((error: unknown) =>
                console.warn('[agency] failed persisting native discovery: ' + String(error)));
            }
            return true;
          },
        };
      }
      // Stop during async profile resolution must prevent spawning.
      if (this.disposed || this.sessions.get(id)?.lifecycle === 'stopping') {
        return await this.finish(id, null, 'exited');
      }
      // A previously safe path or CLI home may have been swapped while the
      // asynchronous named-profile launch plan was prepared.
      await this.assertSafeDirectory(workspace.cwd);
      const terminal = await this.registry.open(options);
      this.byTerminal.set(terminal.terminalId, id);
      // An extremely short-lived process may exit before its open promise
      // resolves, before byTerminal exists to correlate the exit event.
      const observed = this.registry.get(terminal.terminalId) ?? terminal;
      const persistedNative = observedNativeId ??
        (observed.kind === 'agent' && observed.sessionId.length > 0 ? observed.sessionId : null) ??
        (native?.session.kind === 'known' ? native.session.sessionId : null);
      const current = this.sessions.get(id);
      if (current === undefined) throw new Error('Reserved session disappeared');
      const stopping = current.lifecycle === 'stopping';
      const alive = observed.alive && !stopping;
      const next: AgencyRuntimeSession = {
        ...current,
        terminalId: terminal.terminalId,
        nativeSessionId: current.kind === 'agent' ? persistedNative : null,
        selectedModel: current.kind === 'agent' ? (native?.appliedModel ?? null) : null,
        selectedEffort: current.kind === 'agent' ? (native?.appliedEffort ?? null) : null,
        startedAt: new Date(terminal.launchedAt ?? Date.now()).toISOString(),
        lifecycle: stopping ? 'stopping' : alive ? 'running' : 'exited',
        activity: alive ? activityFor(this.registry.activityOf(terminal.terminalId)) : 'offline',
        exitCode: alive ? null : observed.exitCode,
        stoppedAt: alive || stopping ? null : NOW(),
        updatedAt: NOW(),
      } as AgencyRuntimeSession;
      this.sessions.set(id, next);
      if (!alive && !stopping) this.releaseNative(id);
      if (stopping) this.registry.close(terminal.terminalId);
      await this.publish(next);
      return this.sessions.get(id) ?? next;
    } catch (error) {
      const current = this.sessions.get(id);
      if (current?.terminalId !== null && current?.terminalId !== undefined) {
        this.registry.close(current.terminalId);
      }
      return await this.fail(id, error);
    }
  }

  private async assertSafeDirectory(cwd: string): Promise<void> {
    const resolved = path.isAbsolute(cwd) ? await realpath(cwd).catch(() => null) : null;
    const info = resolved === cwd ? await stat(cwd).catch(() => null) : null;
    if (resolved !== cwd || info?.isDirectory() !== true) {
      throw new AgencyRuntimeError('invalid-directory', 'Workspace canonical directory is unavailable');
    }
    const directories = this.workspaces.protectedDirectories();
    if (!Array.isArray(directories) ||
        directories.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir))) {
      throw new AgencyRuntimeError('invalid-directory', 'Protected CLI directory guard unavailable');
    }
    const protectedCanonical = await Promise.all(directories.map(async (dir) =>
      realpath(dir).catch(() => path.resolve(dir))));
    if (isInsideProtected(cwd, directories) || isInsideProtected(cwd, protectedCanonical)) {
      throw new AgencyRuntimeError('invalid-directory', 'Workspace overlaps a protected CLI directory');
    }
  }

  /** Reattach is lookup only. Existing /ws terminal.attach performs the replay. */
  liveTerminal(sessionId: RuntimeSessionId): string {
    this.assertReady();
    checkId(sessionId);
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.terminalId === null ||
        !ACTIVE.has(session.lifecycle) || !this.registry.get(session.terminalId)?.alive) {
      throw new AgencyRuntimeError('session-unavailable', 'No live PTY to reattach');
    }
    return session.terminalId;
  }

  /** Explicit stop, never invoked by Done or socket detach. */
  async stop(sessionId: RuntimeSessionId): Promise<AgencyRuntimeSession> {
    this.assertReady();
    checkId(sessionId);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new AgencyRuntimeError('not-found', 'Session does not exist');
    if (!ACTIVE.has(session.lifecycle) || session.lifecycle === 'stopping') return session;
    const stopping = { ...session, stoppedByUser: true, lifecycle: 'stopping' as const, updatedAt: NOW() };
    this.sessions.set(sessionId, stopping);
    await this.publish(stopping);
    if (stopping.terminalId === null) return stopping; // pending open resolves and stops itself
    if (!this.registry.close(stopping.terminalId)) {
      return this.finish(sessionId, null, 'exited');
    }
    return this.sessions.get(sessionId) ?? stopping;
  }

  /** Only confirmed native setting changes may be reflected in metadata. */
  async setSelection(
    sessionId: RuntimeSessionId,
    model: string | null,
    effort: string | null,
  ): Promise<AgencyAgentSession> {
    this.assertReady();
    checkId(sessionId);
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.kind !== 'agent') {
      throw new AgencyRuntimeError('not-found', 'Agent session does not exist');
    }
    if (session.lifecycle !== 'running' || session.terminalId === null) {
      throw new AgencyRuntimeError('session-unavailable', 'Agent is not running');
    }
    if (this.profiles.applySelection === undefined) {
      throw new AgencyRuntimeError('unsupported-capability', 'Native selection changes unavailable');
    }
    const actual = await this.profiles.applySelection({
      profileId: session.profileId,
      terminalId: session.terminalId,
      nativeSessionId: session.nativeSessionId,
      model,
      effort,
    });
    if (actual.model !== model || actual.effort !== effort) {
      throw new AgencyRuntimeError('unsupported-capability', 'Native selection was not confirmed');
    }
    const latest = this.sessions.get(sessionId);
    if (latest?.lifecycle !== 'running' || latest.kind !== 'agent') {
      throw new AgencyRuntimeError('session-unavailable', 'Agent exited during selection');
    }
    const next: AgencyAgentSession = { ...latest, selectedModel: model, selectedEffort: effort, updatedAt: NOW() };
    this.sessions.set(sessionId, next);
    await this.publish(next);
    return next;
  }

  /** Detach listeners at shutdown; TerminalRegistry.disposeAll owns termination. */
  dispose(): void {
    this.disposed = true;
    this.registry.off('exit', this.onExit);
    this.registry.off('activity', this.onActivity);
    this.registry.off('session', this.onNativeSession);
    this.removeAllListeners();
  }

  private readonly onExit = (terminalId: TerminalId, code: number): void => {
    const id = this.byTerminal.get(terminalId);
    if (id === undefined) return;
    this.byTerminal.delete(terminalId);
    void this.finish(id, code, 'exited').catch((error: unknown) => {
      console.warn('[agency] failed persisting PTY exit: ' + String(error));
    });
  };

  private readonly onActivity = (terminalId: TerminalId, activity: TerminalActivity): void => {
    const id = this.byTerminal.get(terminalId);
    if (id === undefined) return;
    const session = this.sessions.get(id);
    if (session === undefined || !ACTIVE.has(session.lifecycle)) return;
    const next = { ...session, activity: activityFor(activity), updatedAt: NOW() };
    this.sessions.set(id, next);
    void this.publish(next).catch((error: unknown) => {
      console.warn('[agency] failed persisting PTY activity: ' + String(error));
    });
  };

  private readonly onNativeSession = (terminalId: TerminalId, nativeSessionId: string): void => {
    const id = this.byTerminal.get(terminalId);
    const current = id === undefined ? undefined : this.sessions.get(id);
    if (current?.kind !== 'agent' || nativeSessionId.length === 0) return;
    const provider = this.registry.get(terminalId)?.agent;
    if (provider !== null && provider !== undefined) {
      try {
        this.claimNative('provider:' + provider + ':' + nativeSessionId, current.id);
      } catch {
        // The CLI just reported an ID another active PTY controls. Do not
        // allow two controllers to continue on that native conversation.
        this.registry.close(terminalId);
        void this.finish(current.id, null, 'failed').catch(() => undefined);
        return;
      }
    }
    const next = { ...current, nativeSessionId, updatedAt: NOW() };
    this.sessions.set(current.id, next);
    void this.publish(next).catch((error: unknown) => {
      console.warn('[agency] failed persisting native session ID: ' + String(error));
    });
  };

  private async finish(
    id: RuntimeSessionId,
    exitCode: number | null,
    lifecycle: 'exited' | 'failed',
  ): Promise<AgencyRuntimeSession> {
    const previous = this.sessions.get(id);
    if (previous === undefined) throw new AgencyRuntimeError('not-found', 'Session does not exist');
    if (previous.lifecycle === 'exited' || previous.lifecycle === 'failed') return previous;
    const next: AgencyRuntimeSession = {
      ...previous,
      lifecycle,
      activity: 'offline',
      exitCode,
      stoppedAt: NOW(),
      updatedAt: NOW(),
    };
    this.sessions.set(id, next);
    this.releaseNative(id);
    await this.publish(next);
    return next;
  }

  private claimNative(key: string, id: RuntimeSessionId): void {
    const existing = this.nativeClaims.get(key);
    if (existing !== undefined && existing !== id &&
        ACTIVE.has(this.sessions.get(existing)?.lifecycle ?? 'exited')) {
      throw new AgencyRuntimeError('conflict', 'Native conversation already has an active controller');
    }
    this.nativeClaims.set(key, id);
  }

  private releaseNative(id: RuntimeSessionId): void {
    for (const [key, owner] of this.nativeClaims) {
      if (owner === id) this.nativeClaims.delete(key);
    }
  }

  private async fail(id: RuntimeSessionId, reason: unknown): Promise<never> {
    await this.finish(id, null, 'failed');
    if (reason instanceof AgencyRuntimeError) throw reason;
    throw new AgencyRuntimeError('internal-error', reason instanceof Error ? reason.message : String(reason));
  }

  private async persist(): Promise<void> {
    await this.store.save([...this.sessions.values()]);
  }

  private async publish(session: AgencyRuntimeSession): Promise<void> {
    await this.persist();
    this.emit('changed', session);
    this.emit('activity', {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      lifecycle: session.lifecycle,
      activity: session.activity,
    });
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('Agency runtime must be initialized first');
  }
}
