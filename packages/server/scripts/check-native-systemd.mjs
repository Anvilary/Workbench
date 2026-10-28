/** Original wrapper semantics exercised only by disposable fixture CLIs under systemd. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const temp=await mkdtemp(path.join(tmpdir(),'maw-native-systemd-'));
const home=path.join(temp,'home');await mkdir(home);
const env={HOME:home,USERPROFILE:home,APPDATA:path.join(temp,'appdata'),XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_STATE_HOME:path.join(temp,'state'),XDG_CACHE_HOME:path.join(temp,'cache'),CODEX_HOME:path.join(home,'.codex'),PATH:path.dirname(process.execPath)+':/usr/bin:/bin'};
try {
 const output=execFileSync('systemd-run',['--user','--quiet','--wait','--pipe','--collect','--unit=maw-native-fixtures-'+process.pid,
  '--property=WorkingDirectory='+path.join(repo,'packages/server'),'--property=KillMode=control-group',
  ...Object.entries(env).map(([key,value])=>'--setenv='+key+'='+value),process.execPath,'--import',path.join(repo,'packages/server/node_modules/tsx/dist/loader.mjs'),'--test',path.join(repo,'packages/server/src/agency/native-context.test.ts')],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000});
 console.log(output);console.log('PASS disposable ten-profile PTY/context suite under systemd');
} finally {await rm(temp,{recursive:true,force:true});}
