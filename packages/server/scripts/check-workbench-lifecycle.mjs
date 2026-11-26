import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = await mkdtemp(path.join(tmpdir(), 'maw-lifecycle-'));
const unit = 'maw-isolated-' + process.pid;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const runtime = path.join(temp, 'runtime');
const home = path.join(temp, 'home');
const config = path.join(temp, 'config');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(temp, 'appdata'),
 XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(temp, 'data'), XDG_STATE_HOME: path.join(temp, 'state'),
 XDG_CACHE_HOME: path.join(temp, 'cache'), CODEX_HOME: path.join(home, '.codex'),
 WORKBENCH_NO_OPEN: '1', WORKBENCH_NO_RESTORE: '1', WORKBENCH_RUNTIME_DIR: runtime,
 PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' };
const ctl = (...args) => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
let socket;
try {
 await mkdir(home, { recursive: true });
 const mockbin = path.join(temp, 'mockbin'); await mkdir(mockbin);
 const logfile = path.join(temp, 'wrapper-calls');
 await writeFile(path.join(mockbin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WORKBENCH_TEST_LOG"\n', { mode: 0o700 });
 for (const action of ['start','start','stop','stop','restart','help']) {
   execFileSync(path.join(repo, 'scripts/workbench/maw'), [action], { cwd: '/', env: { ...env, PATH: mockbin + ':' + env.PATH, WORKBENCH_TEST_LOG: logfile }, stdio: 'pipe' });
 }
 assert.equal((await readFile(logfile, 'utf8')).trim().split('\n').length, 5);
 console.log('PASS wrapper arbitrary cwd and repeated lifecycle commands');
 execFileSync('systemd-analyze', ['--user', 'verify', path.join(repo, 'scripts/workbench/workbench.service')], { stdio: 'pipe' });
 const nodeArgs = ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(repo, 'packages/server/src/index.ts'), '--prod'];
 execFileSync('systemd-run', ['--user', '--unit=' + unit, '--service-type=exec', '--property=WorkingDirectory=' + temp,
   '--property=KillMode=control-group', ...Object.entries(env).filter(([key]) => ['HOME','USERPROFILE','APPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','WORKBENCH_NO_OPEN','WORKBENCH_NO_RESTORE','WORKBENCH_RUNTIME_DIR','PATH'].includes(key)).map(([key,value]) => '--setenv=' + key + '=' + value), process.execPath, ...nodeArgs], { stdio: 'pipe' });
 const ready = async oldPid => {
   for (let i=0;i<250;i++) {
     try { const state = JSON.parse(await readFile(path.join(runtime, 'workbench-ready.json'), 'utf8'));
       if (state.pid !== oldPid && (await fetch(state.url)).ok) return state;
     } catch {}
     await pause();
   }
   throw new Error('Isolated service did not become ready');
 };
 let state = await ready();
 const connect = async () => {
   const url = new URL(state.url); socket = new WebSocket(`ws://127.0.0.1:${url.port}/ws${url.search}`, { headers: { Origin: url.origin } });
   await new Promise((resolve,reject) => { socket.once('open',resolve); socket.once('error',reject); });
 };
 await connect();
 const request = message => new Promise((resolve,reject) => {
   const requestId = String(Math.random()); const timer = setTimeout(() => reject(new Error('Request timeout')),5000);
   const listener = raw => { const answer = JSON.parse(raw); if (answer.requestId !== requestId) return;
     clearTimeout(timer); socket.off('message', listener); resolve(answer); };
   socket.on('message',listener);socket.send(JSON.stringify({...message,requestId}));
 });
 const project = await request({type:'agency.project.create',name:'Durable lifecycle fixture'});
 assert.equal(project.type,'agency.project.created'); socket.close();
 const duplicate = spawn(process.execPath, nodeArgs, { cwd: '/', env, stdio:'ignore' });
 assert.equal(await new Promise(resolve => duplicate.once('exit',resolve)),1);
 const oldPid = state.pid;
 ctl('restart', unit); state = await ready(oldPid); await connect();
 const snapshot = await request({type:'agency.projects.list'});
 assert.ok(snapshot.projects.some(item => item.id === project.project.id)); socket.close();
 assert.notEqual(state.pid,oldPid);
 ctl('start',unit); ctl('start',unit);
 assert.equal(Number(ctl('show',unit,'--property=MainPID','--value').trim()),state.pid);
 console.log('PASS isolated systemd readiness, duplicate owner rejection, restart durability and idempotent starts');
 ctl('stop',unit);
 try { ctl('stop',unit); } catch { assert.equal(ctl('show',unit,'--property=LoadState','--value').trim(),'not-found'); }
 assert.equal(ctl('show',unit,'--property=ActiveState','--value').trim(),'inactive');
 console.log('PASS isolated systemd stop and cleanup');
} finally {
 socket?.close();
 try { ctl('stop',unit); } catch {}
 try { ctl('reset-failed',unit); } catch {}
 await rm(temp,{recursive:true,force:true});
}
