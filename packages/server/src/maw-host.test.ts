import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireStoreOwnership, publishReadiness } from './maw-host.js';

test('single store owner, independent stores, and release without stale files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-owner-'));
  const first = await acquireStoreOwnership(dir);
  try {
    if (process.platform !== 'linux') return;
    await assert.rejects(acquireStoreOwnership(dir), { code: 'EADDRINUSE' });
    await new Promise<void>(resolve => first!.close(() => resolve()));
    const next = await acquireStoreOwnership(dir);
    await new Promise<void>(resolve => next!.close(() => resolve()));
  } finally { first?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('readiness is private, current, and removed on orderly shutdown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-ready-'));
  try {
    const clear = await publishReadiness(dir, 'http://127.0.0.1:1234/?token=disposable');
    const file = path.join(dir, 'maw-ready.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    await clear();
    await assert.rejects(stat(file), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('kernel store ownership is released after an abrupt server crash', async () => {
  if (process.platform !== 'linux') return;
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-crash-'));
  const moduleUrl = new URL('./maw-host.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireStoreOwnership } from ${JSON.stringify(moduleUrl)}; await acquireStoreOwnership(${JSON.stringify(dir)}); process.stdout.write('ready');`],
    { cwd: path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', code => reject(new Error('ownership fixture exited ' + code)));
    });
    await assert.rejects(acquireStoreOwnership(dir), { code: 'EADDRINUSE' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
    const recovered = await acquireStoreOwnership(dir);
    await new Promise<void>(resolve => recovered!.close(() => resolve()));
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('control uses current private readiness, refuses stale PIDs and never prints the token', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const temp = await mkdtemp(path.join(tmpdir(),'maw-control-'));
  const bin = path.join(temp,'bin'); await (await import('node:fs/promises')).mkdir(bin);
  await writeFile(path.join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$MAW_TEST_PID"\n',{mode:0o700});
  const server = createServer((request,response) => { response.statusCode=request.url?.includes('token=disposable-secret') ? 200 : 401; response.end(); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const control=fileURLToPath(new URL('../../../scripts/maw/control.mjs',import.meta.url));
  const runtime=path.join(temp,'maw');
  const clear=await publishReadiness(runtime,`http://127.0.0.1:${address.port}/?token=disposable-secret`);
  const environment={...process.env,XDG_RUNTIME_DIR:temp,PATH:bin+':'+process.env.PATH,MAW_TEST_PID:String(process.pid)};
  try {
    const status=await run(process.execPath,[control,'status'],{cwd:'/',env:environment});
    assert.match(status.stdout,/Healthy/); assert.ok(!status.stdout.includes('disposable-secret'));
    await assert.rejects(run(process.execPath,[control,'status'],{cwd:'/',env:{...environment,MAW_TEST_PID:'1'}}));
    await writeFile(path.join(runtime,'maw-ready.json'),JSON.stringify({pid:process.pid,url:'https://example.com/?token=disposable-secret'}),{mode:0o600});
    await assert.rejects(run(process.execPath,[control,'open'],{cwd:'/',env:environment}));
  } finally { await clear(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(temp,{recursive:true,force:true}); }
});
