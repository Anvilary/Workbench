// Child process only: authentication parser exceptions must never kill an upgrade listener.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const code = `import {createServer} from 'node:http';
import net from 'node:net';
import {authorizeRequest} from './packages/server/src/security/request-guards.ts';
const server=createServer();
server.on('upgrade',(req,socket)=>{const result=authorizeRequest(req,server.address().port,'fixture-secret',null);socket.end('HTTP/1.1 '+(result.ok?'101 Switching Protocols':'403 Forbidden')+'\\r\\nConnection: close\\r\\n\\r\\n');});
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;const socket=net.connect(port,'127.0.0.1',()=>socket.write('GET /ws HTTP/1.1\\r\\nHost: 127.0.0.1:'+port+'\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nCookie: agent_workbench_token=%\\r\\n\\r\\n'));socket.on('data',d=>process.stdout.write(d));socket.on('error',()=>{});socket.on('close',()=>server.close());});`;
const child=spawn(process.execPath,['--import','./packages/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
let out=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>out+=d);
const [exit]=await once(child,'exit');
console.log(JSON.stringify({exit, output:out},null,2));
process.exitCode=exit;
