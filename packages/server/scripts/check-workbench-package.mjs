import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = await mkdtemp(path.join(tmpdir(), 'maw-package-'));
let child;
try {
 const packed = JSON.parse(execFileSync('npm', ['pack', path.join(repo, 'dist-npm'), '--pack-destination', temp, '--json'], { encoding:'utf8' }));
 assert.ok(packed[0].files.some(file => file.path === 'dist/server.js'));
 assert.ok(packed[0].files.some(file => file.path === 'dist/web/index.html'));
 execFileSync('npm', ['install','--prefix',path.join(temp,'install'),'--no-audit','--no-fund',path.join(temp,packed[0].filename)], { stdio:'pipe' });
 const home = path.join(temp,'home'); await mkdir(home);
 const runtime = path.join(temp,'runtime');
 child = spawn(process.execPath, [path.join(temp,'install/node_modules/agent-workbench/dist/server.js')], { cwd:'/',
  env: {...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(temp,'appdata'),XDG_CONFIG_HOME:path.join(temp,'config'),
    XDG_DATA_HOME:path.join(temp,'data'),XDG_STATE_HOME:path.join(temp,'state'),XDG_CACHE_HOME:path.join(temp,'cache'),
    CODEX_HOME:path.join(home,'.codex'),WORKBENCH_NO_OPEN:'1',WORKBENCH_NO_RESTORE:'1',WORKBENCH_RUNTIME_DIR:runtime,
    PATH:path.dirname(process.execPath)+':/usr/bin:/bin'}, stdio:['ignore','pipe','pipe'] });
 const { readFile } = await import('node:fs/promises');
 let state;
 for(let i=0;i<200;i++) {
   try { state=JSON.parse(await readFile(path.join(runtime,'workbench-ready.json'),'utf8')); break; } catch {}
   if(child.exitCode !== null) throw new Error('Installed server exited '+child.exitCode);
   await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(state,'installed package readiness');
 const response=await fetch(state.url);assert.equal(response.status,200);
 assert.match(await response.text(),/Anvilary Workbench/);
 console.log('PASS package contents, clean npm installation, arbitrary-cwd startup, authenticated HTTP');
} finally {
 if(child && child.exitCode===null) { const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited; }
 await rm(temp,{recursive:true,force:true});
}
