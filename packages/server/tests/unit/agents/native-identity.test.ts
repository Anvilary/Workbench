import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeIdentities } from '../../../src/features/sessions/native-identity.js';
import { defaultDefinitions } from '../../../src/agents/profiles/definition.js';
import { createCodexHistory } from '../../../src/agents/codex/history.js';

test('host identity is immutable and bound to exact executable, argv and environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agency-home-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...defaultDefinitions()[0]!, executable: '/literal/wrapper', args: ['two words'] };
  const manifest = path.join(root, 'identity.json');
  await writeFile(manifest, JSON.stringify({ version: 1, identities: [{ ...profile, profileId: profile.id, home: root }] }));
  const identities = await NativeIdentities.load(manifest);
  const identity = identities.forProfile(profile)!;
  assert.deepEqual(identity, { provider: 'codex', home: root });
  assert.ok(Object.isFrozen(identity));
  assert.throws(() => { (identity as { home: string }).home = '/wrong'; });
  assert.equal(identities.forProfile({ ...profile, executable: '/another/wrapper' }), null);
  assert.equal(identities.forProfile({ ...profile, args: ['two', 'words'] }), null);
  assert.equal(identities.forProfile({ ...profile, environmentOverrides: { LANG: 'C' } }), null);
  assert.equal(identities.forProfile({ ...profile, id: 'codex-b' as typeof profile.id }), null);
  assert.deepEqual(identities.protectedDirs(), [root]);
  await writeFile(manifest, JSON.stringify({ version: 1, identities: [{ ...profile, profileId: profile.id, home: 'relative' }] }));
  await assert.rejects(NativeIdentities.load(manifest), /Invalid/);
  assert.equal((await NativeIdentities.load(path.join(root, 'absent'))).forProfile(profile), null);
});

test('scoped Codex followers reject a global watcher path even for the same native UUID', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agency-follower-homes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  const id = randomUUID();
  const name = `rollout-2026-10-28T00-00-00-${id}.jsonl`;
  const fileA = path.join(a, 'archived_sessions', name);
  await mkdir(path.dirname(fileA), { recursive: true });
  await mkdir(b);
  await writeFile(fileA, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'A_PRIVATE_SYNTHETIC_ONLY' } }) + '\n');
  const history = createCodexHistory();
  for (const nativeHome of [b, null]) {
    const follower = history.follow({ cwd: root, sessionId: id, nativeHome });
    await follower.start();
    assert.equal(follower.noticeChange(fileA), false);
    await follower.poll();
    assert.equal(follower.sourcePath, null);
    assert.deepEqual(follower.getTail(100).events, []);
  }
  const aFollower = history.follow({ cwd: root, sessionId: id, nativeHome: a });
  await aFollower.start();
  await aFollower.poll();
  assert.equal(aFollower.sourcePath, fileA);
  assert.match(JSON.stringify(aFollower.getTail(100)), /A_PRIVATE_SYNTHETIC_ONLY/);
});
