import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { CliProfileId } from '@agent-workbench/shared';
import { AgentRegistry } from '../registry.js';
import { createCodexAdapter } from '../codex/index.js';
import { createClaudeCodeAdapter } from '../claude-code/index.js';
import { createAntigravityAdapter } from '../antigravity/index.js';
import { createOpenCodeAdapter } from '../opencode/index.js';
import { createPiAdapter } from '../pi/index.js';
import { NativeIdentities } from '../../agency/native-identity.js';
import { defaultDefinitions, isolatedEnvironment } from './definition.js';
import { resolveConfiguredExecutable } from './executable.js';
import { AgencyProfileStore } from '../../agency/agency-profile-store.js';
import { buildAgencyProfileLaunch, inspectAgencyProfile } from '../../agency/agency-profile-capabilities.js';

const asId = (value: string): CliProfileId => value as CliProfileId;
const UUID1 = '00000000-0000-4000-8000-000000000001';
const UUID2 = '00000000-0000-4000-8000-000000000002';
const UUID3 = '00000000-0000-4000-8000-000000000003';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agency-profiles-test-'));
  const file = path.join(root, 'profiles.json');
  const binary = path.join(root, 'agent original');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(binary, 0o700);
  const store = new AgencyProfileStore(file);
  return { root, file, binary, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function nativeRegistry() {
  return new AgentRegistry([
    createCodexAdapter(), createClaudeCodeAdapter(), createAntigravityAdapter(),
    createOpenCodeAdapter(), createPiAdapter(),
  ]);
}

test('all ten named profiles start unconfigured, without account alias fallback', async () => {
  const f = await fixture();
  try {
    const defs = await f.store.listDefinitions();
    assert.deepEqual(defs.map((x) => x.id), [
      'codex-0', 'codex-1', 'codex-3',
      'agy-0', 'agy-1', 'agy-2', 'agy-3', 'agy-4', 'agy-5',
      'claude-code',
    ]);
    assert.ok(defs.every((x) => x.executable === '' && x.args.length === 0));
    assert.equal(defaultDefinitions().length, 10);
    const status = await inspectAgencyProfile(defs[0]!, nativeRegistry());
    assert.equal(status.configurationStatus, 'error');
    assert.equal(status.capabilities.canLaunch, false);
  } finally { await f.cleanup(); }
});

test('profile persistence retains literal argument boundaries, labels and reviewed overrides', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), {
      executable: f.binary, label: 'Work',
      args: ['--config', 'foo="literal with spaces"', 'one two', 'semi;colon'],
      environmentOverrides: { LANG: 'pt_PT.UTF-8', TERM: 'xterm-256color' },
    });
    const reopened = new AgencyProfileStore(f.file);
    const item = await reopened.getDefinition(asId('codex-0'));
    assert.deepEqual(item?.args, ['--config', 'foo="literal with spaces"', 'one two', 'semi;colon']);
    assert.deepEqual({ ...item?.environmentOverrides }, { LANG: 'pt_PT.UTF-8', TERM: 'xterm-256color' });
    assert.equal(item?.label, 'Work');
    assert.equal((await reopened.getDefinition(asId('codex-1')))?.executable, '');
    const raw = await readFile(f.file, 'utf8');
    assert.equal(raw.includes('auth.json'), false);
    assert.equal(JSON.parse(raw).schemaVersion, 1);
  } finally { await f.cleanup(); }
});

test('invalid fields, credentials and secret environment keys cannot persist', async () => {
  const f = await fixture();
  try {
    for (const changes of [
      { environmentOverrides: { CODEX_HOME: '/another-account' } },
      { environmentOverrides: { ANTHROPIC_API_KEY: 'secret' } },
      { args: ['--api-key=secret'] },
      { args: ['--auth-token', 'secret'] },
      { args: ['--token', 'secret'] },
      { args: 'split by accident' },
      { provider: 'antigravity' },
      { executable: 'bad\nvalue' },
    ]) {
      await assert.rejects(f.store.configure(asId('codex-0'), changes as never));
    }
    assert.equal((await f.store.getDefinition(asId('codex-0')))?.executable, '');
  } finally { await f.cleanup(); }
});

test('atomic sequential configuration retains both concurrent distinct-profile updates', async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.store.configure(asId('codex-0'), { executable: f.binary }),
      f.store.configure(asId('agy-2'), { executable: f.binary, args: ['--safe-flag'] }),
    ]);
    assert.equal((await f.store.getDefinition(asId('codex-0')))?.executable, f.binary);
    assert.deepEqual((await f.store.getDefinition(asId('agy-2')))?.args, ['--safe-flag']);
  } finally { await f.cleanup(); }
});

test('corrupt primary recovers only from validated backup, preserving corrupt bytes', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), { executable: f.binary });
    await f.store.configure(asId('codex-1'), { executable: f.binary, args: ['--profile', 'other'] });
    await writeFile(f.file, '{ invalid json');
    const recovered = await f.store.listDefinitions();
    assert.equal(recovered.find((x) => x.id === 'codex-0')?.executable, f.binary);
    assert.equal(recovered.find((x) => x.id === 'codex-1')?.executable, '');
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(f.root);
    assert.ok(names.some((name) => name.startsWith('profiles.json.corrupt-')));
  } finally { await f.cleanup(); }
});

test('missing or invalid executable is reported without any provider fallback', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), { executable: f.binary });
    await f.store.configure(asId('codex-1'), { executable: path.join(f.root, 'missing') });
    const definitions = await f.store.listDefinitions();
    const registry = nativeRegistry();
    const a = await inspectAgencyProfile(definitions[0]!, registry);
    const b = await inspectAgencyProfile(definitions[1]!, registry);
    assert.equal(a.capabilities.canLaunch, true);
    assert.equal(b.configurationStatus, 'not-installed');
    assert.equal(b.capabilities.canLaunch, false);
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('codex-1'), cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2,
    }));
    assert.equal((await resolveConfiguredExecutable('../codex', process.env)).status, 'error');
    assert.equal((await resolveConfiguredExecutable('codex --help', process.env)).status, 'error');
  } finally { await f.cleanup(); }
});

test('explicit PATH resolution works only for specified command, no inferred binary', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, 'bin');
    await mkdir(dir);
    const named = path.join(dir, 'explicit-agent');
    await writeFile(named, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(named, 0o700);
    const found = await resolveConfiguredExecutable('explicit-agent', { PATH: dir });
    assert.deepEqual(found, { status: 'available', file: named });
    assert.equal((await resolveConfiguredExecutable('codex', { PATH: dir })).status, 'not-installed');
  } finally { await f.cleanup(); }
});

test('native Workbench Codex resume and literal profile args are preserved', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-3'), {
      executable: f.binary, args: ['--config', 'key="space preserving"'],
    });
    const home = path.join(f.root, 'native-home');
    await mkdir(path.join(home, 'archived_sessions'), { recursive: true });
    await writeFile(path.join(home, 'archived_sessions', 'rollout-2026-10-28T00-00-00-' + UUID3 + '.jsonl'), 'synthetic native state\n');
    const manifest = path.join(f.root, 'identities.json');
    await writeFile(manifest, JSON.stringify({ version: 1, identities: [{ profileId: 'codex-3', provider: 'codex',
      executable: f.binary, args: ['--config', 'key="space preserving"'], environmentOverrides: {}, home }] }));
    const identities = await NativeIdentities.load(manifest);
    const launch = await buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('codex-3'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, resumeNativeSessionId: UUID3,
      environment: { PATH: '/bin', TERM: 'xterm', TRACE_TAG: 'base' },
    }, { identities });
    assert.equal(launch.file, f.binary);
    assert.deepEqual(launch.args, ['--config', 'key="space preserving"', 'resume', '--no-alt-screen', UUID3]);
    assert.deepEqual(launch.session, { kind: 'known', sessionId: UUID3 });
    assert.equal(launch.env['TRACE_TAG'], 'base');
  } finally { await f.cleanup(); }
});

test('Claude native resume flags and isolated per-process environment', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('claude-code'), {
      executable: f.binary, environmentOverrides: { LANG: 'pt_PT.UTF-8' },
    });
    const base = { PATH: '/usr/bin', LANG: 'en_US.UTF-8', CLAUDE_CODE_CHILD_SESSION: '1' };
    const before = JSON.stringify(base);
    const launch = await buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('claude-code'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, environment: base,
    });
    const native = createClaudeCodeAdapter().launch({ location: { file: f.binary, resolvedPath: f.binary, prefixArgs: [], version: null },
      cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2, resumeSessionId: UUID3 });
    assert.deepEqual((await native).args.slice(-2), ['--resume', UUID3]);
    await assert.rejects(buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('claude-code'), cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2,
      resumeNativeSessionId: UUID3 }), /home is unverified/);
    assert.equal(launch.env['LANG'], 'pt_PT.UTF-8');
    assert.equal(launch.env['CLAUDE_CODE_CHILD_SESSION'], undefined);
    assert.equal(JSON.stringify(base), before);
    assert.equal(launch.environmentNotice, 'child-session-marker');
    const other = isolatedEnvironment(base, { LANG: 'en_US.UTF-8' }, {});
    assert.equal(other['LANG'], 'en_US.UTF-8');
    assert.equal(base.LANG, 'en_US.UTF-8');
  } finally { await f.cleanup(); }
});

test('unsupported model/effort stays unavailable with no catalog or silent application', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('agy-0'), { executable: f.binary });
    const registry = nativeRegistry();
    const definition = (await f.store.getDefinition(asId('agy-0')))!;
    const caps = (await inspectAgencyProfile(definition, registry)).capabilities;
    assert.equal(caps.discovery, 'unavailable');
    assert.equal(caps.canSelectModel, false);
    assert.equal(caps.canSelectEffort, false);
    assert.deepEqual(caps.models, []);
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('agy-0'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, model: 'not-a-real-model',
    }));
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('agy-0'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, effort: 'high',
    }));
  } finally { await f.cleanup(); }
});

test('disabled, invalid native ID and unavailable profiles cannot launch', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), { executable: f.binary, disabled: true });
    const registry = nativeRegistry();
    const disabled = (await f.store.getDefinition(asId('codex-0')))!;
    assert.equal((await inspectAgencyProfile(disabled, registry)).configurationStatus, 'disabled');
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('codex-0'), cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2,
    }));
    await f.store.configure(asId('codex-0'), { disabled: false });
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('codex-0'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, resumeNativeSessionId: '--unexpected',
    }));
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('codex-0'), cwd: '/path/that/does/not/exist',
      proposedSessionId: UUID1, launchToken: UUID2,
    }));
  } finally { await f.cleanup(); }
});

test('Antigravity native resume retains --conversation and literal profile arguments', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('agy-5'), {
      executable: f.binary, args: ['--flag', 'two literal words'],
    });
    const launch = await buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('agy-5'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2,
    });
    assert.deepEqual(launch.args.slice(0, 2), ['--flag', 'two literal words']);
    const native = await createAntigravityAdapter().launch({ location: { file: f.binary, resolvedPath: f.binary, prefixArgs: [], version: null },
      cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2, resumeSessionId: UUID3 });
    assert.deepEqual(native.args.slice(-2), ['--conversation', UUID3]);
    assert.deepEqual(native.session, { kind: 'known', sessionId: UUID3 });
    await assert.rejects(buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('agy-5'), cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2,
      resumeNativeSessionId: UUID3 }), /home is unverified/);
  } finally { await f.cleanup(); }
});

test('independent profile environments never cross-contaminate each other or global state', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), {
      executable: f.binary, environmentOverrides: { LANG: 'pt_PT.UTF-8' },
    });
    await f.store.configure(asId('codex-3'), {
      executable: f.binary, environmentOverrides: { LANG: 'fr_FR.UTF-8' },
    });
    const globalBefore = process.env['LANG'];
    const base = { LANG: 'en_US.UTF-8', PATH: '/bin' };
    const inputs = { cwd: f.root, proposedSessionId: UUID1, launchToken: UUID2, environment: base };
    const registry = nativeRegistry();
    const [a, b] = await Promise.all([
      buildAgencyProfileLaunch(f.store, registry, { ...inputs, profileId: asId('codex-0') }),
      buildAgencyProfileLaunch(f.store, registry, { ...inputs, profileId: asId('codex-3') }),
    ]);
    assert.equal(a.env['LANG'], 'pt_PT.UTF-8');
    assert.equal(b.env['LANG'], 'fr_FR.UTF-8');
    a.env['LANG'] = 'changed-only-in-a';
    assert.equal(b.env['LANG'], 'fr_FR.UTF-8');
    assert.equal(base.LANG, 'en_US.UTF-8');
    assert.equal(process.env['LANG'], globalBefore);
  } finally { await f.cleanup(); }
});

test('named symlinked entrypoints preserve distinct CLI wrapper invocation identity', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, 'bin');
    await mkdir(bin);
    const shared = path.join(bin, 'native-dispatcher');
    await writeFile(shared, '#!/bin/sh\nprintf "%s\\n" "${0##*/}"\n', { mode: 0o700 });
    await chmod(shared, 0o700);
    const first = path.join(bin, 'codex-0');
    const second = path.join(bin, 'codex-1');
    await symlink(shared, first);
    await symlink(shared, second);
    await f.store.configure(asId('codex-0'), { executable: 'codex-0' });
    await f.store.configure(asId('codex-1'), { executable: 'codex-1' });
    const env = { PATH: bin };
    const a = await buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('codex-0'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, environment: env,
    });
    const b = await buildAgencyProfileLaunch(f.store, nativeRegistry(), {
      profileId: asId('codex-1'), cwd: f.root, proposedSessionId: UUID1,
      launchToken: UUID2, environment: env,
    });
    assert.equal(a.file, first);
    assert.equal(b.file, second);
    assert.notEqual(a.file, b.file);
    assert.equal(execFileSync(a.file, [...a.args], { encoding: 'utf8' }).trim(), 'codex-0');
    assert.equal(execFileSync(b.file, [...b.args], { encoding: 'utf8' }).trim(), 'codex-1');
    // Absolute symlink paths preserve identity without PATH lookup as well.
    assert.deepEqual(await resolveConfiguredExecutable(first, {}), { status: 'available', file: first });
  } finally { await f.cleanup(); }
});

test('missing primary recovers from valid backup instead of defaulting all profiles', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), { executable: f.binary });
    await f.store.configure(asId('agy-2'), { executable: f.binary });
    const before = await readFile(f.file + '.bak', 'utf8');
    await rm(f.file);
    const restored = await f.store.listDefinitions();
    assert.equal(restored.find((x) => x.id === 'codex-0')?.executable, f.binary);
    assert.equal(restored.find((x) => x.id === 'agy-2')?.executable, '');
    assert.deepEqual(await f.store.listDefinitions(), restored);
    assert.equal(await readFile(f.file + '.bak', 'utf8'), before);
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).schemaVersion, 1);
  } finally { await f.cleanup(); }
});

test('future schema fails closed even with older valid backup, without overwriting data', async () => {
  const f = await fixture();
  try {
    await f.store.configure(asId('codex-0'), { executable: f.binary });
    await f.store.configure(asId('codex-1'), { executable: f.binary, args: ['--profile', 'other'] });
    const backupBefore = await readFile(f.file + '.bak', 'utf8');
    const future = JSON.stringify({ schemaVersion: 2, profiles: [{ future: 'keep me' }] }) + '\n';
    await writeFile(f.file, future);
    await assert.rejects(f.store.listDefinitions(), /Unsupported Agency profile store schema version: 2/);
    await assert.rejects(f.store.configure(asId('codex-0'), { label: 'MUST_NOT_CHANGE' }), /Unsupported Agency profile store schema version: 2/);
    assert.equal(await readFile(f.file, 'utf8'), future);
    assert.equal(await readFile(f.file + '.bak', 'utf8'), backupBefore);
    assert.equal((await readdir(f.root)).some((name) => name.startsWith('profiles.json.corrupt-')), false);
  } finally { await f.cleanup(); }
});

test('missing primary with unsupported backup fails closed without resetting configuration', async () => {
  const f = await fixture();
  try {
    const future = JSON.stringify({ schemaVersion: 2, profiles: [] });
    await writeFile(f.file + '.bak', future);
    await assert.rejects(f.store.listDefinitions(), /Unsupported Agency profile store schema version: 2/);
    await assert.rejects(readFile(f.file, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(f.file + '.bak', 'utf8'), future);
  } finally { await f.cleanup(); }
});

test('corruption without valid backup refuses to silently replace existing state', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, '{ malformed');
    await assert.rejects(f.store.listDefinitions(), /no valid backup exists/);
    assert.equal(await readFile(f.file, 'utf8'), '{ malformed');
    assert.equal((await readdir(f.root)).some((name) => name.startsWith('profiles.json.corrupt-')), false);
  } finally { await f.cleanup(); }
});

test('C-1: two profiles with an identical launch plan (same account) are refused at configure, inspect and launch', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'alias');
    await symlink(f.binary, alias);
    await f.store.configure(asId('codex-0'), { executable: f.binary });
    await assert.rejects(f.store.configure(asId('codex-1'), { executable: f.binary }), /Same executable and arguments as Codex 00/);
    // Different args may select another account: allowed. A different symlinked entry point is a distinct wrapper.
    await f.store.configure(asId('codex-1'), { executable: f.binary, args: ['--profile', 'second'] });
    await f.store.configure(asId('codex-3'), { executable: alias });
    // Other providers may share a binary path.
    await f.store.configure(asId('agy-0'), { executable: f.binary });

    // A pre-existing duplicate on disk (older build) is surfaced and cannot launch.
    const raw = JSON.parse(await readFile(f.file, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.profiles;
    rows.find((row: { id: string }) => row.id === 'codex-1').args = [];
    await writeFile(f.file, JSON.stringify(raw));
    const registry = nativeRegistry();
    const { listAgencyProfiles } = await import('../../agency/agency-profile-capabilities.js');
    const listed = await listAgencyProfiles(f.store, registry);
    for (const id of ['codex-0', 'codex-1']) {
      const profile = listed.find((p) => p.id === id)!;
      assert.equal(profile.configurationStatus, 'error');
      assert.equal(profile.capabilities.canLaunch, false);
      assert.match(profile.configurationMessage ?? '', /same native account/);
    }
    assert.equal(listed.find((p) => p.id === 'codex-3')!.capabilities.canLaunch, true);
    await assert.rejects(buildAgencyProfileLaunch(f.store, registry, {
      profileId: asId('codex-1'), cwd: await (await import('node:fs/promises')).realpath(f.root), proposedSessionId: UUID1, launchToken: UUID2,
    }), /same native account/);
  } finally { await f.cleanup(); }
});

test('profile creation, editing, multiple accounts per provider, and deletion across all providers', async () => {
  const f = await fixture();
  try {
    const registry = nativeRegistry();

    // 1. Create profiles for each supported provider: codex, antigravity, claude-code, opencode, pi
    const pCodex = await f.store.createProfile({
      provider: 'codex',
      label: 'Codex Custom',
      executable: f.binary,
      args: ['--account', 'work'],
      environmentOverrides: { LANG: 'en_US.UTF-8' },
    });
    assert.equal(pCodex.provider, 'codex');
    assert.equal(pCodex.label, 'Codex Custom');
    assert.deepEqual(pCodex.args, ['--account', 'work']);

    const pOpenCode = await f.store.createProfile({
      provider: 'opencode',
      label: 'OpenCode Main',
      executable: f.binary,
      args: ['--model', 'local'],
    });
    assert.equal(pOpenCode.provider, 'opencode');
    assert.equal(pOpenCode.label, 'OpenCode Main');

    const pPi = await f.store.createProfile({
      provider: 'pi',
      label: 'Pi Agent',
      executable: f.binary,
      args: ['--quiet'],
    });
    assert.equal(pPi.provider, 'pi');
    assert.equal(pPi.label, 'Pi Agent');

    // 2. Multiple accounts per provider
    const pCodex2 = await f.store.createProfile({
      provider: 'codex',
      label: 'Codex Secondary',
      executable: f.binary,
      args: ['--account', 'personal'],
    });
    assert.notEqual(pCodex.id, pCodex2.id);

    // 3. Inspect profiles with native registry
    const inspectedOpenCode = await inspectAgencyProfile(pOpenCode, registry);
    assert.equal(inspectedOpenCode.provider, 'opencode');
    assert.equal(inspectedOpenCode.configurationStatus, 'available');
    assert.equal(inspectedOpenCode.capabilities.canLaunch, true);

    const inspectedPi = await inspectAgencyProfile(pPi, registry);
    assert.equal(inspectedPi.provider, 'pi');
    assert.equal(inspectedPi.configurationStatus, 'available');
    assert.equal(inspectedPi.capabilities.canLaunch, true);

    // 4. Rename / edit profile
    const renamed = await f.store.configure(pOpenCode.id, {
      label: 'OpenCode Renamed',
      args: ['--model', 'remote'],
    });
    assert.equal(renamed.label, 'OpenCode Renamed');
    assert.deepEqual(renamed.args, ['--model', 'remote']);

    const fetched = await f.store.getDefinition(pOpenCode.id);
    assert.equal(fetched?.label, 'OpenCode Renamed');
    assert.deepEqual(fetched?.args, ['--model', 'remote']);

    // 5. Delete profile and ensure persistence across reload
    await f.store.deleteProfile(pOpenCode.id);
    assert.equal(await f.store.getDefinition(pOpenCode.id), null);

    const reloaded = new AgencyProfileStore(f.file);
    assert.equal(await reloaded.getDefinition(pOpenCode.id), null);

    // Built-in profile deletion does not resurrect
    await f.store.deleteProfile(asId('codex-3'));
    assert.equal(await f.store.getDefinition(asId('codex-3')), null);
    const reloaded2 = new AgencyProfileStore(f.file);
    assert.equal(await reloaded2.getDefinition(asId('codex-3')), null);
  } finally { await f.cleanup(); }
});
