/**
 * Child process stdio failures must fail the operation that owns the child, never the server process.
 * Every child here is a tiny `node -e` script, not a real CLI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenCodeServeProcess, ServeStartError } from '../../../src/agents/opencode/serve-process.js';
import { ignoredAmong } from '../../../src/features/worktrees/git.js';
import { filterIgnored } from '../../../src/features/git/git-repo.js';

const NODE_LOCATION = (script: string) => ({
  resolvedPath: process.execPath,
  file: process.execPath,
  prefixArgs: ['-e', script],
  version: null,
});

async function serveWith(script: string, t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'maw-serve-test-'));
  const children: ChildProcess[] = [];
  const serve = new OpenCodeServeProcess({
    location: NODE_LOCATION(script),
    baseEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    cwd,
    startTimeoutMs: 10_000,
    spawn: ((file: string, args: readonly string[], options: object) => {
      const child = nodeSpawn(file, args, options);
      children.push(child);
      return child;
    }) as typeof nodeSpawn,
  });
  t.after(async () => {
    await serve.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { serve, children };
}

const LISTEN = `process.stdout.write('opencode server listening on http://127.0.0.1:45999\\n'); setInterval(() => {}, 1000);`;

describe('opencode serve child stdio', () => {
  it('a child that dies before listening fails the start with its exit, not the server', async (t) => {
    const { serve } = await serveWith(`process.stderr.write('boom\\n'); process.exit(3);`, t);
    await assert.rejects(serve.ensure(), (error: unknown) => {
      assert.ok(error instanceof ServeStartError);
      assert.match(error.message, /exited before listening \(code 3\): boom/);
      return true;
    });
  });

  it('an output pipe failure (EPIPE) before listening fails the start with a meaningful error', async (t) => {
    const { serve, children } = await serveWith(`setInterval(() => {}, 1000);`, t);
    const starting = serve.ensure();
    await new Promise((resolve) => setImmediate(resolve));
    while (children.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    children[0]!.stdout!.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await assert.rejects(starting, /output pipe failed \(EPIPE\)/);
  });

  it('pipe and process errors after listening are handled, repeatedly, without crashing', async (t) => {
    const { serve, children } = await serveWith(LISTEN, t);
    const endpoint = await serve.ensure();
    assert.equal(endpoint.url, 'http://127.0.0.1:45999');
    const child = children[0]!;
    // Two process errors: a `once` listener would leave the second one uncaught.
    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    child.stderr!.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still the same healthy endpoint.
    assert.deepEqual(await serve.ensure(), endpoint);
  });
});

describe('git helpers writing to a child stdin', { skip: process.platform === 'win32' }, () => {
  /** Puts a fake `git` first in PATH that exits at once without reading stdin. */
  async function fakeGit(t: { after: (fn: () => Promise<void>) => void }) {
    const dir = await mkdtemp(path.join(tmpdir(), 'maw-fake-git-'));
    const file = path.join(dir, 'git');
    await writeFile(file, `#!${process.execPath}\nprocess.exit(2);\n`);
    await chmod(file, 0o755);
    const previous = process.env['PATH'];
    process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`;
    t.after(async () => {
      process.env['PATH'] = previous;
      await rm(dir, { recursive: true, force: true });
    });
    return dir;
  }

  // ~8 MB of input: far beyond the pipe buffer, so the write is still in progress when the child exits.
  const MANY = Array.from({ length: 200_000 }, (_, i) => `some/deep/path/number-${i}/file-${i}.txt`);

  it('worktrees/git: the child exits mid-write; the EPIPE fails the operation, not the process', async (t) => {
    const cwd = await fakeGit(t);
    assert.equal(await ignoredAmong(cwd, MANY), null);
  });

  it('git-repo filterIgnored: the child exits mid-write; the result is empty, not a crash', async (t) => {
    const cwd = await fakeGit(t);
    const ignored = await filterIgnored(cwd, MANY);
    assert.equal(ignored.size, 0);
  });
});
