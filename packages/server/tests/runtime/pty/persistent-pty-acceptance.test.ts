import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/maw-ptyd.mjs';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { SERVER_SRC } from '../../helpers/paths.js';

const SYNTHETIC_AGENT_PATH = path.join(SERVER_SRC, 'pty-host', 'fixtures', 'synthetic-agent.mjs');

function createIsolatedEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-ptyd-test-'));
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

test('Persistent PTY Acceptance: 14-step lifecycle, disconnection survival, incremental replay & cleanup', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    // 1. Iniciar supervisor desechable
    await supervisor.listen();

    // 2. Conectar cliente desechable 1
    const client1 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    let client1Output = '';
    client1.onData((id, chunk) => {
      if (id === 'term-1') client1Output += chunk;
    });

    // 3. Lanzar proceso PTY real con agente sintetico
    const spawnRes = await client1.spawn({
      id: 'term-1',
      sessionId: 'agency-test-session-1',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
      cols: 80,
      rows: 24,
    });

    const originalPid = spawnRes.pid;
    assert.ok(typeof originalPid === 'number' && originalPid > 0, 'Original PID must be a valid positive integer');

    // Esperar mensaje inicial AGENT_READY
    const t0 = Date.now();
    while (!client1Output.includes('AGENT_READY') && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(client1Output.includes(`AGENT_READY pid=${originalPid}`), 'Initial output must confirm process start');

    // 4. Iniciar trabajo prolongado en segundo plano
    client1.write('term-1', 'START_JOB token=job-alpha-99\n');

    while (!client1Output.includes('JOB_STARTED token=job-alpha-99') && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(client1Output.includes('JOB_STARTED token=job-alpha-99 step=1'));

    // Esperar a que el contador avance a step 2 o mas
    while (!client1Output.includes('STEP 2') && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Registrar offset antes de la desconexion
    const replayBeforeDisconnect = await client1.replay('term-1');
    const offsetBeforeDisconnect = replayBeforeDisconnect.endOffset;
    assert.ok(offsetBeforeDisconnect > 0);

    // 5. Desconectar cliente 1 (simula caida o reinicio de maw.service)
    client1.detach();

    // 6. Esperar mientras el cliente esta completamente desconectado (el proceso sigue emitiendo STEP k)
    await new Promise((r) => setTimeout(r, 300));

    // 7. Verificar que el proceso SO original SIGUE VIVO
    let isAlive = false;
    try {
      process.kill(originalPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, true, 'Original child PID MUST remain alive while backend is disconnected');

    // 8. Conectar cliente desechable 2 (simula nuevo backend tras reinicio)
    const client2 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    let client2Output = '';
    client2.onData((id, chunk) => {
      if (id === 'term-1') client2Output += chunk;
    });

    // 9. Verificar snapshot recibido tras reconexion
    const list = await client2.list();
    const liveSession = list.sessions.find((s) => s.id === 'term-1');
    assert.ok(liveSession, 'Session term-1 must be listed as alive in supervisor');
    assert.equal(liveSession.pid, originalPid, 'PID in supervisor must match original child PID');
    assert.ok(liveSession.endOffset > offsetBeforeDisconnect, 'End offset must have advanced during disconnect');

    // 10. Reenganche incremental con sinceOffset
    const deltaReplay = await client2.replay('term-1', offsetBeforeDisconnect);
    assert.equal(deltaReplay.reset, false, 'Incremental delta replay must NOT require reset');
    assert.ok(deltaReplay.endOffset > offsetBeforeDisconnect);
    assert.ok(deltaReplay.data.includes('STEP'), 'Delta replay must include missed steps emitted during downtime');

    // 11. Verificar entrada y salida interactivas tras reconexion
    client2.write('term-1', 'PING req-42\n');
    const pingStart = Date.now();
    while (!client2Output.includes(`PONG req-42 pid=${originalPid}`) && Date.now() - pingStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(client2Output.includes(`PONG req-42 pid=${originalPid}`), 'Interactive PING/PONG must succeed with same PID');

    // 12. Verificar que redimensionamiento (resize) llega a la PTY original
    client2.resize('term-1', 137, 43);
    const winchStart = Date.now();
    while (!client2Output.includes('WINCH cols=137 rows=43') && Date.now() - winchStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(client2Output.includes('WINCH cols=137 rows=43'), 'Terminal resize must propagate SIGWINCH to child');

    // 13. Verificar retencion acotada y reporte de truncamiento tras flood
    client2.write('term-1', 'FLOOD_1MB\n');
    const floodStart = Date.now();
    while (!client2Output.includes('FLOOD_DONE') && Date.now() - floodStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(client2Output.includes('FLOOD_DONE'), 'Flood output must complete');

    // Replay para un nuevo cliente sin offset (debe recibir maximo 256 KiB con reset=true y truncated=true)
    const fullReplay = await client2.replay('term-1');
    assert.equal(fullReplay.reset, true, 'Full replay must declare reset=true');
    assert.equal(fullReplay.truncated, true, 'Replay after 1MB flood must report truncated=true');
    assert.ok(Buffer.byteLength(fullReplay.data, 'utf8') <= 262_144, 'Replay buffer must be strictly bounded <= 256 KiB');

    // 14. Terminar sesion deliberadamente y verificar limpieza completa
    const killRes = await client2.kill('term-1');
    assert.equal(killRes.id, 'term-1');

    // Esperar terminacion del proceso hijo
    const killStart = Date.now();
    let childStillRunning = true;
    while (childStillRunning && Date.now() - killStart < 3000) {
      try {
        process.kill(originalPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        childStillRunning = false;
      }
    }
    assert.equal(childStillRunning, false, 'Original child process must terminate on explicit kill');

    client2.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Persistent PTY Acceptance: Tombstone preservation when process exits while disconnected', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client1 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const spawnRes = await client1.spawn({
      id: 'term-tombstone',
      sessionId: 'agency-tomb-session',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
      cols: 80,
      rows: 24,
    });
    const pid = spawnRes.pid;

    // Desconectar cliente inmediatamente
    client1.detach();

    // Causar que el proceso termine mientras el backend esta desconectado
    // Como el agente lee stdin, conectamos un socket raw para inyectar EXIT_WITH 19
    const rawClient = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });
    rawClient.write('term-tombstone', 'EXIT_WITH 19\n');
    rawClient.detach();

    // Esperar a que el proceso termine
    const t0 = Date.now();
    let processDead = false;
    while (!processDead && Date.now() - t0 < 3000) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        processDead = true;
      }
    }
    assert.equal(processDead, true, 'Child process must have exited');

    // Conectar nuevo cliente y verificar que el tombstone esta presente con exitCode=19
    const client2 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const list = await client2.list();
    assert.equal(list.sessions.some((s) => s.id === 'term-tombstone'), false, 'Session must not be in live sessions');

    const tombstone = list.tombstones.find((t) => t.id === 'term-tombstone');
    assert.ok(tombstone, 'Tombstone for term-tombstone must be preserved');
    assert.equal(tombstone.exitCode, 19, 'Tombstone exitCode must be 19');
    assert.equal(tombstone.pid, pid, 'Tombstone PID must match original PID');

    // Verificar que se puede solicitar replay del tombstone
    const replay = await client2.replay('term-tombstone');
    assert.ok(replay.data.includes('FINAL_ERROR_LINE code=19'), 'Tombstone replay must include final output line');

    // Cosechar tombstone y verificar que se elimino
    client2.reapTombstone('term-tombstone');
    await new Promise((r) => setTimeout(r, 100));

    const updatedList = await client2.list();
    assert.equal(updatedList.tombstones.some((t) => t.id === 'term-tombstone'), false, 'Tombstone must be reaped');

    client2.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Persistent PTY Acceptance: Security, permissions and input validation', async () => {
  const env = createIsolatedEnv();
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    // 1. Verificar permisos del directorio y socket
    const dirStat = fs.statSync(env.tmpDir);
    assert.equal((dirStat.mode & 0o777), 0o700, 'Directory permissions must be 0700');

    const socketStat = fs.statSync(env.socketPath);
    assert.equal((socketStat.mode & 0o777), 0o600, 'Socket inode permissions must be 0600');

    const authStat = fs.statSync(env.authPath);
    assert.equal((authStat.mode & 0o777), 0o600, 'Auth file permissions must be 0600');

    // 2. Rechazar conexion no autenticada
    await assert.rejects(async () => {
      const sock = net.connect(env.socketPath);
      await new Promise<void>((_, reject) => {
        sock.once('connect', () => {
          sock.write(JSON.stringify({ op: 'hello', reqId: 'test-1', version: 1, authToken: 'wrong-token' }) + '\n');
        });
        sock.on('data', (d) => {
          const msg = JSON.parse(d.toString('utf8'));
          if (msg.op === 'error' && msg.code === 'UNAUTHORIZED') {
            reject(new Error('UNAUTHORIZED_REJECTED'));
          }
        });
        sock.on('close', () => reject(new Error('SOCKET_CLOSED')));
      });
    }, /UNAUTHORIZED_REJECTED|SOCKET_CLOSED/);

    // 3. Rechazar version de protocolo incompatible
    await assert.rejects(async () => {
      const token = fs.readFileSync(env.authPath, 'utf8').trim();
      const sock = net.connect(env.socketPath);
      await new Promise<void>((_, reject) => {
        sock.once('connect', () => {
          sock.write(JSON.stringify({ op: 'hello', reqId: 'test-v', version: 999, authToken: token }) + '\n');
        });
        sock.on('data', (d) => {
          const msg = JSON.parse(d.toString('utf8'));
          if (msg.op === 'error' && msg.code === 'VERSION_MISMATCH') {
            reject(new Error('VERSION_MISMATCH_REJECTED'));
          }
        });
        sock.on('close', () => reject(new Error('SOCKET_CLOSED')));
      });
    }, /VERSION_MISMATCH_REJECTED|SOCKET_CLOSED/);

    // 4. Tolerar NDJSON malformado sin caerse
    const validClient = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const rawSock = net.connect(env.socketPath);
    const token = fs.readFileSync(env.authPath, 'utf8').trim();
    await new Promise<void>((resolve) => {
      rawSock.once('connect', () => {
        rawSock.write(JSON.stringify({ op: 'hello', reqId: 'ok', version: 1, authToken: token }) + '\n');
        rawSock.write('{bad-json-syntax-here\n');
        rawSock.write(JSON.stringify({ op: 'list', reqId: 'after-bad' }) + '\n');
      });
      rawSock.on('data', (d) => {
        if (d.toString('utf8').includes('session_list')) {
          rawSock.end();
          resolve();
        }
      });
    });

    // Supervisor debe seguir respondiendo al cliente valido
    const listRes = await validClient.list();
    assert.ok(Array.isArray(listRes.sessions));

    validClient.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Persistent PTY Acceptance: Concurrent isolated sessions', async () => {
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

    const s1 = await client.spawn({
      id: 'term-A',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });

    const s2 = await client.spawn({
      id: 'term-B',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });

    assert.notEqual(s1.pid, s2.pid, 'Different sessions must have distinct PIDs');

    const list = await client.list();
    assert.equal(list.sessions.length, 2);

    // Cerrar term-A no debe afectar a term-B
    await client.kill('term-A');
    await new Promise((r) => setTimeout(r, 100));

    const listAfterKillA = await client.list();
    assert.equal(listAfterKillA.sessions.some((s) => s.id === 'term-A'), false);
    assert.equal(listAfterKillA.sessions.some((s) => s.id === 'term-B'), true);

    let bStillAlive = false;
    try {
      process.kill(s2.pid, 0);
      bStillAlive = true;
    } catch {}
    assert.equal(bStillAlive, true, 'term-B must remain unaffected when term-A is killed');

    await client.kill('term-B');
    client.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});
