import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../helpers/paths.mjs';
const exec = promisify(execFile);
const root = REPO_ROOT;

test('readiness acquisition rejects unsafe files and stale systemd identity without disclosing credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-desktop-ready-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const bin = path.join(dir,'bin'); await mkdir(bin);
  await writeFile(path.join(bin,'systemctl'), '#!/bin/sh\necho 1234\n', {mode:0o755});
  const file = path.join(dir,'maw-ready.json');
  await writeFile(file, JSON.stringify({pid:9999,url:'http://127.0.0.1:12345/?token=private-test-token'}), {mode:0o600});
  const env={...process.env,PATH:bin+':'+process.env.PATH,MAW_RUNTIME_DIR:dir};
  for (const mode of [0o644,0o600]) {
    await chmod(file,mode);
    await assert.rejects(exec(process.execPath,[path.join(root,'scripts/maw/control.mjs'),'url'],{env}), e => {
      assert.ok(!e.stderr.includes('private-test-token'));assert.equal(e.stdout,'');return true;
    });
  }
  await rm(file); await writeFile(path.join(dir,'secret'), '{}',{mode:0o600}); await symlink(path.join(dir,'secret'),file);
  await assert.rejects(exec(process.execPath,[path.join(root,'scripts/maw/control.mjs'),'url'],{env}));
});

test('old updater build entry refuses missing production desktop runtime before staging', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'maw-desktop-gate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'.maw-candidate'),'{}');
  await mkdir(path.join(dir,'packages/desktop'),{recursive:true});
  await writeFile(path.join(dir,'packages/desktop/package.json'), JSON.stringify({devDependencies:{electron:'0.0.0'}}));
  await assert.rejects(exec(process.execPath,[path.join(root,'scripts/maw/check-desktop-build.mjs')],{cwd:dir}), e=>{assert.match(e.stderr,/No release was activated/);return true;});
});

test('Ubuntu package owns its sandbox and does not contain state or service installation', async t => {
  const defaultDeb = path.join(root,'dist-desktop/maw-electron-45.2.0_amd64.deb');
  let deb = defaultDeb;
  if (!existsSync(defaultDeb)) {
    const tmpOut = await mkdtemp(path.join(tmpdir(), 'maw-desktop-deb-out-'));
    t.after(() => rm(tmpOut, { recursive: true, force: true }));
    await exec(process.execPath, [path.join(root, 'scripts/maw/build-desktop-deb.mjs'), tmpOut], { cwd: root });
    deb = path.join(tmpOut, 'maw-electron-45.2.0_amd64.deb');
  }
  const {stdout}=await exec('dpkg-deb',['--contents',deb],{maxBuffer:1024*1024});
  assert.match(stdout,/rwsr-xr-x root\/root.*chrome-sandbox/);
  assert.match(stdout,/rwxr-xr-x root\/root.*\/electron\n/);
  assert.ok(!stdout.includes('maw.service'));
  assert.ok(!stdout.includes('/home/'));
  const main=await readFile(path.join(root,'scripts/maw/desktop-launch.mjs'),'utf8');
  assert.ok(!main.includes('desktop-prototype'));
});

test('production launch uses the serving release and existing service URL without starting a backend or changing workspace data', async t => {
  const { spawn } = await import('node:child_process');
  const { launchProduction } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/maw/desktop-launch.mjs')).href);
  const dir=await mkdtemp(path.join(tmpdir(),'maw-production-launch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const release=path.join(dir,'verified-release');await mkdir(release);
  await writeFile(path.join(release,'.maw-release-meta.json'),JSON.stringify({releaseId:'verified-release'}));
  const service=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:release,stdio:'ignore'});
  t.after(()=>service.kill());
  const runtime=path.join(dir,'runtime');await mkdir(runtime);
  const capture=path.join(dir,'capture.json');
  await writeFile(path.join(runtime,'electron'), '#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(capture)+',JSON.stringify({args:process.argv.slice(2),url:process.env.MAW_DESKTOP_URL,profile:process.env.MAW_DESKTOP_DATA_DIR,runAsNode:process.env.ELECTRON_RUN_AS_NODE}),{mode:384});\n',{mode:0o755});
  const sentinel=path.join(release,'workspace-state.json');await writeFile(sentinel,'unchanged');
  const child=await launchProduction({ready:async()=>({pid:service.pid,state:{releaseId:'verified-release'},url:new URL('http://127.0.0.1:34567/?token=fixture-only')}),runtime:async serving=>{assert.equal(serving,release);return {directory:runtime};},dataHome:dir});
  await new Promise(resolve=>child.on('exit',resolve));
  const result=JSON.parse(await readFile(capture,'utf8'));
  assert.deepEqual(result.args,[path.join(release,'packages/desktop')]);
  assert.equal(result.url,'http://127.0.0.1:34567/?token=fixture-only');
  assert.equal(result.profile,path.join(dir,'maw-desktop'));
  assert.equal(result.runAsNode,undefined);
  assert.equal(await readFile(sentinel,'utf8'),'unchanged');

  let starts = 0, probes = 0;
  const cold = await launchProduction({
    ready: async () => {
      if (++probes < 3) throw new Error('User service is still starting');
      return { pid: service.pid, state: { releaseId: 'verified-release' }, url: new URL('http://127.0.0.1:34567/') };
    },
    startService: async () => { starts++; },
    runtime: async () => ({ directory: runtime }), dataHome: dir,
  });
  await new Promise(resolve => cold.once('exit', resolve));
  assert.equal(starts, 1, 'cold launch requests one start of the current release');
  assert.equal(probes, 3, 'launcher waits for verified readiness');
});

test('commands installation preserves existing user state and is repeatable', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'maw-desktop-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=path.join(dir,'state');await mkdir(state);
  await writeFile(path.join(state,'sentinel'),'existing history');
  const env={...process.env,MAW_STATE_DIR:state,MAW_LIB_DIR:path.join(dir,'lib'),MAW_BIN_DIR:path.join(dir,'bin'),MAW_NODE_BIN:process.execPath};
  for(let i=0;i<2;i++)await exec('/bin/sh',[path.join(root,'scripts/maw/install.sh'),'--commands-only'],{env});
  assert.equal(await readFile(path.join(state,'sentinel'),'utf8'),'existing history');
  assert.equal(await readFile(path.join(dir,'lib/desktop-runtime-version'),'utf8'),'45.2.0');
  assert.match(await readFile(path.join(dir,'lib/desktop-launch.mjs'),'utf8'),/readyService/);
  await writeFile(path.join(dir,'lib/desktop-runtime-version'),'44.0.0');
  await exec('/bin/sh',[path.join(root,'scripts/maw/install.sh'),'--commands-only'],{env});
  assert.equal(await readFile(path.join(dir,'lib/desktop-runtime-version'),'utf8'),'44.0.0');
  const anvilHelp = await exec(path.join(dir,'bin/anvil-bench'), ['help'], { env });
  assert.match(anvilHelp.stdout, /^Usage: anvil-bench /);
  const mawHelp = await exec(path.join(dir,'bin/maw'), ['help'], { env });
  assert.match(mawHelp.stdout, /^Usage: maw /);
});

test('desktop installer creates a graphical entry without service activation (apt fixture)', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'maw-desktop-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const tools=path.join(dir,'tools');await mkdir(tools);
  await writeFile(path.join(tools,'sudo'),'#!/bin/sh\nprintf "%s\\n" "$@" > '+JSON.stringify(path.join(dir,'apt-args'))+'\n',{mode:0o755});
  const nodeWrapper=path.join(tools,'node-wrapper');
  await writeFile(nodeWrapper,'#!/usr/bin/env node\nif(!process.argv[2].endsWith("build-desktop-deb.mjs"))require("child_process").execFileSync(process.execPath,process.argv.slice(2),{stdio:"inherit"});\n',{mode:0o755});
  const env={...process.env,PATH:tools+':'+process.env.PATH,MAW_STATE_DIR:path.join(dir,'state'),MAW_LIB_DIR:path.join(dir,'lib'),MAW_BIN_DIR:path.join(dir,'bin with spaces'),MAW_NODE_BIN:nodeWrapper,XDG_DATA_HOME:path.join(dir,'data')};
  await exec('/bin/sh',[path.join(root,'scripts/maw/install.sh'),'--desktop'],{env});
  const entry=await readFile(path.join(dir,'data/applications/maw.desktop'),'utf8');
  assert.match(entry,/^Name=Workbench$/m);assert.match(entry,/^GenericName=Anvilary Workbench$/m);assert.ok(entry.includes('Exec="'+path.join(dir,'bin with spaces/anvil-bench')+'" desktop'));
  assert.match(entry,/^Icon=maw-workspace$/m);
  assert.match(await readFile(path.join(dir,'apt-args'),'utf8'),/^apt-get\ninstall\n/);
});

test('desktop integration enables login startup and refreshes search assets without restarting', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-desktop-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const units = path.join(dir, 'units'), tools = path.join(dir, 'tools'), calls = path.join(dir, 'systemctl.log');
  await mkdir(units); await mkdir(tools);
  for (const name of ['maw.service', 'maw-ptyd.service']) await writeFile(path.join(units, name), `installed ${name}`);
  await writeFile(path.join(tools, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> '+JSON.stringify(calls)+'\n', { mode: 0o755 });
  await writeFile(path.join(tools, 'sudo'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, PATH: tools+':'+process.env.PATH, MAW_STATE_DIR: path.join(dir, 'state'),
    MAW_SYSTEMD_USER_DIR: units, MAW_LIB_DIR: path.join(dir, 'lib'), MAW_BIN_DIR: path.join(dir, 'bin'),
    MAW_NODE_BIN: process.execPath, XDG_DATA_HOME: path.join(dir, 'data') };
  await exec('/bin/sh', [path.join(root, 'scripts/maw/install.sh'), '--integrate-desktop'], { env });
  assert.equal((await readFile(calls, 'utf8')).trim(), '--user enable maw.service maw-ptyd.service');
  for (const name of ['maw.service', 'maw-ptyd.service']) assert.equal(await readFile(path.join(units, name), 'utf8'), `installed ${name}`);
  assert.equal((await readFile(path.join(env.MAW_LIB_DIR, 'activation-helper-api'), 'utf8')).trim(), '2');
  assert.match(await readFile(path.join(env.XDG_DATA_HOME, 'applications/maw.desktop'), 'utf8'), /^Name=Workbench$/m);
  assert.deepEqual(await readFile(path.join(env.XDG_DATA_HOME, 'icons/hicolor/256x256/apps/maw-workspace.png')),
    await readFile(path.join(root, 'packages/desktop/assets/icons/maw-256.png')));
});
