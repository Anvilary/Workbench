import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileClipboardPayload, fileUri, resolveClipboardTarget } from '../../../file-clipboard.mjs';

test('file clipboard payloads name the file URI rather than only a bare path', () => {
  const payload = fileClipboardPayload('/work/demo/my file.txt');
  const uri = fileUri('/work/demo/my file.txt');
  assert.match(uri, /^file:\/\/\/work\/demo\/my%20file\.txt$/);
  assert.equal(payload.uriList.toString('utf8'), `${uri}\r\n`);
  assert.equal(payload.gnome.toString('utf8'), `copy\n${uri}`);
  assert.equal(payload.uriList.includes(Buffer.from('/work/demo/my file.txt')), false);
});

test('resolveClipboardTarget stays inside the workspace and rejects escaping symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-clip-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'maw-clip-out-'));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'note.txt'), 'hello');
    await symlink(path.join(outside, 'secret'), path.join(root, 'escape'));
    const file = await resolveClipboardTarget(root, 'nested/note.txt');
    assert.equal(file.ok, true);
    assert.equal(file.directory, false);
    assert.equal(file.absolute, path.join(root, 'nested', 'note.txt'));
    const link = await resolveClipboardTarget(root, 'escape');
    assert.equal(link.ok, false);
    assert.equal((await resolveClipboardTarget(root, '../outside')).ok, false);
    const directory = await resolveClipboardTarget(root, 'nested');
    assert.equal(directory.ok && directory.directory, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('resolveClipboardTarget validates authoritative workspace roots and rejects unauthorized roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-auth-root-'));
  const unauthorized = await mkdtemp(path.join(tmpdir(), 'maw-unauth-root-'));
  try {
    await writeFile(path.join(root, 'valid.txt'), 'authoritative content');
    await writeFile(path.join(unauthorized, 'secret.txt'), 'unauthorized content');

    // 1. Authoritative roots passed in options
    const allowed = await resolveClipboardTarget(root, 'valid.txt', {
      authoritativeRoots: [root],
      requireAuthoritative: true,
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.absolute, path.join(root, 'valid.txt'));

    // 2. Unauthorized cwd rejected with 'denied'
    const denied = await resolveClipboardTarget(unauthorized, 'secret.txt', {
      authoritativeRoots: [root],
      requireAuthoritative: true,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'denied');

    // 3. requireAuthoritative with empty/missing roots fails closed
    const noRoots = await resolveClipboardTarget(root, 'valid.txt', {
      authoritativeRoots: [],
      requireAuthoritative: true,
    });
    assert.equal(noRoots.ok, false);
    assert.equal(noRoots.error, 'denied');

    // 4. Traversal attempt from authoritative root still rejected with 'outside'
    const outside = await resolveClipboardTarget(root, '../other.txt', {
      authoritativeRoots: [root],
      requireAuthoritative: true,
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.error, 'outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(unauthorized, { recursive: true, force: true });
  }
});
