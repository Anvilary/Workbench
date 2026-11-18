import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';

test('supervisor reconnect reloads the replaced auth token after a clean disconnect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maw-pty-reconnect-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const socketPath = path.join(runtime, 'ptyd.sock');
  const authPath = `${socketPath}.auth`;
  let token = randomBytes(32).toString('hex');
  let pid = 100;
  await writeFile(authPath, `${token}\n`, { mode: 0o600 });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let line = '';
    socket.on('data', (chunk) => {
      line += chunk.toString('utf8');
      const newline = line.indexOf('\n');
      if (newline < 0) return;
      const hello = JSON.parse(line.slice(0, newline));
      const response = hello.authToken === token
        ? { op: 'snapshot', reqId: hello.reqId, sessions: [], tombstones: [], pid }
        : { op: 'error', reqId: hello.reqId, code: 'UNAUTHORIZED', message: 'bad token' };
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let client: PtyHostClient | null = null;
  try {
    client = await PtyHostClient.connectOrSpawn({ socketPath, authPath, autoSpawn: false });
    let disconnected = false;
    client.onDisconnect(() => { disconnected = true; });
    for (const socket of sockets) socket.destroy();
    const deadline = Date.now() + 1000;
    while (!disconnected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disconnected, true);

    token = randomBytes(32).toString('hex');
    pid = 200;
    await writeFile(authPath, `${token}\n`, { mode: 0o600 });
    const recovered = await client.reconnect();
    assert.equal(recovered.pid, 200);
  } finally {
    client?.detach();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
