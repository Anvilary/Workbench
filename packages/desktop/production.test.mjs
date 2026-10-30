import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(new URL('../..', import.meta.url).pathname);

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

test('Ubuntu package owns its sandbox and does not contain state or service installation', async () => {
  const deb = path.join(root,'dist-desktop/maw-electron-45.2.0_amd64.deb');
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
  const { launchProduction } = await import('../../scripts/maw/desktop-launch.mjs');
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
  assert.match(entry,/Name=My Amazing Workspace/);assert.ok(entry.includes('Exec="'+path.join(dir,'bin with spaces/maw')+'" desktop'));
  assert.match(await readFile(path.join(dir,'apt-args'),'utf8'),/^apt-get\ninstall\n/);
});
