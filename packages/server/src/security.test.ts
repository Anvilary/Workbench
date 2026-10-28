import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { authorizeRequest, matchCredential } from './security.js';

test('malformed authentication cookies fail closed without throwing before WS authentication', () => {
  for (const value of ['%', '%GG', '%FF', '%E0%A4%A']) {
    const req = {url:'/ws',headers:{host:'127.0.0.1:41001',cookie:'agent_workbench_token='+value}} as IncomingMessage;
    assert.deepEqual(authorizeRequest(req,41001,'fixture-token',null),{ok:false,reason:'bad-token'});
    req.headers.cookie = 'agent_workbench_device='+value;
    assert.equal(matchCredential(req,'fixture-token',{match:()=>{throw new Error('Invalid cookie reached device verifier');}} as never),null);
  }
  const req = {url:'/ws',headers:{host:'127.0.0.1:41001',cookie:'agent_workbench_token=fixture-token'}} as IncomingMessage;
  assert.equal(authorizeRequest(req,41001,'fixture-token',null).ok,true);
  req.headers.origin='https://foreign.example';
  assert.deepEqual(authorizeRequest(req,41001,'fixture-token',null),{ok:false,reason:'bad-origin'});
});
