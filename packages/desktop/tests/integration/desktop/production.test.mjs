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
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-ready-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const bin = path.join(dir,'bin'); await mkdir(bin);
  await writeFile(path.join(bin,'systemctl'), '#!/bin/sh\necho 1234\n', {mode:0o755});
  const file = path.join(dir,'workbench-ready.json');
  await writeFile(file, JSON.stringify({pid:9999,url:'http://127.0.0.1:12345/?token=private-test-token'}), {mode:0o600});
  const env={...process.env,PATH:bin+':'+process.env.PATH,WORKBENCH_RUNTIME_DIR:dir};
  for (const mode of [0o644,0o600]) {
    await chmod(file,mode);
    await assert.rejects(exec(process.execPath,[path.join(root,'scripts/workbench/control.mjs'),'url'],{env}), e => {
      assert.ok(!e.stderr.includes('private-test-token'));assert.equal(e.stdout,'');return true;
    });
  }
  await rm(file); await writeFile(path.join(dir,'secret'), '{}',{mode:0o600}); await symlink(path.join(dir,'secret'),file);
  await assert.rejects(exec(process.execPath,[path.join(root,'scripts/workbench/control.mjs'),'url'],{env}));
});

test('old updater build entry refuses missing production desktop runtime before staging', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-desktop-gate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'.workbench-candidate'),'{}');
  await mkdir(path.join(dir,'packages/desktop'),{recursive:true});
  await writeFile(path.join(dir,'packages/desktop/package.json'), JSON.stringify({devDependencies:{electron:'0.0.0'}}));
  await assert.rejects(exec(process.execPath,[path.join(root,'scripts/workbench/check-desktop-build.mjs')],{cwd:dir}), e=>{assert.match(e.stderr,/No release was activated/);return true;});
});

test('Ubuntu package owns its sandbox and does not contain state or service installation', async t => {
  const defaultDeb = path.join(root,'dist-desktop/workbench-electron-45.2.0_amd64.deb');
  let deb = defaultDeb;
  if (!existsSync(defaultDeb)) {
    const tmpOut = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-deb-out-'));
    t.after(() => rm(tmpOut, { recursive: true, force: true }));
    await exec(process.execPath, [path.join(root, 'scripts/workbench/build-desktop-deb.mjs'), tmpOut], { cwd: root });
    deb = path.join(tmpOut, 'workbench-electron-45.2.0_amd64.deb');
  }
  const {stdout}=await exec('dpkg-deb',['--contents',deb],{maxBuffer:1024*1024});
  assert.match(stdout,/rwsr-xr-x root\/root.*chrome-sandbox/);
  assert.match(stdout,/rwxr-xr-x root\/root.*\/electron\n/);
  assert.ok(!stdout.includes('workbench.service'));
  assert.ok(!stdout.includes('/home/'));
  const main=await readFile(path.join(root,'scripts/workbench/desktop-launch.mjs'),'utf8');
  assert.ok(!main.includes('desktop-prototype'));
});

test('production launch uses the serving release and existing service URL without starting a backend or changing workspace data', async t => {
  const { spawn } = await import('node:child_process');
  const { launchProduction } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/workbench/desktop-launch.mjs')).href);
  const dir=await mkdtemp(path.join(tmpdir(),'maw-production-launch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const release=path.join(dir,'verified-release');await mkdir(release);
  await writeFile(path.join(release,'.workbench-release-meta.json'),JSON.stringify({releaseId:'verified-release'}));
  const service=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:release,stdio:'ignore'});
  t.after(()=>service.kill());
  const runtime=path.join(dir,'runtime');await mkdir(runtime);
  const capture=path.join(dir,'capture.json');
  await writeFile(path.join(runtime,'electron'), '#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(capture)+',JSON.stringify({args:process.argv.slice(2),url:process.env.WORKBENCH_DESKTOP_URL,profile:process.env.WORKBENCH_DESKTOP_DATA_DIR,runAsNode:process.env.ELECTRON_RUN_AS_NODE}),{mode:384});\n',{mode:0o755});
  const sentinel=path.join(release,'workspace-state.json');await writeFile(sentinel,'unchanged');
  const child=await launchProduction({ready:async()=>({pid:service.pid,state:{releaseId:'verified-release'},url:new URL('http://127.0.0.1:34567/?token=fixture-only')}),runtime:async serving=>{assert.equal(serving,release);return {directory:runtime};},dataHome:dir});
  await new Promise(resolve=>child.on('exit',resolve));
  const result=JSON.parse(await readFile(capture,'utf8'));
  assert.deepEqual(result.args,[path.join(release,'packages/desktop')]);
  assert.equal(result.url,'http://127.0.0.1:34567/?token=fixture-only');
  assert.equal(result.profile,path.join(dir,'workbench-desktop'));
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

test('production launch gives Electron the graphics environment from the serving release, never overriding the user', async t => {
  const { spawn } = await import('node:child_process');
  const { launchProduction } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/workbench/desktop-launch.mjs')).href);
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-graphics-launch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, 'verified-release'); await mkdir(release);
  await writeFile(path.join(release, '.workbench-release-meta.json'), JSON.stringify({ releaseId: 'verified-release' }));
  const service = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: release, stdio: 'ignore' });
  t.after(() => service.kill());
  const runtime = path.join(dir, 'runtime'); await mkdir(runtime);
  const capture = path.join(dir, 'capture.json');
  await writeFile(path.join(runtime, 'electron'), '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(capture) + ',JSON.stringify({egl:process.env.__EGL_VENDOR_LIBRARY_FILENAMES,glx:process.env.__GLX_VENDOR_LIBRARY_NAME}))\n');
  await chmod(path.join(runtime, 'electron'), 0o755);
  const serving = async () => ({ pid: service.pid, state: { releaseId: 'verified-release' }, url: new URL('http://127.0.0.1:34567/') });
  const launch = async (graphicsEnv) => {
    const child = await launchProduction({ ready: serving, runtime: async () => ({ directory: runtime }), graphicsEnv, dataHome: dir });
    await new Promise(resolve => child.on('exit', resolve));
    return JSON.parse(await readFile(capture, 'utf8'));
  };
  const saved = { egl: process.env.__EGL_VENDOR_LIBRARY_FILENAMES, glx: process.env.__GLX_VENDOR_LIBRARY_NAME };
  t.after(() => { for (const [k, v] of [['__EGL_VENDOR_LIBRARY_FILENAMES', saved.egl], ['__GLX_VENDOR_LIBRARY_NAME', saved.glx]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });
  delete process.env.__EGL_VENDOR_LIBRARY_FILENAMES; delete process.env.__GLX_VENDOR_LIBRARY_NAME;

  assert.deepEqual(await launch(async () => ({ __EGL_VENDOR_LIBRARY_FILENAMES: '/policy/mesa.json', __GLX_VENDOR_LIBRARY_NAME: 'mesa' })), { egl: '/policy/mesa.json', glx: 'mesa' });
  assert.deepEqual(await launch(async () => ({})), {}, 'an empty policy adds nothing');

  process.env.__EGL_VENDOR_LIBRARY_FILENAMES = '/user/choice.json';
  const overridden = await launch(async () => ({ __EGL_VENDOR_LIBRARY_FILENAMES: '/policy/mesa.json' }));
  assert.equal(overridden.egl, '/user/choice.json', 'the invoking environment wins over the policy');
  delete process.env.__EGL_VENDOR_LIBRARY_FILENAMES;

  // Default resolver: a release that predates the policy module launches with an unchanged environment.
  const legacy = await launchProduction({ ready: serving, runtime: async () => ({ directory: runtime }), dataHome: dir });
  await new Promise(resolve => legacy.on('exit', resolve));
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {});
});

test('commands installation preserves existing user state and is repeatable', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-desktop-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=path.join(dir,'state');await mkdir(state);
  await writeFile(path.join(state,'sentinel'),'existing history');
  const env={...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),WORKBENCH_STATE_DIR:state,WORKBENCH_LIB_DIR:path.join(dir,'lib'),WORKBENCH_BIN_DIR:path.join(dir,'bin'),WORKBENCH_NODE_BIN:process.execPath};
  for(let i=0;i<2;i++)await exec('/bin/sh',[path.join(root,'scripts/workbench/install.sh'),'--commands-only'],{env});
  assert.equal(await readFile(path.join(state,'sentinel'),'utf8'),'existing history');
  assert.equal(await readFile(path.join(dir,'lib/desktop-runtime-version'),'utf8'),'45.2.0');
  assert.match(await readFile(path.join(dir,'lib/desktop-launch.mjs'),'utf8'),/readyService/);
  await writeFile(path.join(dir,'lib/desktop-runtime-version'),'44.0.0');
  await exec('/bin/sh',[path.join(root,'scripts/workbench/install.sh'),'--commands-only'],{env});
  assert.equal(await readFile(path.join(dir,'lib/desktop-runtime-version'),'utf8'),'44.0.0');
  const anvilHelp = await exec(path.join(dir,'bin/anvil-bench'), ['help'], { env });
  assert.match(anvilHelp.stdout, /^Usage: anvil-bench /);
  const mawHelp = await exec(path.join(dir,'bin/maw'), ['help'], { env });
  assert.match(mawHelp.stdout, /^Usage: maw /);
});

test('desktop installer creates a graphical entry without service activation (apt fixture)', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-desktop-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const tools=path.join(dir,'tools');await mkdir(tools);
  await writeFile(path.join(tools,'sudo'),'#!/bin/sh\nprintf "%s\\n" "$@" > '+JSON.stringify(path.join(dir,'apt-args'))+'\n',{mode:0o755});
  const nodeWrapper=path.join(tools,'node-wrapper');
  await writeFile(nodeWrapper,'#!/usr/bin/env node\nif(!process.argv[2].endsWith("build-desktop-deb.mjs"))require("child_process").execFileSync(process.execPath,process.argv.slice(2),{stdio:"inherit"});\n',{mode:0o755});
  const env={...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),PATH:tools+':'+process.env.PATH,WORKBENCH_STATE_DIR:path.join(dir,'state'),WORKBENCH_LIB_DIR:path.join(dir,'lib'),WORKBENCH_BIN_DIR:path.join(dir,'bin with spaces'),WORKBENCH_NODE_BIN:nodeWrapper,XDG_DATA_HOME:path.join(dir,'data')};
  await exec('/bin/sh',[path.join(root,'scripts/workbench/install.sh'),'--desktop'],{env});
  const entry=await readFile(path.join(dir,'data/applications/workbench.desktop'),'utf8');
  assert.match(entry,/^Name=Workbench$/m);assert.match(entry,/^GenericName=Anvilary Workbench$/m);assert.ok(entry.includes('Exec="'+path.join(dir,'bin with spaces/anvi-bench')+'" desktop'));
  assert.match(entry,/^Icon=workbench$/m);
  assert.match(await readFile(path.join(dir,'apt-args'),'utf8'),/^apt-get\ninstall\n/);
});

test('desktop integration enables login startup and refreshes search assets without restarting', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const units = path.join(dir, 'units'), tools = path.join(dir, 'tools'), calls = path.join(dir, 'systemctl.log');
  await mkdir(units); await mkdir(tools);
  for (const name of ['workbench.service', 'workbench-ptyd.service']) await writeFile(path.join(units, name), `installed ${name}`);
  await writeFile(path.join(tools, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> '+JSON.stringify(calls)+'\n', { mode: 0o755 });
  await writeFile(path.join(tools, 'sudo'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, PATH: tools+':'+process.env.PATH, WORKBENCH_STATE_DIR: path.join(dir, 'state'),
    WORKBENCH_SYSTEMD_USER_DIR: units, WORKBENCH_LIB_DIR: path.join(dir, 'lib'), WORKBENCH_BIN_DIR: path.join(dir, 'bin'),
    WORKBENCH_NODE_BIN: process.execPath, XDG_DATA_HOME: path.join(dir, 'data') };
  await exec('/bin/sh', [path.join(root, 'scripts/workbench/install.sh'), '--integrate-desktop'], { env });
  assert.equal((await readFile(calls, 'utf8')).trim(), '--user enable workbench.service workbench-ptyd.service');
  for (const name of ['workbench.service', 'workbench-ptyd.service']) assert.equal(await readFile(path.join(units, name), 'utf8'), `installed ${name}`);
  assert.equal((await readFile(path.join(env.WORKBENCH_LIB_DIR, 'activation-helper-api'), 'utf8')).trim(), '2');
  assert.match(await readFile(path.join(env.XDG_DATA_HOME, 'applications/workbench.desktop'), 'utf8'), /^Name=Workbench$/m);
  assert.deepEqual(await readFile(path.join(env.XDG_DATA_HOME, 'icons/hicolor/256x256/apps/workbench.png')),
    await readFile(path.join(root, 'packages/desktop/assets/icons/workbench-256.png')));
});

const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512];

async function makeMockRelease(releasesDir, id, commit, iconSeed = null) {
  const dir = path.join(releasesDir, id);
  await mkdir(path.join(dir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/dist'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/node_modules/tsx/dist'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'workbench', version: '1.0.0' }) + '\n');
  await writeFile(path.join(dir, 'packages/server/src/workbench-host.ts'), '');
  await writeFile(path.join(dir, 'packages/server/src/index.ts'), '');
  await writeFile(path.join(dir, 'packages/server/node_modules/tsx/dist/loader.mjs'), '');
  await writeFile(path.join(dir, 'packages/server/dist/index.mjs'), 'export {};\n');
  await writeFile(path.join(dir, 'packages/server/dist/ptyd.mjs'), '#!/usr/bin/env node\n');
  await writeFile(path.join(dir, 'packages/server/dist/terminal-state.mjs'), 'export {};\n');
  await writeFile(path.join(dir, '.workbench-release-meta.json'), JSON.stringify({ releaseId: id, commit, schema: 2, supervisor: true }) + '\n');
  if (iconSeed !== null) {
    await mkdir(path.join(dir, 'packages/desktop/assets/icons'), { recursive: true });
    for (const s of ICON_SIZES) {
      await writeFile(path.join(dir, `packages/desktop/assets/icons/workbench-${s}.png`), `${iconSeed}-${s}`);
    }
  }
  return dir;
}

async function setupActivationHarness(dir, { healthyId, stagedId = null, brokenIds = [] } = {}) {
  const stateDir = path.join(dir, 'state');
  const releasesDir = path.join(stateDir, 'releases');
  const runtimeDir = path.join(dir, 'runtime');
  const toolsDir = path.join(dir, 'tools');
  await mkdir(releasesDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(toolsDir, { recursive: true });

  await writeFile(path.join(dir, 'running'), path.join(releasesDir, healthyId));
  await writeFile(path.join(dir, 'broken.json'), JSON.stringify(brokenIds));
  await writeFile(path.join(toolsDir, 'systemctl'), `#!/bin/sh
cmd=""; for a in "$@"; do case "$a" in --*) ;; *) [ -z "$cmd" ] && cmd="$a" ;; esac; done
case "$cmd" in
  show)
    case "$*" in
      *ActiveState*) echo active; exit 0 ;;
      *ControlGroup*) echo ""; exit 0 ;;
      *MainPID*) echo 0; exit 0 ;;
      *Result*) echo exit-code; exit 0 ;;
    esac
    exit 0 ;;
  restart|start)
    case "$*" in *workbench-ptyd*) exit 0 ;; esac
    readlink -f ${JSON.stringify(path.join(stateDir, 'current'))} > ${JSON.stringify(path.join(dir, 'running'))}
    exit 0 ;;
  stop) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  const mockControl = path.join(toolsDir, 'mock-control.mjs');
  await writeFile(mockControl, `
import fs from 'node:fs';
const cmd = process.argv[2];
if (cmd === 'check-data' || cmd === 'ptyd-empty') process.exit(0);
if (cmd === 'ptyd-release') { console.log(${JSON.stringify(path.join(releasesDir, healthyId))}); process.exit(0); }
if (cmd === 'status') {
  const running = fs.readFileSync(${JSON.stringify(path.join(dir, 'running'))}, 'utf8').trim().split('/').pop();
  const broken = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'broken.json'))}, 'utf8'));
  const expected = process.env.WORKBENCH_EXPECT_RELEASE_ID || '';
  if (!running || broken.includes(running) || (expected && expected !== running)) process.exit(1);
  process.exit(0);
}
process.exit(0);
`);

  await symlink(path.join(releasesDir, healthyId), path.join(stateDir, 'current'));
  await symlink(path.join(releasesDir, healthyId), path.join(stateDir, 'healthy'));
  if (stagedId) {
    await symlink(path.join(releasesDir, stagedId), path.join(stateDir, 'staged'));
  }
  return { stateDir, releasesDir, runtimeDir, toolsDir, mockControl };
}

test('desktop assets installation covers all icon sizes, supports XDG overrides, and avoids duplicate entries', async t => {
  const { readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const xdgData = path.join(dir, 'xdg-data');
  const defaultShare = path.join(dir, 'home/.local/share');
  const env = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    XDG_DATA_HOME: xdgData,
    WORKBENCH_STATE_DIR: path.join(dir, 'state'),
    WORKBENCH_LIB_DIR: path.join(dir, 'lib'),
    WORKBENCH_BIN_DIR: path.join(dir, 'bin'),
    WORKBENCH_NODE_BIN: process.execPath,
  };
  await mkdir(env.HOME, { recursive: true });
  for (let i = 0; i < 2; i++) {
    await exec('/bin/sh', [path.join(root, 'scripts/workbench/install.sh'), '--desktop-assets'], { env });
  }
  assert.equal(existsSync(defaultShare), false, 'XDG_DATA_HOME override must leave HOME/.local/share untouched');
  const apps = await readdir(path.join(xdgData, 'applications'));
  assert.deepEqual(apps.filter(f => f.endsWith('.desktop')), ['workbench.desktop']);
  for (const s of ICON_SIZES) {
    assert.deepEqual(
      await readFile(path.join(xdgData, `icons/hicolor/${s}x${s}/apps/workbench.png`)),
      await readFile(path.join(root, `packages/desktop/assets/icons/workbench-${s}.png`)),
      `installed ${s}px icon must match repository asset`,
    );
  }
});

test('installed helpers refresh desktop assets on activation and rollback while preserving launcher identity and failing safely', async t => {
  const { readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const xdgData = path.join(dir, 'xdg-data');
  const libDir = path.join(dir, 'lib');
  const binDir = path.join(dir, 'custom bin');
  const installEnv = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    XDG_DATA_HOME: xdgData,
    WORKBENCH_STATE_DIR: path.join(dir, 'state'),
    WORKBENCH_LIB_DIR: libDir,
    WORKBENCH_BIN_DIR: binDir,
    WORKBENCH_NODE_BIN: process.execPath,
  };
  await mkdir(installEnv.HOME, { recursive: true });
  await exec('/bin/sh', [path.join(root, 'scripts/workbench/install.sh'), '--desktop-assets'], { env: installEnv });

  const v1Id = '20261124000001-aaaa111';
  const v2Id = '20261124000002-bbbb222';
  const v3BadId = '20261124000003-cccc333';
  const v4NoIconsId = '20261124000004-dddd444';

  const { stateDir, releasesDir, runtimeDir, toolsDir, mockControl } = await setupActivationHarness(dir, {
    healthyId: v1Id,
    stagedId: v3BadId,
    brokenIds: [v3BadId],
  });
  await makeMockRelease(releasesDir, v1Id, 'aaaa111', 'brand-v1');
  await makeMockRelease(releasesDir, v2Id, 'bbbb222', 'brand-v2');
  await makeMockRelease(releasesDir, v3BadId, 'cccc333', 'brand-v3-bad');
  await makeMockRelease(releasesDir, v4NoIconsId, 'dddd444', null);

  const env = {
    ...installEnv,
    PATH: `${toolsDir}:${process.env.PATH}`,
    WORKBENCH_STATE_DIR: stateDir,
    WORKBENCH_RELEASES_DIR: releasesDir,
    WORKBENCH_RUNTIME_DIR: runtimeDir,
    WORKBENCH_UNIT: 'maw-fixture.service',
    WORKBENCH_CONTROL_SCRIPT: mockControl,
    WORKBENCH_READY_TIMEOUT: '2',
    WORKBENCH_CGROUP_FILE: path.join(dir, 'no-cgroup'),
  };

  // Failed activation rolls back to v1 and recovers v1 branding instead of leaking v3 branding.
  await assert.rejects(
    exec('/bin/sh', [path.join(libDir, 'restart-helper.sh'), '--unit', 'maw-fixture.service', '--force'], { env }),
    err => err.code === 2,
  );
  for (const s of ICON_SIZES) {
    assert.equal(await readFile(path.join(xdgData, `icons/hicolor/${s}x${s}/apps/workbench.png`), 'utf8'), `brand-v1-${s}`);
  }

  // Successful activation of v2 updates all icon sizes and preserves the custom launcher Exec= path.
  await symlink(path.join(releasesDir, v2Id), path.join(stateDir, 'staged'));
  await exec('/bin/sh', [path.join(libDir, 'restart-helper.sh'), '--unit', 'maw-fixture.service', '--force'], { env });
  for (const s of ICON_SIZES) {
    assert.equal(await readFile(path.join(xdgData, `icons/hicolor/${s}x${s}/apps/workbench.png`), 'utf8'), `brand-v2-${s}`);
  }
  const desktopText = await readFile(path.join(xdgData, 'applications/workbench.desktop'), 'utf8');
  assert.ok(desktopText.includes(`Exec="${path.join(binDir, 'anvi-bench')}" desktop`));
  assert.match(desktopText, /^Icon=workbench$/m);
  assert.match(desktopText, /^Name=Workbench$/m);
  assert.deepEqual((await readdir(path.join(xdgData, 'applications'))).filter(f => f.endsWith('.desktop')), ['workbench.desktop']);

  // Explicit rollback via installed anvi-bench activates v1 and restores v1 icons.
  await exec(path.join(binDir, 'anvi-bench'), ['rollback'], { env });
  for (const s of ICON_SIZES) {
    assert.equal(await readFile(path.join(xdgData, `icons/hicolor/${s}x${s}/apps/workbench.png`), 'utf8'), `brand-v1-${s}`);
  }

  // Missing desktop assets in a release must not fail activation or erase existing desktop integration.
  await symlink(path.join(releasesDir, v4NoIconsId), path.join(stateDir, 'staged'));
  await exec('/bin/sh', [path.join(libDir, 'restart-helper.sh'), '--unit', 'maw-fixture.service', '--force'], { env });
  assert.equal(await readFile(path.join(xdgData, 'icons/hicolor/512x512/apps/workbench.png'), 'utf8'), 'brand-v1-512');
  assert.equal(existsSync(path.join(xdgData, 'applications/workbench.desktop')), true);
});

test('headless installations remain untouched during activation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-desktop-headless-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const xdgData = path.join(dir, 'xdg-data');
  const v1Id = '20261124000001-aaaa111';
  const v2Id = '20261124000002-bbbb222';
  const { stateDir, releasesDir, runtimeDir, toolsDir, mockControl } = await setupActivationHarness(dir, {
    healthyId: v1Id,
    stagedId: v2Id,
  });
  await makeMockRelease(releasesDir, v1Id, 'aaaa111', 'brand-v1');
  await makeMockRelease(releasesDir, v2Id, 'bbbb222', 'brand-v2');
  await writeFile(path.join(stateDir, 'headless'), 'headless\n');

  const env = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    XDG_DATA_HOME: xdgData,
    PATH: `${toolsDir}:${process.env.PATH}`,
    WORKBENCH_STATE_DIR: stateDir,
    WORKBENCH_RELEASES_DIR: releasesDir,
    WORKBENCH_RUNTIME_DIR: runtimeDir,
    WORKBENCH_UNIT: 'maw-fixture.service',
    WORKBENCH_NODE_BIN: process.execPath,
    WORKBENCH_CONTROL_SCRIPT: mockControl,
    WORKBENCH_READY_TIMEOUT: '2',
    WORKBENCH_CGROUP_FILE: path.join(dir, 'no-cgroup'),
  };
  await mkdir(env.HOME, { recursive: true });
  await exec('/bin/sh', [path.join(root, 'scripts/workbench/restart-helper.sh'), '--unit', 'maw-fixture.service', '--force'], { env });
  assert.equal(existsSync(path.join(xdgData, 'applications/workbench.desktop')), false);
  assert.equal(existsSync(path.join(xdgData, 'icons')), false);

  // WORKBENCH_HEADLESS=1 also prevents desktop asset writes even if state_dir/headless is absent.
  await rm(path.join(stateDir, 'headless'));
  await symlink(path.join(releasesDir, v1Id), path.join(stateDir, 'staged'));
  await exec('/bin/sh', [path.join(root, 'scripts/workbench/restart-helper.sh'), '--unit', 'maw-fixture.service', '--force'], {
    env: { ...env, WORKBENCH_HEADLESS: '1' },
  });
  assert.equal(existsSync(path.join(xdgData, 'applications/workbench.desktop')), false);
  assert.equal(existsSync(path.join(xdgData, 'icons')), false);

  // Staging script does not touch desktop assets prematurely.
  const updaterSource = await readFile(path.join(root, 'scripts/workbench/update.sh'), 'utf8');
  assert.ok(!updaterSource.includes('wb_refresh_desktop_assets'), 'staging script must not refresh desktop assets prematurely');
});
