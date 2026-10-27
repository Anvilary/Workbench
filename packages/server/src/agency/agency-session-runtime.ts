import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgencyAgentSession,
  AgencyRuntimeSession,
  AgencyTerminalSession,
  AgencyWorkspace,
  CliProfileId,
  CliProvider,
  RuntimeSessionId,
  SessionActivity,
  WorkspaceId,
} from '@agent-workbench/shared';
import type { AgentId, TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { OpenTerminalOptions, TerminalRegistry } from '../terminal-registry.js';
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
  provider: CliProvider;
  file: string;
  args: readonly string[];
  /** A fresh isolated environment approved by Lane B, never persisted here. */
  env: Record<string, string>;
  /** Only the native CLI may provide an actual conversation ID. */
  nativeSessionId?: string | null;
  /** Values actually applied to the native invocation. Unconfirmed values stay null. */
  appliedModel?: string | null;
  appliedEffort?: string | null;
}

export interface AgencyProfileLaunchProvider {
  resolveLaunch(input: {
    profileId: CliProfileId;
    cwd: string;
    resumeNativeSessionId: string | null;
    model: string | null;
    effort: string | null;
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
  /** Lane A's persisted canonical workspace only, never a client-supplied cwd. */
  getWorkspace(id: WorkspaceId): Promise<AgencyWorkspace | null> | AgencyWorkspace | null;
}

export type AgencyTerminalRegistry = Pick<
  TerminalRegistry,
  'open' | 'get' | 'has' | 'close' | 'activityOf' | 'on' | 'off'
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
  private initialized = false;

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
      const needsRecovery = ACTIVE.has(previous.lifecycle);
      const session: AgencyRuntimeSession = needsRecovery ? {
        ...previous,
        lifecycle: 'exited',
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
    const workspace = await this.workspaces.getWorkspace(input.workspaceId);
    if (workspace === null || workspace.id !== input.workspaceId) {
      throw new AgencyRuntimeError('not-found', 'Workspace does not exist');
    }
    if (workspace.status !== 'active') throw new AgencyRuntimeError('conflict', 'Workspace is Done');
    if (!path.isAbsolute(workspace.cwd) || await realpath(workspace.cwd).catch(() => null) !== workspace.cwd) {
      throw new AgencyRuntimeError('invalid-directory', 'Workspace canonical directory is unavailable');
    }
    if ([...this.sessions.values()].some((s) =>
      s.workspaceId === input.workspaceId && s.kind === input.kind && ACTIVE.has(s.lifecycle))) {
      throw new AgencyRuntimeError('conflict', 'Workspace already has an active session of this kind');
    }

    const id = randomUUID() as RuntimeSessionId;
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
      await this.publish(session);
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }

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
          model: input.model ?? null,
          effort: input.effort ?? null,
        });
        validateLaunch(native);
        if ((input.model ?? null) !== (native.appliedModel ?? null) ||
            (input.effort ?? null) !== (native.appliedEffort ?? null)) {
          throw new AgencyRuntimeError('unsupported-capability', 'Native CLI did not confirm requested selection');
        }
        options.agent = providerAgent(native.provider);
        options.agencyLaunch = { file: native.file, args: native.args, env: native.env };
      }
      // Stop during async profile resolution must prevent spawning.
      if (this.sessions.get(id)?.lifecycle === 'stopping') {
        return await this.finish(id, null, 'exited');
      }
      const terminal = await this.registry.open(options);
      this.byTerminal.set(terminal.terminalId, id);
      const current = this.sessions.get(id);
      if (current === undefined) throw new Error('Reserved session disappeared');
      const stopping = current.lifecycle === 'stopping';
      const alive = terminal.alive && !stopping;
      const next: AgencyRuntimeSession = {
        ...current,
        terminalId: terminal.terminalId,
        nativeSessionId: current.kind === 'agent' ? (native?.nativeSessionId ?? null) : null,
        selectedModel: current.kind === 'agent' ? (native?.appliedModel ?? null) : null,
        selectedEffort: current.kind === 'agent' ? (native?.appliedEffort ?? null) : null,
        startedAt: new Date(terminal.launchedAt ?? Date.now()).toISOString(),
        lifecycle: stopping ? 'stopping' : alive ? 'running' : 'exited',
        activity: alive ? activityFor(this.registry.activityOf(terminal.terminalId)) : 'offline',
        exitCode: alive ? null : terminal.exitCode,
        stoppedAt: alive || stopping ? null : NOW(),
        updatedAt: NOW(),
      } as AgencyRuntimeSession;
      this.sessions.set(id, next);
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
    const stopping = { ...session, lifecycle: 'stopping' as const, updatedAt: NOW() };
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
    await this.publish(next);
    return next;
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
