import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireStoreOwnership, publishReadiness } from '../../../src/workbench-host.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-ready-'));
  try {
    const clear = await publishReadiness(dir, 'http://127.0.0.1:1234/?token=disposable');
    const file = path.join(dir, 'workbench-ready.json');
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
  const moduleUrl = new URL('../../../src/workbench-host.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireStoreOwnership } from ${JSON.stringify(moduleUrl)}; await acquireStoreOwnership(${JSON.stringify(dir)}); process.stdout.write('ready');`],
    { cwd: path.dirname(fileURLToPath(new URL('../../../package.json', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
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
  await writeFile(path.join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$WORKBENCH_TEST_PID"\n',{mode:0o700});
  const server = createServer((request,response) => { response.statusCode=request.url?.includes('token=disposable-secret') ? 200 : 401; response.end(); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const control=fileURLToPath(new URL('../../../../../scripts/workbench/control.mjs',import.meta.url));
  const runtime=path.join(temp,'workbench');
  const clear=await publishReadiness(runtime,`http://127.0.0.1:${address.port}/?token=disposable-secret`);
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: temp, PATH: bin + ':' + process.env.PATH, WORKBENCH_TEST_PID: String(process.pid) };
  delete environment.WORKBENCH_RUNTIME_DIR;
  try {
    const status=await run(process.execPath,[control,'status'],{cwd:'/',env:environment});
    assert.match(status.stdout,/Healthy/); assert.ok(!status.stdout.includes('disposable-secret'));
    await assert.rejects(run(process.execPath,[control,'status'],{cwd:'/',env:{...environment,WORKBENCH_TEST_PID:'1'}}));
    await writeFile(path.join(runtime,'workbench-ready.json'),JSON.stringify({pid:process.pid,url:'https://example.com/?token=disposable-secret'}),{mode:0o600});
    await assert.rejects(run(process.execPath,[control,'open'],{cwd:'/',env:environment}));
  } finally { await clear(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(temp,{recursive:true,force:true}); }
});

test('control url omits credentials and open authenticates the specified browser', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile, readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const temp = await mkdtemp(path.join(tmpdir(), 'maw-url-open-'));
  const bin = path.join(temp, 'bin'); await (await import('node:fs/promises')).mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$WORKBENCH_TEST_PID"\n', { mode: 0o700 });
  const logFile = path.join(temp, 'browser.log');
  await writeFile(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf "xdg:%s\\n" "$1" >> "${logFile}"\n`, { mode: 0o700 });
  await writeFile(path.join(bin, 'brave-browser'), `#!/bin/sh\nprintf "brave:%s\\n" "$1" >> "${logFile}"\n`, { mode: 0o700 });

  const server = createServer((request, response) => {
    response.statusCode = request.url?.includes('token=disposable-secret') ? 200 : 401;
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const control = fileURLToPath(new URL('../../../../../scripts/workbench/control.mjs', import.meta.url));
  const maw = fileURLToPath(new URL('../../../../../scripts/workbench/maw', import.meta.url));
  const anvilBench = fileURLToPath(new URL('../../../../../scripts/workbench/anvil-bench', import.meta.url));
  const runtime = path.join(temp, 'workbench');
  const expectedUrl = `http://127.0.0.1:${address.port}/?token=disposable-secret`;
  const clear = await publishReadiness(runtime, expectedUrl);
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: temp, PATH: bin + ':' + process.env.PATH, WORKBENCH_TEST_PID: String(process.pid) };
  delete environment.WORKBENCH_RUNTIME_DIR;
  try {
    const urlOut = await run(process.execPath, [control, 'url'], { cwd: '/', env: environment });
    assert.equal(urlOut.stdout.trim(), new URL(expectedUrl).origin + '/');

    await run(process.execPath, [control, 'open'], { cwd: '/', env: environment });
    await run(process.execPath, [control, 'open', 'brave-browser'], { cwd: '/', env: environment });

    const logs = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.deepEqual(logs, [
      `xdg:${expectedUrl}`,
      `brave:${expectedUrl}`,
    ]);

    const mawUrlOut = await run(maw, ['url'], { cwd: '/', env: environment });
    assert.equal(mawUrlOut.stdout.trim(), new URL(expectedUrl).origin + '/');

    await run(maw, ['open'], { cwd: '/', env: environment });
    await run(maw, ['open', 'brave-browser'], { cwd: '/', env: environment });

    const allLogs = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.deepEqual(allLogs, [
      `xdg:${expectedUrl}`,
      `brave:${expectedUrl}`,
      `xdg:${expectedUrl}`,
      `brave:${expectedUrl}`,
    ]);

    const helpOut = await run(maw, ['help'], { cwd: '/', env: environment });
    assert.match(helpOut.stdout, /Usage: maw \{desktop\|start \[--force\]\|stop\|restart \[--force\]\|rollback\|status\|logs \[--follow\]\|url\|open \[browser\]\|update \[--no-restart\|--restart\] \[--ref <ref> --allow-unapproved-ref\]\|migrate\|help\}/);

    const anvilUrlOut = await run(anvilBench, ['url'], { cwd: '/', env: environment });
    assert.equal(anvilUrlOut.stdout.trim(), new URL(expectedUrl).origin + '/');
    const anvilHelpOut = await run(anvilBench, ['help'], { cwd: '/', env: environment });
    assert.match(anvilHelpOut.stdout, /Usage: anvil-bench \{desktop\|start \[--force\]\|stop\|restart \[--force\]\|rollback\|status\|logs \[--follow\]\|url\|open \[browser\]\|update \[--no-restart\|--restart\] \[--ref <ref> --allow-unapproved-ref\]\|migrate\|help\}/);

    await assert.rejects(run(maw, ['url', 'extra'], { cwd: '/', env: environment }));
    await assert.rejects(run(anvilBench, ['url', 'extra'], { cwd: '/', env: environment }));
    await assert.rejects(run(maw, ['open', 'b1', 'b2'], { cwd: '/', env: environment }));
  } finally {
    await clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});

test('U-10: readiness carries the release identity and control refuses a different release', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile, mkdir, symlink } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { readReleaseIdentity } = await import('../../../src/workbench-host.js');
  const run = promisify(execFile);
  const temp = await mkdtemp(path.join(tmpdir(), 'maw-release-id-'));
  const id = '20261029010101-abcdef1';
  const release = path.join(temp, 'releases', id);
  await mkdir(release, { recursive: true });
  try {
    assert.equal(await readReleaseIdentity(release), null, 'no metadata: source checkout');
    await writeFile(path.join(release, '.workbench-release-meta.json'), JSON.stringify({ releaseId: id, commit: 'x' }));
    assert.equal(await readReleaseIdentity(release), id);
    await writeFile(path.join(release, '.workbench-release-meta.json'), JSON.stringify({ releaseId: '20261029010101-0000000' }));
    assert.equal(await readReleaseIdentity(release), null, 'metadata must name its own directory');
    await writeFile(path.join(release, '.workbench-release-meta.json'), JSON.stringify({ releaseId: id }));

    const bin = path.join(temp, 'bin'); await mkdir(bin);
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$WORKBENCH_TEST_PID"\n', { mode: 0o700 });
    const server = createServer((request, response) => { response.statusCode = request.url?.includes('token=t0k') ? 200 : 401; response.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const control = fileURLToPath(new URL('../../../../../scripts/workbench/control.mjs', import.meta.url));
    const runtime = path.join(temp, 'workbench');
    const url = `http://127.0.0.1:${address.port}/?token=t0k`;
    const env = { ...process.env, WORKBENCH_RUNTIME_DIR: runtime, PATH: bin + ':' + process.env.PATH, WORKBENCH_TEST_PID: String(process.pid) };
    const clear = await publishReadiness(runtime, url, id);
    try {
      assert.equal(JSON.parse(await readFile(path.join(runtime, 'workbench-ready.json'), 'utf8')).releaseId, id);
      assert.match((await run(process.execPath, [control, 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: id } })).stdout, new RegExp(`release ${id}`));
      await assert.rejects(run(process.execPath, [control, 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: '20261029010101-1111111' } }));
      // Older server without the field: the service's working directory decides. This process's cwd is not the release.
      await writeFile(path.join(runtime, 'workbench-ready.json'), JSON.stringify({ pid: process.pid, url }), { mode: 0o600 });
      await assert.rejects(run(process.execPath, [control, 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: id } }));
      // A child started with cwd inside the release (through a `current` symlink, like systemd) passes.
      await symlink(release, path.join(temp, 'current'));
      const { spawn } = await import('node:child_process');
      const child = spawn('sleep', ['10'], { cwd: path.join(temp, 'current'), stdio: 'ignore' });
      try {
        await writeFile(path.join(runtime, 'workbench-ready.json'), JSON.stringify({ pid: child.pid, url }), { mode: 0o600 });
        await run(process.execPath, [control, 'status'], { env: { ...env, WORKBENCH_TEST_PID: String(child.pid), WORKBENCH_EXPECT_RELEASE_ID: id } });
      } finally { child.kill(); }
    } finally { await clear(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
