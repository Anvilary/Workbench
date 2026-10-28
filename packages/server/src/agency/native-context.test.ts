import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { NativeIdentities, artifactDigest } from './native-identity.js';
import { ownsNativeSession } from './native-ownership.js';
import { AgencyProfileStore } from './agency-profile-store.js';
import { defaultDefinitions } from '../agents/profiles/definition.js';
import { AgentRegistry } from '../agents/registry.js';
import { createCodexAdapter } from '../agents/codex/index.js';
import { createClaudeCodeAdapter } from '../agents/claude-code/index.js';
import { createAntigravityAdapter } from '../agents/antigravity/index.js';
import { projectSlugFor } from '../agents/claude-code/paths.js';
import { buildAgencyProfileLaunch } from './agency-profile-capabilities.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-native-context-'));
  const cwd = path.join(root, 'workspace'); const launchHome = path.join(root, 'launcher');
  await mkdir(cwd); await mkdir(launchHome);
  const env = { HOME: launchHome, USER: 'fixture', SHELL: '/bin/sh', PATH: '/usr/bin:/bin', TERM: 'xterm-256color', XDG_CONFIG_HOME: path.join(root,'xdg') };
  const store = new AgencyProfileStore(path.join(root, 'profiles.json'));
  const profiles = [];
  const rows = [];
  const native = path.join(root,'native-fixture');
  await writeFile(native, '#!' + process.execPath + '\nprocess.stdout.write("FIXTURE:"+JSON.stringify({wrapper:process.env.WRAPPER_ID,home:process.env.HOME,codexHome:process.env.CODEX_HOME,xdg:process.env.XDG_CONFIG_HOME,args:process.argv.slice(2)})+"\\n");setInterval(()=>{},1000);\n', { mode:0o700 });
  for (const definition of defaultDefinitions()) {
    const account = path.join(root, definition.id); await mkdir(account);
    const home = path.join(account, definition.provider === 'codex' ? '.codex' : definition.provider === 'antigravity' ? '.gemini/antigravity-cli' : '.claude');
    await mkdir(home,{recursive:true});
    const executable=path.join(root,definition.id === 'claude-code' ? 'claude' : definition.id + '-wrapper');
    const source='#!/bin/sh\nexport WRAPPER_ID="${0##*/}"\n' +
      (definition.provider === 'codex' ? `export CODEX_HOME='${home}'\n` : `export HOME='${account}'\nexport XDG_CONFIG_HOME='${account}/.config'\n`) +
      `exec '${native}' "$@"\n`;
    const target=definition.id==='agy00' ? path.join(root,'alias-dispatcher') : executable;
    await writeFile(target,source,{mode:0o700});
    if(target!==executable) await symlink(target,executable);
    const profile=await store.configure(definition.id,{executable,args:['literal two words']});
    profiles.push(profile);
    rows.push({profileId:profile.id,provider:profile.provider,executable,args:profile.args,environmentOverrides:{},home,
      artifacts:[{path:executable,sha256:await artifactDigest(executable)},{path:native,sha256:await artifactDigest(native)}],
      launchContext:{HOME:launchHome,USER:'fixture',CLAUDE_CONFIG_DIR:null},commands:{},requiredEnvironment:[]});
  }
  const manifest=path.join(root,'identities.json'); await writeFile(manifest,JSON.stringify({version:2,identities:rows}),{mode:0o600});
  const identities=await NativeIdentities.load(manifest);
  const registry=new AgentRegistry([createCodexAdapter(),createClaudeCodeAdapter(),createAntigravityAdapter()]);
  return {root,cwd,env,store,profiles,rows,identities,registry,native};
}
async function historyFile(provider: string, home: string, cwd: string, id: string) {
  const file=provider==='codex' ? path.join(home,'archived_sessions',`rollout-2026-10-28T00-00-00-${id}.jsonl`) :
    provider==='antigravity' ? path.join(home,'conversations',id+'.db') : path.join(home,'projects',projectSlugFor(cwd),id+'.jsonl');
  await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,'synthetic native state\n'); return file;
}

test('ten exact wrapper entry points preserve context and use provider-native resume arguments in real PTYs', async t => {
  const f=await fixture(); t.after(()=>rm(f.root,{recursive:true,force:true}));
  for (const [index,profile] of f.profiles.entries()) {
    const id=randomUUID(); const row=f.rows[index]!;
    await historyFile(profile.provider,row.home,f.cwd,id);
    const plan=await buildAgencyProfileLaunch(f.store,f.registry,{profileId:profile.id,cwd:f.cwd,resumeNativeSessionId:id,proposedSessionId:randomUUID(),launchToken:randomUUID(),environment:f.env},{identities:f.identities});
    assert.equal(plan.file,profile.executable); assert.ok(plan.nativeIdentity?.bindingId);
    assert.equal(plan.args[0],'literal two words');
    const flag=profile.provider==='codex' ? 'resume' : profile.provider==='antigravity' ? '--conversation' : '--resume';
    assert.ok(plan.args.includes(flag));
    assert.equal(profile.provider === 'codex' ? plan.args.at(-1) : plan.args[plan.args.indexOf(flag)+1],id);
    assert.equal(plan.env.HOME,f.env.HOME); // MAW leaves auth selection to the original wrapper.
    const pty=spawn(plan.file,[...plan.args],{cwd:f.cwd,env:plan.env,cols:100,rows:30});
    try {
      const text=await new Promise<string>((resolve,reject)=>{
        let output='';const timer=setTimeout(()=>reject(new Error('Fixture PTY timeout')),5000);
        pty.onData(chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(output);}});
      });
      const actual=JSON.parse(text.slice(text.indexOf('FIXTURE:')+8).trim());
      assert.equal(actual.wrapper,path.basename(profile.executable));
      assert.equal(profile.provider==='codex' ? actual.codexHome : actual.home,profile.provider==='codex' ? row.home : path.dirname(profile.provider==='antigravity' ? path.dirname(row.home) : row.home));
      assert.ok(actual.args.includes(id));
    } finally { const exited=new Promise(resolve=>pty.onExit(resolve));pty.kill();await exited; }
  }
});

test('missing history/context, changed wrappers, and escaped native state fail closed without preventing interactive startup', async t => {
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  for (const [index,profile] of f.profiles.entries()) {
    const row=f.rows[index]!;const id=randomUUID();const identity=(await f.identities.verifiedForProfile(profile,f.env))!;
    assert.equal(await ownsNativeSession(identity,id,f.cwd),false);
    const request={profileId:profile.id,cwd:f.cwd,resumeNativeSessionId:id,proposedSessionId:randomUUID(),launchToken:randomUUID(),environment:f.env};
    await assert.rejects(buildAgencyProfileLaunch(f.store,f.registry,request,{identities:f.identities}),/unavailable/);
    const file=await historyFile(profile.provider,row.home,f.cwd,id);
    assert.equal(await ownsNativeSession(identity,id,f.cwd),true);
    assert.equal(await f.identities.verifiedForProfile(profile,{...f.env,HOME:'/another'}),null);
    assert.equal(await f.identities.verifiedForProfile({...profile,args:['changed']},f.env),null);
    // A same-UUID file from another account is not this profile's ownership.
    await rm(file);const outside=path.join(f.root,'outside-'+index);await writeFile(outside,'other account');await symlink(outside,file);
    assert.equal(await ownsNativeSession(identity,id,f.cwd),false);
    await writeFile(profile.executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
    assert.equal(await f.identities.verifiedForProfile(profile,f.env),null);
    await assert.rejects(buildAgencyProfileLaunch(f.store,f.registry,request,{identities:f.identities}),/unverified/);
    const interactive=await buildAgencyProfileLaunch(f.store,f.registry,{...request,resumeNativeSessionId:null},{identities:f.identities});
    assert.equal(interactive.file,profile.executable);assert.equal(interactive.nativeIdentity,null);
  }
});

test('AGY and Claude history followers never redirect into another home or use global history for unknown identity', async t => {
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const { createAntigravityHistory }=await import('../agents/antigravity/history.js');
  const { createClaudeCodeHistory }=await import('../agents/claude-code/history.js');
  const { ModelVariantRegistry }=await import('../agents/claude-code/model-variants.js');
  for (const provider of ['antigravity','claude-code']) {
    const history=provider==='antigravity' ? createAntigravityHistory() : createClaudeCodeHistory(new ModelVariantRegistry());
    const id=randomUUID();const a=path.join(f.root,provider+'-a'),b=path.join(f.root,provider+'-b');
    await mkdir(a);await mkdir(b);
    const file=provider==='antigravity' ? path.join(a,'brain',id,'.system_generated/logs/transcript_full.jsonl') : path.join(a,'projects',projectSlugFor(f.cwd),id+'.jsonl');
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'synthetic fixture\n');
    for(const nativeHome of [b,null]) {
      const follower=history.follow({cwd:f.cwd,sessionId:id,nativeHome});await follower.start();
      assert.equal(follower.noticeChange(file),false);await follower.poll();assert.deepEqual(follower.getTail(100).events,[]);
    }
    const follower=history.follow({cwd:f.cwd,sessionId:id,nativeHome:a});
    assert.equal(follower.label,file);
    assert.equal(follower.noticeChange(file),true);
    assert.equal(follower.noticeChange(file.replace(a,b)),false);
    await rm(file);const outside=path.join(f.root,provider+'-foreign');await writeFile(outside,'foreign');await symlink(outside,file);
    assert.deepEqual((await follower.poll()).added,[]);
  }
});

test('AGY recovery capacity observes existing same-user processes and fails closed on unavailable inventory', async t => {
  const { nativeRecoveryCapacity }=await import('./recovery-capacity.js');
  const root=await mkdtemp(path.join(tmpdir(),'maw-capacity-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(let index=0;index<4;index++) {
    const folder=path.join(root,String(index+100));await mkdir(folder);await writeFile(path.join(folder,'comm'),index===0 ? 'agy00\n' : 'agy\n');
    assert.equal(await nativeRecoveryCapacity('antigravity',root),index<3);
  }
  assert.equal(await nativeRecoveryCapacity('antigravity',path.join(root,'absent')),false);
  assert.equal(await nativeRecoveryCapacity('codex',path.join(root,'absent')),true);
});
