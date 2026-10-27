import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
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

const agentProfile = 'codex00' as CliProfileId;
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
  options: { store?: AgencySessionStore; resolveLaunch?: AgencyProfileLaunchProvider['resolveLaunch'] } = {},
) {
  const terminals = new FakeTerminals();
  const workspaces = new Map<WorkspaceId, AgencyWorkspace>();
  const one = workspace(cwd);
  const two = workspace(cwd);
  workspaces.set(one.id, one);
  workspaces.set(two.id, two);
  const profiles: AgencyProfileLaunchProvider = {
    resolveLaunch: options.resolveLaunch ?? (async ({profileId, cwd, resumeNativeSessionId, proposedSessionId, launchToken}) => ({
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
    assert.deepEqual(await store.load(), []);
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

test('native conversation controller is exclusive across workspaces', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agency-c-'));
  const f = fixture(cwd, {
    resolveLaunch: async ({ profileId, resumeNativeSessionId, proposedSessionId, launchToken, cwd }) => ({
      profileId,
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
      profileId: 'codex01' as CliProfileId,
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
      provider: profileId === ('agy00' as CliProfileId) ? 'antigravity' : 'codex',
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
      kind: 'agent', profileId: 'agy00' as CliProfileId, workspaceId: f.two.id, cols: 80, rows: 24,
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
      workspaceId: f.one.id, kind: 'agent', profileId: 'codex00' as CliProfileId,
      cols: 80, rows: 24, resumeNativeSessionId: id,
    });
    await assert.rejects(f.runtime.create({
      workspaceId: f.two.id, kind: 'agent', profileId: 'codex03' as CliProfileId,
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
