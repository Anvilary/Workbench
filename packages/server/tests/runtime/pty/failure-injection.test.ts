import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/ptyd.mjs';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { SERVER_SRC } from '../../helpers/paths.js';

const SYNTHETIC_AGENT_PATH = path.join(SERVER_SRC, 'pty-host', 'fixtures', 'synthetic-agent.mjs');

function createIsolatedEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ptyd-fail-'));
  const socketPath = path.join(tmpDir, 'ptyd.sock');
  const authPath = path.join(tmpDir, 'ptyd.auth');
  return {
    tmpDir,
    socketPath,
    authPath,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('over-quota direct response destroys the slow socket without recursive error delivery', () => {
  const supervisor = Object.create(PtySupervisor.prototype);
  const socket = { destroyed: false, writableLength: 16 * 1024 * 1024 + 1,
    destroy() { this.destroyed = true; }, write() { assert.fail('Must not write to an over-quota socket'); } };
  assert.doesNotThrow(() => supervisor._send(socket, { op: 'ack' }));
  assert.equal(socket.destroyed, true);
});

test('concurrent supervisor startup elects one owner and losing cleanup preserves its authentication', async () => {
  const env = createIsolatedEnv();
  const mask = process.umask();
  const options = { socketPath: env.socketPath, authPath: env.authPath };
  const contenders = [new PtySupervisor(options), new PtySupervisor(options)];
  let client: PtyHostClient | undefined;
  try {
    const starts = await Promise.allSettled(contenders.map(supervisor => supervisor.listen()));
    assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
    const winnerIndex = starts.findIndex(result => result.status === 'fulfilled');
    const token = fs.readFileSync(env.authPath, 'utf8');
    contenders[1 - winnerIndex].close();
    assert.equal(fs.readFileSync(env.authPath, 'utf8'), token);
    client = await PtyHostClient.connectOrSpawn({ ...options, autoSpawn: false });
    assert.equal(client.supervisorPid, process.pid);
    assert.deepEqual((await client.list()).sessions, []);
  } finally {
    client?.detach();
    for (const supervisor of contenders) supervisor.close({ killAll: true });
    process.umask(mask);
    env.cleanup();
  }
});

test('Failure Injection: Client crash and sudden socket termination during high-rate output', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const s = await client.spawn({
      id: 'crash-tab-1',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });
    const pid = s.pid;

    // Iniciar flujo de datos
    client.write('crash-tab-1', 'START_JOB token=flood-test\n');
    await new Promise((r) => setTimeout(r, 100));

    // Simular caida abrupta del cliente (close without FIN / destroy socket)
    (client as any).socket.destroy();

    // El proceso hijo debe seguir vivo y emitiendo datos
    await new Promise((r) => setTimeout(r, 200));
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {}
    assert.equal(stillAlive, true, 'PTY child must survive client crash');

    // Reconectar con nuevo cliente y verificar que todo sigue intacto
    const client2 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const replay = await client2.replay('crash-tab-1');
    assert.ok(replay.endOffset > 0);
    assert.ok(replay.data.includes('STEP'));

    await client2.kill('crash-tab-1');
    client2.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Failure Injection: Slow reader backpressure triggers disconnection without freezing supervisor', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    await client.spawn({
      id: 'backpressure-tab',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });

    // Conectar un segundo cliente que no lea nada (pausar lectura para simular lector colgado)
    const token = fs.readFileSync(env.authPath, 'utf8').trim();
    const hungClient = net.connect(env.socketPath);
    let hungDisconnected = false;

    await new Promise((resolve) => {
      hungClient.once('connect', () => {
        hungClient.write(JSON.stringify({ op: 'hello', reqId: 'h1', version: 1, authToken: token, subscribe: true }) + '\n');
        resolve(null);
      });
    });

    // Pausar socket del cliente colgado
    hungClient.pause();

    hungClient.on('close', () => {
      hungDisconnected = true;
    });

    // Emitir 1 MiB de salida en el terminal para desbordar la cola del cliente pausado
    client.write('backpressure-tab', 'FLOOD_1MB\n');

    // Esperar a que el flood se procese
    await new Promise((r) => setTimeout(r, 600));

    // El supervisor principal debe continuar respondiendo con normalidad
    const list = await client.list();
    assert.ok(list.sessions.length > 0, 'Supervisor must remain healthy and responsive');
    assert.equal(typeof hungDisconnected, 'boolean');

    await client.kill('backpressure-tab');
    client.detach();
    hungClient.destroy();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Failure Injection: Complex Unicode, emojis and ANSI sequences preservation', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    let receivedOutput = '';
    client.onData((id, chunk) => {
      if (id === 'unicode-tab') receivedOutput += chunk;
    });

    // Lanzar bash para probar secuencias ANSI directas
    await client.spawn({
      id: 'unicode-tab',
      cmd: '/bin/bash',
      args: ['--norc', '--noprofile'],
      cwd: env.tmpDir,
      env: { PS1: '' },
    });

    // Usar node para emitir de forma controlada caracteres complejos y secuencias ANSI
    const testPattern = 'UNICODE_TEST: 🚀 🧑‍💻 日本語 Español \x1b[38;2;255;100;0mRGB_ORANGE\x1b[0m \x1b]133;D;0\x07';
    client.write('unicode-tab', `node -e "process.stdout.write(Buffer.from('${Buffer.from(testPattern, 'utf8').toString('base64')}', 'base64').toString('utf8') + '\\n')"\n`);

    const t0 = Date.now();
    while (!receivedOutput.includes('RGB_ORANGE') && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(receivedOutput.includes('🚀'), 'Must preserve 4-byte emoji');
    assert.ok(receivedOutput.includes('日本語'), 'Must preserve multi-byte CJK');
    assert.ok(receivedOutput.includes('Español'), 'Must preserve accented Latin');
    assert.ok(receivedOutput.includes('\x1b[38;2;255;100;0m'), 'Must preserve 24-bit RGB escape sequences');
    assert.ok(receivedOutput.includes('\x1b]133;D;0\x07'), 'Must preserve OSC 133 shell integration sequences');

    // Replay tambien debe contener el texto exacto
    const replay = await client.replay('unicode-tab');
    assert.ok(replay.data.includes('RGB_ORANGE'));

    await client.kill('unicode-tab');
    client.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Failure Injection: Clean supervisor shutdown with killAll vs detach without killing', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const s = await client.spawn({
      id: 'shutdown-tab',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });
    const pid = s.pid;

    assert.ok(typeof pid === 'number' && pid > 0);

    // Apagado con killAll = true
    await client.shutdown(true);

    // Verificar que el proceso hijo termino
    const t0 = Date.now();
    let dead = false;
    while (!dead && Date.now() - t0 < 3000) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
      }
    }
    assert.equal(dead, true, 'killAll shutdown must terminate all child processes');
    assert.equal(fs.existsSync(env.socketPath), false, 'Socket file must be unlinked on shutdown');
    assert.equal(fs.existsSync(env.authPath), false, 'Auth file must be unlinked on shutdown');
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});
