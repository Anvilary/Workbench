import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  AgencyRuntimeSession,
  AgencyWorkspace,
  CliProfileId,
  TerminalDescriptor,
  TerminalId,
  WorkspaceId,
} from '@agent-workbench/shared';
import { OutputBuffer } from '../../output-buffer.js';
import { TerminalRegistry } from '../../terminal-registry.js';
import { AgentRegistry } from '../../agents/registry.js';
import { WorkspaceStore, type WorkspaceState } from '../../workspace-store.js';
import type { AgentAdapter, SpawnedContext } from '../../agents/adapter.js';
import { AgencySessionStore, UnsupportedAgencySessionSchemaError } from '../agency-session-store.js';
import {
  AgencyRuntimeError,
  AgencySessionRuntime,
  type AgencyProfileLaunchProvider,
  type AgencyTerminalRegistry,
} from '../agency-session-runtime.js';

class FakeTerminals extends EventEmitter {
  private readonly descriptors = new Map<TerminalId, TerminalDescriptor>();
  readonly opens: Array<{ cwd: string; kind?: string; agent?: string; agencyLaunch?: { file: string; args: readonly string[]; env: Record<string, string>; acceptNativeSessionId?: (id: TerminalId, nativeId: string) => boolean } }> = [];
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  closeCount = 0;
  pendingOpen: Promise<void> | null = null;
  onOpen: ((options: { agencyLaunch?: { acceptNativeSessionId?: (id: TerminalId, nativeId: string) => boolean } },
    descriptor: TerminalDescriptor) => void) | null = null;

  async open(options: {
    cwd: string;
    kind?: string;
    agent?: string;
    agencyLaunch?: {
      file: string;
      args: readonly string[];
      env: Record<string, string>;
      session: { kind: 'known'; sessionId: string } | { kind: 'discover' };
      launchToken: string;
      proposedSessionId: string;
      acceptNativeSessionId?: (id: TerminalId, nativeId: string) => boolean;
    };
  }): Promise<TerminalDescriptor> {
    this.opens.push(options);
    if (this.pendingOpen !== null) await this.pendingOpen;
    const descriptor: TerminalDescriptor = {
      terminalId: randomUUID(),
      kind: options.kind === 'shell' ? 'shell' : 'agent',
      agent: options.kind === 'shell' ? null : 'codex',
      cwd: options.cwd,
      sessionId: options.agencyLaunch?.session.kind === 'known'
        ? options.agencyLaunch.session.sessionId : '',
      label: '',
      resumed: false,
      createdAt: Date.now(),
      alive: true,
      sleeping: false,
      exitCode: null,
      launchedAt: Date.now(),
      worktree: null,
      review: false,
    };
    this.descriptors.set(descriptor.terminalId, descriptor);
    this.onOpen?.(options, descriptor);
    return descriptor;
  }

  get(id: TerminalId): TerminalDescriptor | null {
    return this.descriptors.get(id) ?? null;
  }

  has(id: TerminalId): boolean {
    return this.descriptors.has(id);
  }

  list(): TerminalDescriptor[] {
    return [...this.descriptors.values()];
  }

  activityOf(_id: TerminalId): 'unknown' {
    return 'unknown';
  }

  close(id: TerminalId): boolean {
    const entry = this.descriptors.get(id);
    if (entry === undefined) return false;
    this.closeCount += 1;
    this.descriptors.delete(id);
    queueMicrotask(() => this.emit('exit', id, 143, 15));
    return true;
  }

  write(id: TerminalId, data: string): boolean {
    if (!this.descriptors.has(id)) return false;
    this.writes.push(data);
    return true;
  }

  resize(id: TerminalId, cols: number, rows: number): boolean {
    if (!this.descriptors.has(id)) return false;
    this.sizes.push([cols, rows]);
    return true;
  }

  exit(id: TerminalId, code: number): void {
    this.descriptors.delete(id);
    this.emit('exit', id, code, null);
  }

  discover(id: TerminalId, nativeId: string): boolean {
    const entry = this.descriptors.get(id);
    if (entry === undefined) return false;
    const plan = this.opens.find((_options, index) =>
      [...this.descriptors.keys()][index] === id)?.agencyLaunch;
    const accepted = plan?.acceptNativeSessionId?.(id, nativeId) ?? true;
    if (!accepted) {
      this.close(id);
      return false;
    }
    this.descriptors.set(id, { ...entry, sessionId: nativeId });
    this.emit('session', id, nativeId);
    return true;
  }
}

const agentProfile = 'codex-0' as CliProfileId;
function workspace(cwd: string, status: 'active' | 'done' = 'active'): AgencyWorkspace {
  const now = new Date().toISOString();
  return {
    id: randomUUID() as WorkspaceId,
    projectId: randomUUID() as AgencyWorkspace['projectId'],
    name: 'fixture',
    cwd,
    status,
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : null,
  };
}
function fixture(
  cwd: string,
  options: {
    store?: AgencySessionStore;
    resolveLaunch?: AgencyProfileLaunchProvider['resolveLaunch'];
    protectedDirectories?: () => readonly string[];
  } = {},
) {
  const terminals = new FakeTerminals();
  const workspaces = new Map<WorkspaceId, AgencyWorkspace>();
  const one = workspace(cwd);
  const two = workspace(cwd);
  workspaces.set(one.id, one);
  workspaces.set(two.id, two);
  const profiles: AgencyProfileLaunchProvider = {
    resolveLaunch: options.resolveLaunch ?? (async ({profileId, cwd, resumeNativeSessionId, proposedSessionId, launchToken}) => ({
      nativeIdentity: Object.freeze({ provider: 'codex' as const, home: path.join(cwd, 'fixture-native-home') }),
      profileId, provider: 'codex', file: '/bin/echo', args: ['literal space'],
      env: { PATH: '/usr/bin', AGENCY_FIXTURE: '1' }, cwd, proposedSessionId, launchToken,
      session: resumeNativeSessionId === null
        ? { kind: 'discover' as const }
        : { kind: 'known' as const, sessionId: resumeNativeSessionId },
    })),
  };
  const runtime = new AgencySessionRuntime({
    registry: terminals as unknown as AgencyTerminalRegistry,
    workspaces: {
      withSessionReservation: async (id, action) => action(workspaces.get(id) ?? null),
      protectedDirectories: options.protectedDirectories ?? (() => []),
    },
    profiles,
    store: options.store ?? new MemoryStore(),
  });
  return { runtime, terminals, workspaces, one, two };
}

class MemoryStore extends AgencySessionStore {
  data: AgencyRuntimeSession[] = [];
  override async load(): Promise<AgencyRuntimeSession[]> { return structuredClone(this.data); }
  override async save(items: readonly AgencyRuntimeSession[]): Promise<void> {
    this.data = structuredClone([...items]);
  }
}

test('empty workspaces, two independent shells and same-workspace atomic slot gate', async () => {
  const f = fixture(await mkdtemp(path.join(tmpdir(), 'agency-c-')));
  try {
    await f.runtime.initialize();
    assert.deepEqual(f.runtime.list(), []);
    const calls = Array.from({ length: 12 }, () =>
      f.runtime.create({ kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24 }));
    const settled = await Promise.allSettled(calls);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected' &&
      result.reason instanceof AgencyRuntimeError && result.reason.code === 'conflict').length, 11);
    const other = await f.runtime.create({ kind: 'terminal', workspaceId: f.two.id, cols: 100, rows: 32 });
    assert.equal(other.lifecycle, 'running');
    assert.equal(f.terminals.opens.length, 2);
    assert.notEqual(f.runtime.list()[0]?.id, other.id);
  } finally {
    f.runtime.dispose();
  }
});

test('browser reattach never spawns; input, paste, resize and stop use existing registry', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd);
  try {
    await f.runtime.initialize();
    const session = await f.runtime.create({ kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24 });
    const id = f.runtime.liveTerminal(session.id);
    assert.equal(f.runtime.liveTerminal(session.id), id);
    assert.equal(f.terminals.opens.length, 1);
    assert.equal(f.terminals.write(id, 'printf ok\\r'), true);
    assert.equal(f.terminals.write(id, '\\x1b[200~two lines\\nnext\\x1b[201~'), true);
    assert.equal(f.terminals.write(id, '\\x03'), true);
    assert.equal(f.terminals.resize(id, 120, 45), true);
    assert.deepEqual(f.terminals.sizes, [[120, 45]]);
    assert.equal(f.terminals.writes.length, 3);
    f.workspaces.set(f.one.id, { ...f.one, status: 'done' });
    assert.equal(f.runtime.liveTerminal(session.id), id);
    assert.equal(f.terminals.closeCount, 0);
    await f.runtime.stop(session.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.runtime.get(session.id)?.lifecycle, 'exited');
    assert.equal(f.terminals.closeCount, 1);
    assert.throws(() => f.runtime.liveTerminal(session.id), /No live PTY/);
    assert.equal(f.runtime.hasWorkspaceReferences(f.one.id), true);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent profile launch preserves argv and isolated environment, no account fallback', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd);
  try {
    await f.runtime.initialize();
    const agent = await f.runtime.create({
      kind: 'agent', workspaceId: f.one.id, profileId: agentProfile, cols: 100, rows: 35,
    });
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.nativeSessionId, null);
    assert.equal(agent.selectedModel, null);
    assert.deepEqual(f.terminals.opens[0]?.agencyLaunch?.args, ['literal space']);
    assert.deepEqual(f.terminals.opens[0]?.agencyLaunch?.env, { PATH: '/usr/bin', AGENCY_FIXTURE: '1' });
    assert.equal(f.terminals.opens[0]?.cwd, cwd);
    assert.equal(f.runtime.list().length, 1);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('profile launch refusal releases reservation, native settings never guessed', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async () => { throw new Error('unavailable'); },
  });
  try {
    await f.runtime.initialize();
    await assert.rejects(f.runtime.create({
      kind: 'agent', workspaceId: f.one.id, profileId: agentProfile, cols: 80, rows: 24,
    }), /unavailable/);
    assert.equal(f.runtime.list()[0]?.lifecycle, 'failed');
    assert.equal(f.terminals.opens.length, 0);
    await assert.rejects(f.runtime.setSelection(f.runtime.list()[0]!.id, 'x', null),
      (error: unknown) => error instanceof AgencyRuntimeError && error.code === 'session-unavailable');
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('simultaneous stop during pending spawn stops the resulting PTY', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd);
  try {
    await f.runtime.initialize();
    let resume!: () => void;
    f.terminals.pendingOpen = new Promise<void>((resolve) => { resume = resolve; });
    const pending = f.runtime.create({ kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24 });
    while (f.terminals.opens.length === 0) await new Promise<void>((r) => setImmediate(r));
    const starting = f.runtime.list()[0]!;
    assert.equal(starting.lifecycle, 'starting');
    await f.runtime.stop(starting.id);
    resume();
    await pending;
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.terminals.closeCount, 1);
    assert.equal(f.runtime.get(starting.id)?.lifecycle, 'exited');
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('backend restart marks old shells exited, never falsely live', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const store = new MemoryStore();
  const original = fixture(cwd, { store });
  try {
    await original.runtime.initialize();
    const shell = await original.runtime.create({
      workspaceId: original.one.id, kind: 'terminal', cols: 80, rows: 24,
    });
    original.runtime.dispose();
    const restarted = fixture(cwd, { store });
    await restarted.runtime.initialize();
    const recovered = restarted.runtime.get(shell.id);
    assert.equal(recovered?.lifecycle, 'exited');
    assert.equal(recovered?.activity, 'offline');
    assert.equal(recovered?.exitCode, null);
    assert.equal(restarted.terminals.opens.length, 0);
    assert.throws(() => restarted.runtime.liveTerminal(shell.id), /No live PTY/);
    restarted.runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('corrupt metadata quarantines, bounded output marks truncation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  try {
    const file = path.join(dir, 'sessions.json');
    const store = new AgencySessionStore(file);
    await store.save([]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sessions, []);
    const output = new OutputBuffer(24);
    output.push('first chunk');
    output.push('second chunk');
    output.push('third chunk');
    assert.equal(output.isTruncated(), true);
    assert.equal(output.read().includes('first chunk'), false);
    const oversized = new OutputBuffer(8);
    oversized.push('start:' + '😀'.repeat(10) + 'finish');
    assert.equal(oversized.isTruncated(), true);
    assert.ok(Buffer.byteLength(oversized.read(), 'utf8') <= 8);
    assert.equal(oversized.read(), 'finish');
    const invalid = await import('node:fs/promises');
    await invalid.writeFile(file, '{bad json', 'utf8');
    // A single prior save has no valid backup: corruption must fail closed.
    await assert.rejects(store.load(), AggregateError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid IDs and stale workspace directories cannot launch', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd);
  try {
    await f.runtime.initialize();
    await assert.rejects(f.runtime.create({
      kind: 'terminal', workspaceId: 'not-an-id' as WorkspaceId, cols: 80, rows: 24,
    }), /Invalid Agency ID/);
    await assert.rejects(f.runtime.create({
      kind: 'terminal', workspaceId: f.one.id, cols: 0, rows: 24,
    }), /Invalid terminal dimensions/);
    await rm(cwd, { recursive: true, force: true });
    await assert.rejects(f.runtime.create({
      kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24,
    }), /canonical directory/);
    assert.equal(f.terminals.opens.length, 0);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('protected CLI homes and symlink replacement are rejected before PTY creation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agency-protected-'));
  const protectedHome = path.join(root, 'cli-home');
  const workspaceDir = path.join(root, 'workspace');
  await mkdir(protectedHome);
  await mkdir(workspaceDir);
  const protect = () => [protectedHome];
  const f = fixture(workspaceDir, { protectedDirectories: protect });
  try {
    await f.runtime.initialize();
    f.workspaces.set(f.one.id, { ...f.one, cwd: protectedHome });
    await assert.rejects(f.runtime.create({
      kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24,
    }), /protected CLI directory/);
    assert.equal(f.terminals.opens.length, 0);
    f.workspaces.set(f.one.id, f.one);
    // Replace the former canonical cwd with a symlink to a protected home.
    await rm(workspaceDir, { recursive: true, force: true });
    await symlink(protectedHome, workspaceDir, 'dir');
    await assert.rejects(f.runtime.create({
      kind: 'terminal', workspaceId: f.one.id, cols: 80, rows: 24,
    }), /canonical directory/);
    assert.equal(f.terminals.opens.length, 0);
  } finally {
    f.runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('native conversation controller is exclusive across workspaces', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ profileId, resumeNativeSessionId, proposedSessionId, launchToken, cwd }) => ({
      profileId,
      nativeIdentity: Object.freeze({ provider: 'codex' as const, home: path.join(cwd, 'fixture-native-home') }),
      provider: 'codex',
      file: '/bin/echo',
      args: ['literal argv'],
      env: { PATH: '/usr/bin' },
      cwd, proposedSessionId, launchToken,
      session: resumeNativeSessionId === null ? { kind: 'discover' } :
        { kind: 'known', sessionId: resumeNativeSessionId },
    }),
  });
  try {
    await f.runtime.initialize();
    const nativeId = randomUUID();
    const first = await f.runtime.create({
      kind: 'agent', workspaceId: f.one.id, profileId: agentProfile, cols: 80, rows: 24,
      resumeNativeSessionId: nativeId,
    });
    assert.equal(first.lifecycle, 'running');
    await assert.rejects(f.runtime.create({
      kind: 'agent', workspaceId: f.two.id, profileId: agentProfile, cols: 80, rows: 24,
      resumeNativeSessionId: nativeId,
    }), (error: unknown) => error instanceof AgencyRuntimeError && error.code === 'conflict');
    assert.equal(f.terminals.opens.length, 1);
    await f.runtime.stop(first.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await f.runtime.create({
      kind: 'agent', workspaceId: f.two.id, profileId: agentProfile, cols: 80, rows: 24,
      resumeNativeSessionId: nativeId,
    });
    assert.equal(second.lifecycle, 'running');
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('mismatched named profile identity is never accepted as fallback', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ cwd, proposedSessionId, launchToken }) => ({
      profileId: 'codex-1' as CliProfileId,
      nativeIdentity: Object.freeze({ provider: 'codex' as const, home: path.join(cwd, 'fixture-native-home') }),
      provider: 'codex', file: '/bin/echo', args: [], env: { PATH: '/usr/bin' },
      cwd, proposedSessionId, launchToken, session: { kind: 'discover' },
    }),
  });
  try {
    await f.runtime.initialize();
    await assert.rejects(f.runtime.create({
      kind: 'agent', workspaceId: f.one.id, profileId: agentProfile, cols: 80, rows: 24,
    }), (error: unknown) => error instanceof AgencyRuntimeError && error.code === 'profile-unavailable');
    assert.equal(f.terminals.opens.length, 0);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Codex and AGY native discovery before open settles is retained without inventing IDs', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ profileId, cwd, proposedSessionId, launchToken }) => ({
      profileId, cwd, proposedSessionId, launchToken,
      nativeIdentity: profileId === ('agy-0' as CliProfileId) ? null : Object.freeze({ provider: 'codex' as const, home: path.join(cwd, 'fixture-native-home') }),
      provider: profileId === ('agy-0' as CliProfileId) ? 'antigravity' : 'codex',
      file: '/bin/echo', args: ['native CLI', 'literal space'], env: { PATH: '/usr/bin' },
      session: { kind: 'discover' },
    }),
  });
  try {
    await f.runtime.initialize();
    const firstId = randomUUID();
    f.terminals.onOpen = (options, descriptor) => {
      assert.equal(options.agencyLaunch?.acceptNativeSessionId?.(descriptor.terminalId, firstId), true);
      // Simulate native adapter discovery during registry.open, before Promise resolves.
      (descriptor as { sessionId: string }).sessionId = firstId;
    };
    const codex = await f.runtime.create({
      kind: 'agent', profileId: agentProfile, workspaceId: f.one.id, cols: 80, rows: 24,
    });
    assert.equal(codex.nativeSessionId, firstId);
    assert.equal(f.terminals.get(codex.terminalId!)?.sessionId, firstId);
    const secondId = randomUUID();
    f.terminals.onOpen = (options, descriptor) => {
      assert.equal(options.agencyLaunch?.acceptNativeSessionId?.(descriptor.terminalId, secondId), true);
      (descriptor as { sessionId: string }).sessionId = secondId;
    };
    const agy = await f.runtime.create({
      kind: 'agent', profileId: 'agy-0' as CliProfileId, workspaceId: f.two.id, cols: 80, rows: 24,
    });
    assert.equal(agy.nativeSessionId, secondId);
    assert.equal(f.terminals.get(agy.terminalId!)?.sessionId, secondId);
    assert.notEqual(codex.id, agy.id);
    assert.notEqual(codex.terminalId, agy.terminalId);
    assert.equal(f.terminals.opens.length, 2);
    const launch = f.terminals.opens[1]!.agencyLaunch!;
    assert.ok(launch.args.includes('literal space'));
    assert.ok(launch.env['PATH'] === '/usr/bin');
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude known session and native resume identity reach terminal descriptor and metadata', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ profileId, cwd, proposedSessionId, launchToken, resumeNativeSessionId }) => ({
      profileId, cwd, proposedSessionId, launchToken,
      nativeIdentity: Object.freeze({ provider: 'claude-code' as const, home: path.join(cwd, 'fixture-claude-home') }),
      provider: 'claude-code', file: '/bin/echo', args: ['--session-id', proposedSessionId],
      env: { PATH: '/usr/bin' },
      session: { kind: 'known', sessionId: resumeNativeSessionId ?? proposedSessionId },
    }),
  });
  try {
    await f.runtime.initialize();
    const newlyCreated = await f.runtime.create({
      kind: 'agent', profileId: 'claude-code' as CliProfileId,
      workspaceId: f.one.id, cols: 80, rows: 24,
    });
    assert.equal(newlyCreated.nativeSessionId, f.terminals.get(newlyCreated.terminalId!)?.sessionId);
    assert.ok(newlyCreated.nativeSessionId);
    const resume = randomUUID();
    const resumed = await f.runtime.create({
      kind: 'agent', profileId: 'claude-code' as CliProfileId,
      workspaceId: f.two.id, cols: 80, rows: 24, resumeNativeSessionId: resume,
    });
    assert.equal(resumed.nativeSessionId, resume);
    assert.equal(f.terminals.get(resumed.terminalId!)?.sessionId, resume);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('different profiles of the same provider cannot resume one native conversation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ profileId, cwd, proposedSessionId, launchToken, resumeNativeSessionId }) => ({
      profileId, cwd, proposedSessionId, launchToken,
      nativeIdentity: Object.freeze({ provider: 'codex' as const, home: path.join(cwd, 'fixture-native-home') }),
      provider: 'codex', file: '/bin/echo', args: ['resume', resumeNativeSessionId ?? ''],
      env: { PATH: '/usr/bin' },
      session: resumeNativeSessionId === null ? { kind: 'discover' } :
        { kind: 'known', sessionId: resumeNativeSessionId },
    }),
  });
  try {
    await f.runtime.initialize();
    const id = randomUUID();
    await f.runtime.create({
      workspaceId: f.one.id, kind: 'agent', profileId: 'codex-0' as CliProfileId,
      cols: 80, rows: 24, resumeNativeSessionId: id,
    });
    await assert.rejects(f.runtime.create({
      workspaceId: f.two.id, kind: 'agent', profileId: 'codex-3' as CliProfileId,
      cols: 80, rows: 24, resumeNativeSessionId: id,
    }), (error: unknown) => error instanceof AgencyRuntimeError && error.code === 'conflict');
    assert.equal(f.terminals.opens.length, 1);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('discovery and process exit release native ownership for subsequent sessions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd);
  try {
    await f.runtime.initialize();
    const first = await f.runtime.create({
      workspaceId: f.one.id, kind: 'agent', profileId: agentProfile, cols: 80, rows: 24,
    });
    const nativeId = randomUUID();
    const callback = f.terminals.opens[0]!.agencyLaunch?.acceptNativeSessionId;
    assert.equal(callback?.(first.terminalId!, nativeId), true);
    const second = await f.runtime.create({
      workspaceId: f.two.id, kind: 'agent', profileId: agentProfile,
      cols: 80, rows: 24,
    });
    assert.equal(f.terminals.opens[1]!.agencyLaunch?.acceptNativeSessionId?.(second.terminalId!, nativeId), false);
    f.terminals.exit(first.terminalId!, 7);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.runtime.get(first.id)?.exitCode, 7);
    assert.equal(f.runtime.get(first.id)?.lifecycle, 'exited');
    assert.equal(f.terminals.opens[1]!.agencyLaunch?.acceptNativeSessionId?.(second.terminalId!, nativeId), true);
  } finally {
    f.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

function sampleSession(): AgencyRuntimeSession {
  const now = new Date().toISOString();
  return {
    kind: 'terminal', id: randomUUID() as AgencyRuntimeSession['id'],
    workspaceId: randomUUID() as WorkspaceId, terminalId: randomUUID(),
    profileId: null, nativeSessionId: null, selectedModel: null, selectedEffort: null,
    lifecycle: 'exited', activity: 'offline', createdAt: now, updatedAt: now,
    startedAt: now, stoppedAt: now, exitCode: 0,
  };
}

test('missing primary recovers a validated backup, without discarding history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-recovery-'));
  const file = path.join(dir, 'sessions.json');
  try {
    const store = new AgencySessionStore(file);
    const saved = sampleSession();
    await store.save([saved]);
    await store.save([saved]);
    await rm(file);
    assert.deepEqual(await store.load(), [saved]);
    assert.deepEqual(JSON.parse(await readFile(file + '.bak', 'utf8')).sessions, [saved]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt primary recovers verified backup and quarantines original bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-recovery-'));
  const file = path.join(dir, 'sessions.json');
  try {
    const store = new AgencySessionStore(file);
    const saved = sampleSession();
    await store.save([saved]);
    await store.save([saved]);
    await writeFile(file, '{broken-json', 'utf8');
    assert.deepEqual(await store.load(), [saved]);
    const files = await readdir(dir);
    const corrupt = files.find((name) => name.startsWith('sessions.json.corrupt-'));
    assert.ok(corrupt);
    assert.equal(await readFile(path.join(dir, corrupt), 'utf8'), '{broken-json');
    // A structurally corrupt JSON object is recoverable, unlike an explicit future version.
    await writeFile(file, JSON.stringify({ sessions: [saved] }));
    assert.deepEqual(await store.load(), [saved]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('future schema and dual corrupt stores fail closed without destructive recovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-recovery-'));
  const file = path.join(dir, 'sessions.json');
  try {
    const store = new AgencySessionStore(file);
    await writeFile(file, JSON.stringify({ version: 2, sessions: [sampleSession()] }));
    await assert.rejects(store.load(), (error: unknown) =>
      error instanceof UnsupportedAgencySessionSchemaError);
    assert.ok((await readFile(file, 'utf8')).includes('"version":2'));
    await writeFile(file, '{bad');
    await writeFile(file + '.bak', '{also bad');
    await assert.rejects(store.load(), AggregateError);
    assert.equal(await readFile(file, 'utf8'), '{bad');
    assert.equal(await readFile(file + '.bak', 'utf8'), '{also bad');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class DisposableWorkspaceStore extends WorkspaceStore {
  override save(_state: WorkspaceState): void {}
}

async function until(predicate: () => boolean, maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error('Timed out waiting for PTY output');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test('real disposable node-pty shell: cwd, input, resize, replay, detach, Ctrl+C and exit', {
  skip: process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-live-pty-'));
  const registry = new TerminalRegistry(new AgentRegistry([]),
    { file: '/bin/sh', args: ['-i'], name: 'sh' }, new DisposableWorkspaceStore());
  try {
    const shell = await registry.open({ cwd, kind: 'shell', cols: 80, rows: 24, agencyManaged: true });
    const id = shell.terminalId;
    assert.equal(shell.cwd, cwd);
    let output = '';
    const listener = (_id: TerminalId, chunk: string): void => { output += chunk; };
    const first = registry.attach(id, listener);
    assert.notEqual(first, null);
    registry.write(id, 'pwd\r');
    await until(() => output.includes(cwd));
    assert.equal(registry.resize(id, 101, 37), true);
    registry.write(id, 'stty size\r');
    await until(() => /37 101/.test(output));
    registry.write(id, "printf '%s%s\\n' 'SLEEP_' 'STARTED'; sleep 60\r");
    await until(() => output.includes('SLEEP_STARTED'));
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    registry.write(id, '\x03');
    registry.write(id, "printf '%s%s:%s\\n' 'INTERRUPT_' 'STATUS' \"$?\"\r");
    await until(() => /INTERRUPT_STATUS:130\r?\n/.test(output));
    registry.write(id, "printf '\\033[32m%s%s\\033[0m\\n' 'EXECUTED_' 'GREEN'\r");
    await until(() => output.includes('\x1b[32mEXECUTED_GREEN\x1b[0m'));
    registry.detach(id, listener);
    assert.equal(registry.has(id), true);
    const replay = registry.attach(id, listener);
    assert.notEqual(replay, null);
    assert.ok(replay!.replay.includes(cwd));
    assert.equal(registry.get(id)?.terminalId, id);
    const exited = new Promise<{ code: number; signal: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for PTY exit')), 7000);
      registry.on('exit', (terminalId, code, signal) => {
        if (terminalId !== id) return;
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(registry.write(id, 'exit 42\r'), true);
    const result = await exited;
    assert.equal(result.code, 42);
    assert.equal(registry.get(id)?.exitCode, 42);
    assert.equal(registry.close(id), true);
    assert.equal(registry.has(id), false);
  } finally {
    registry.disposeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('native adapter onSpawned is invoked exactly once by real registry PTY', {
  skip: process.platform !== 'linux',
  timeout: 12_000,
}, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-native-hook-'));
  const nativeId = randomUUID();
  const token = randomUUID();
  let launchedByAdapter = 0;
  let spawned = 0;
  let canceled = 0;
  let seen: SpawnedContext | null = null;
  const fakeAdapter = {
    id: 'codex',
    launch: () => {
      launchedByAdapter += 1;
      throw new Error('Original adapter launch must NOT run twice');
    },
    onSpawned: (ctx: SpawnedContext) => {
      spawned++;
      seen = ctx;
      ctx.reportSessionId(nativeId);
      return { cancel: () => { canceled++; } };
    },
    environment: (base: NodeJS.ProcessEnv) => ({
      env: Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] =>
        entry[1] !== undefined)),
      notice: null,
    }),
  } as unknown as AgentAdapter;
  const registry = new TerminalRegistry(new AgentRegistry([fakeAdapter]), null,
    new DisposableWorkspaceStore());
  try {
    const created = await registry.open({
      cwd, kind: 'agent', agent: 'codex', cols: 80, rows: 24, agencyManaged: true,
      agencyLaunch: {
        file: '/bin/sh', args: ['-i'], env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
        session: { kind: 'discover' }, launchToken: token, proposedSessionId: randomUUID(),
        nativeIdentity: Object.freeze({ provider: 'codex', home: path.join(cwd, 'native-home') }),
      },
    });
    assert.equal(launchedByAdapter, 0);
    assert.equal(spawned, 1);
    assert.equal(created.sessionId, nativeId);
    assert.equal(registry.get(created.terminalId)?.sessionId, nativeId);
    assert.equal((seen as SpawnedContext | null)?.launchToken, token);
    assert.deepEqual((seen as SpawnedContext | null)?.nativeIdentity, { provider: 'codex', home: path.join(cwd, 'native-home') });
    assert.ok(Object.isFrozen(registry.nativeIdentityOf(created.terminalId)));
    assert.equal((seen as SpawnedContext | null)?.resumed, false);
    assert.equal(registry.close(created.terminalId), true);
    assert.equal(canceled, 1);
  } finally {
    registry.disposeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('inactive resume ownership survives restart: same verified home transfers, other and legacy homes refuse', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-resume-owner-'));
  const store = new MemoryStore();
  let home = path.join(cwd, 'account-a');
  const resolveLaunch: AgencyProfileLaunchProvider['resolveLaunch'] = async (input) => ({
    ...input, provider: 'codex', file: '/bin/echo', args: [], env: {},
    nativeIdentity: Object.freeze({ provider: 'codex', home }),
    session: input.resumeNativeSessionId === null ? { kind: 'discover' } :
      { kind: 'known', sessionId: input.resumeNativeSessionId },
  });
  const first = fixture(cwd, { store, resolveLaunch });
  let restarted: ReturnType<typeof fixture> | undefined;
  try {
    await first.runtime.initialize();
    const id = randomUUID();
    const owned = await first.runtime.create({ workspaceId: first.one.id, kind: 'agent',
      profileId: agentProfile, cols: 80, rows: 24, resumeNativeSessionId: id });
    first.terminals.exit(owned.terminalId!, 0);
    await new Promise<void>((done) => setImmediate(done));
    first.runtime.dispose();
    restarted = fixture(cwd, { store, resolveLaunch });
    await restarted.runtime.initialize();
    home = path.join(cwd, 'account-b');
    await assert.rejects(restarted.runtime.create({ workspaceId: restarted.one.id, kind: 'agent',
      profileId: 'codex-3' as CliProfileId, cols: 80, rows: 24, resumeNativeSessionId: id }), /another home/);
    assert.equal(restarted.terminals.opens.length, 0);
    home = path.join(cwd, 'account-a');
    const transferred = await restarted.runtime.create({ workspaceId: restarted.one.id, kind: 'agent',
      profileId: 'codex-3' as CliProfileId, cols: 80, rows: 24, resumeNativeSessionId: id });
    assert.equal(transferred.nativeSessionId, id);
    restarted.terminals.exit(transferred.terminalId!, 0);
    await new Promise<void>((done) => setImmediate(done));
    restarted.runtime.dispose();
    // Legacy metadata cannot acquire trusted ownership by restarting.
    store.data = store.data.filter((s) => s.id === owned.id).map((s) => {
      const legacy = { ...s };
      if (legacy.kind === 'agent') delete legacy.nativeIdentity;
      return legacy;
    });
    restarted = fixture(cwd, { store, resolveLaunch });
    await restarted.runtime.initialize();
    await assert.rejects(restarted.runtime.create({ workspaceId: restarted.one.id, kind: 'agent',
      profileId: agentProfile, cols: 80, rows: 24, resumeNativeSessionId: id }), /unverified/);
    assert.equal(restarted.terminals.opens.length, 0);
  } finally {
    first.runtime.dispose();
    restarted?.runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('opaque Codex identity keeps its PTY usable while discovery and resume fail closed', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-opaque-home-'));
  const f = fixture(cwd, { resolveLaunch: async (input) => ({ ...input,
    provider: 'codex', file: '/bin/echo', args: ['literal words'], env: {}, nativeIdentity: null,
    session: input.resumeNativeSessionId === null ? { kind: 'discover' } :
      { kind: 'known', sessionId: input.resumeNativeSessionId },
  }) });
  try {
    await f.runtime.initialize();
    const session = await f.runtime.create({ workspaceId: f.one.id, kind: 'agent',
      profileId: agentProfile, cols: 80, rows: 24 });
    assert.equal(session.lifecycle, 'running');
    assert.equal(session.kind === 'agent' && session.historyAvailability, 'unavailable');
    assert.equal(f.terminals.opens[0]!.agencyLaunch?.acceptNativeSessionId?.(session.terminalId!, randomUUID()), false);
    assert.equal(f.terminals.write(session.terminalId!, 'native interactive input'), true);
    assert.equal(f.runtime.get(session.id)?.nativeSessionId, null);
    await assert.rejects(f.runtime.create({ workspaceId: f.two.id, kind: 'agent',
      profileId: agentProfile, cols: 80, rows: 24, resumeNativeSessionId: randomUUID() }), /unverified/);
    assert.equal(f.terminals.opens.length, 1);
  } finally { f.runtime.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
