#!/usr/bin/env node
/**
 * MAW Persistent PTY Supervisor (maw-ptyd)
 *
 * Supervisor de procesos PTY desacoplado del backend MAW (Lane A / Objective B).
 * Mantiene descriptores maestros de PTY abiertos, drena salida en buffers circulares
 * acotados (256 KiB), rastrea el ciclo de vida y estado de salida (tombstones),
 * y expone una interfaz IPC sobre Unix Domain Socket con autenticacion local.
 *
 * Arquitectura:
 * - Pure ESM JavaScript ejecutable directamente por Node.js sin transpilacion.
 * - Desacople total: la caida o reinicio del backend MAW nunca mata a los procesos hijos.
 * - Seguridad: Directorio $XDG_RUNTIME_DIR/maw (0700), socket (0600 via umask 0177),
 *   y token criptografico efimero de 256 bits verificado con timingSafeEqual.
 */

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { TerminalState } from './terminal-state.mjs';

const PROTOCOL_VERSION = 1;
const DEFAULT_LIMIT_BYTES = 256 * 1024; // 256 KiB ring buffer por terminal
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_TOMBSTONES = 64;
const DEFAULT_TOMBSTONE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB max line length
const MAX_REPLAY_FRAME_BYTES = 512 * 1024; // 512 KiB max single replay_data frame before chunking
const REPLAY_CHUNK_RAW_BYTES = 256 * 1024; // 256 KiB raw bytes (~342 KiB base64) per replay_chunk
const MAX_CLIENT_WRITE_BUFFER = 16 * 1024 * 1024; // 16 MiB max backpressure antes de expulsar
const GRACEFUL_KILL_TIMEOUT_MS = 3000;
const MAX_TERMINAL_DIMENSION = 10000;

// -------------------------------------------------------------
// Buffer circular acotado de salida con offsets monotonicos
// -------------------------------------------------------------

function suffixWithinBytes(value, budget) {
  let start = value.length;
  let left = Math.max(0, budget);
  while (start > 0) {
    let previous = start - 1;
    const code = value.charCodeAt(previous);
    if (previous > 0 && code >= 0xdc00 && code <= 0xdfff) {
      const high = value.charCodeAt(previous - 1);
      if (high >= 0xd800 && high <= 0xdbff) previous--;
    }
    const length = Buffer.byteLength(value.slice(previous, start), 'utf8');
    if (length > left) break;
    left -= length;
    start = previous;
  }
  return value.slice(start);
}

export class SupervisorOutputBuffer {
  constructor(limitBytes = DEFAULT_LIMIT_BYTES) {
    this.limitBytes = limitBytes;
    this.state = new TerminalState();
    this.chunks = [];
    this.chunkSizes = [];
    this.head = 0;
    this.sizeBytes = 0;
    this.totalBytesPushed = 0;
    this.truncated = false;
    this.inAlternateScreen = false;
  }

  get startOffset() {
    return Math.max(0, this.totalBytesPushed - this.sizeBytes);
  }

  get endOffset() {
    return this.totalBytesPushed;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.state.push(chunk);

    if (chunk.includes('\x1b[?1049h') || chunk.includes('\x1b[?47h')) {
      this.inAlternateScreen = true;
    }
    if (chunk.includes('\x1b[?1049l') || chunk.includes('\x1b[?47l')) {
      this.inAlternateScreen = false;
    }

    const chunkByteLen = Buffer.byteLength(chunk, 'utf8');
    this.chunks.push(chunk);
    this.chunkSizes.push(chunkByteLen);
    this.sizeBytes += chunkByteLen;
    this.totalBytesPushed += chunkByteLen;

    while (this.sizeBytes > this.limitBytes && this.head < this.chunks.length) {
      const oldest = this.chunks[this.head];
      const size = this.chunkSizes[this.head];
      const remainingWithoutOldest = this.sizeBytes - size;
      if (remainingWithoutOldest >= this.limitBytes) {
        this.chunks[this.head] = undefined;
        this.head++;
        this.sizeBytes -= size;
      } else {
        const suffix = suffixWithinBytes(oldest, this.limitBytes - remainingWithoutOldest);
        if (suffix.length === 0) {
          this.chunks[this.head] = undefined;
          this.head++;
          this.sizeBytes -= size;
        } else {
          const suffixSize = Buffer.byteLength(suffix, 'utf8');
          this.chunks[this.head] = suffix;
          this.chunkSizes[this.head] = suffixSize;
          this.sizeBytes -= (size - suffixSize);
        }
      }
      this.truncated = true;
    }

    if (this.head > 0) {
      if (this.head === this.chunks.length) {
        this.chunks.length = 0;
        this.chunkSizes.length = 0;
        this.head = 0;
      } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
        this.chunks = this.chunks.slice(this.head);
        this.chunkSizes = this.chunkSizes.slice(this.head);
        this.head = 0;
      }
    }
  }

  read() {
    const raw = this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('');
    if (this.truncated && this.inAlternateScreen && !raw.includes('\x1b[?1049h') && !raw.includes('\x1b[?47h')) {
      return '\x1b[?1049h' + raw;
    }
    return raw;
  }

  sliceFrom(sinceOffset) {
    const start = this.startOffset;
    const end = this.endOffset;
    const truncated = this.truncated;

    if (sinceOffset === undefined || sinceOffset < start || sinceOffset > end) {
      return {
        reset: true,
        startOffset: start,
        endOffset: end,
        sinceOffset,
        data: this.read(),
        truncated,
      };
    }

    if (sinceOffset === end) {
      return {
        reset: false,
        startOffset: start,
        endOffset: end,
        sinceOffset,
        data: '',
        truncated,
      };
    }

    const bytesToSkip = sinceOffset - start;
    let skipped = 0;
    const resultParts = [];

    for (let i = this.head; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const chunkBytes = this.chunkSizes[i];
      const chunkEnd = skipped + chunkBytes;

      if (chunkEnd <= bytesToSkip) {
        skipped = chunkEnd;
        continue;
      }

      if (skipped < bytesToSkip) {
        const offsetWithinChunk = bytesToSkip - skipped;
        const buf = Buffer.from(chunk, 'utf8');
        if ((buf[offsetWithinChunk] & 0xc0) === 0x80) {
          return { reset: true, startOffset: start, endOffset: end, sinceOffset,
            data: this.read(), truncated };
        }
        resultParts.push(buf.subarray(offsetWithinChunk).toString('utf8'));
        skipped = chunkEnd;
      } else {
        resultParts.push(chunk);
        skipped = chunkEnd;
      }
    }

    return {
      reset: false,
      startOffset: start,
      endOffset: end,
      sinceOffset,
      data: resultParts.join(''),
      truncated,
    };
  }

  clear() {
    this.state.dispose();
    this.state = new TerminalState();
    this.chunks = [];
    this.chunkSizes = [];
    this.head = 0;
    this.sizeBytes = 0;
    this.totalBytesPushed = 0;
    this.truncated = false;
    this.inAlternateScreen = false;
  }
}

// -------------------------------------------------------------
// Servidor Supervisor de PTYs
// -------------------------------------------------------------

export class PtySupervisor {
  constructor(options = {}) {
    const baseRuntime = options.runtimeDir ||
      process.env.XDG_RUNTIME_DIR ||
      (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : os.tmpdir());

    this.runtimeDir = process.env.MAW_PTYD_RUNTIME_DIR || path.join(baseRuntime, 'maw-ptyd');

    this.socketPath = options.socketPath ||
      process.env.MAW_PTYD_SOCKET ||
      // Default: independent runtime dir owned by maw-ptyd.service (not the maw.service runtime dir).
      // This ensures the socket survives maw.service restarts. Overridable via MAW_PTYD_SOCKET.
      path.join(this.runtimeDir, 'ptyd.sock');

    this.authPath = options.authPath ||
      process.env.MAW_PTYD_AUTH_FILE ||
      `${this.socketPath}.auth`;

    this.maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
    this.maxTombstones = options.maxTombstones || DEFAULT_MAX_TOMBSTONES;
    this.tombstoneTtlMs = options.tombstoneTtlMs || DEFAULT_TOMBSTONE_TTL_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.killChildrenOnExit = Boolean(options.killChildrenOnExit);

    this.authToken = options.authToken ? Buffer.from(options.authToken, 'hex') : crypto.randomBytes(32);

    /** @type {Map<string, { id: string, sessionId?: string, cmd: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number, ptyProcess: any, pid: number, buffer: SupervisorOutputBuffer, createdAt: string, killTimer: any }>} */
    this.sessions = new Map();

    /** @type {Map<string, { id: string, sessionId?: string, pid: number, exitCode: number, signal: number | null, exitedAt: string, buffer: SupervisorOutputBuffer, finalOffset: number, expiresAt: number }>} */
    this.tombstones = new Map();

    /** @type {Set<net.Socket>} */
    this.clients = new Set();

    /** @type {Set<net.Socket>} */
    this.subscribers = new Set();

    this.server = null;
    this.ownsSocket = false;
    this.closing = false;
    this.sweeperTimer = null;
  }

  /**
   * Prepara el directorio seguro (0700) y graba el token criptografico (0600).
   * Rechaza directorios que sean symlinks o pertenezcan a otros usuarios.
   */
  _setupSecurityContext() {
    const dir = path.dirname(this.socketPath);
    if (fs.existsSync(dir)) {
      const lstat = fs.lstatSync(dir);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Security violation: socket parent directory ${dir} cannot be a symbolic link`);
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        throw new Error(`Security violation: socket parent directory ${dir} cannot be a symbolic link`);
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`Security violation: socket parent directory ${dir} is owned by UID ${stat.uid}, expected ${process.getuid()}`);
      }
      if ((stat.mode & 0o777) !== 0o700) {
        fs.chmodSync(dir, 0o700);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (fs.existsSync(this.socketPath) && fs.lstatSync(this.socketPath).isSymbolicLink()) {
      throw new Error(`Security violation: socket path ${this.socketPath} cannot be a symbolic link`);
    }
    if (fs.existsSync(this.authPath) && fs.lstatSync(this.authPath).isSymbolicLink()) {
      throw new Error(`Security violation: auth path ${this.authPath} cannot be a symbolic link`);
    }

  }

  _writeAuthFile() {
    if (fs.existsSync(this.authPath) && fs.lstatSync(this.authPath).isSymbolicLink()) {
      throw new Error(`Security violation: auth path ${this.authPath} cannot be a symbolic link`);
    }
    const tempAuthPath = `${this.authPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempAuthPath, this.authToken.toString('hex') + '\n', { mode: 0o600 });
    fs.renameSync(tempAuthPath, this.authPath);
  }

  /**
   * Sonda el socket actual para verificar si ya existe un demonio activo.
   */
  async _probeExistingSocket() {
    return new Promise((resolve) => {
      const probe = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve('ACTIVE');
      }, 500);

      probe.once('connect', () => {
        clearTimeout(timer);
        probe.end();
        resolve('ACTIVE');
      });

      probe.once('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          resolve('STALE_OR_MISSING');
        } else {
          // Permisos u otros errores tratados de forma conservadora
          resolve('ACTIVE');
        }
      });
    });
  }

  /**
   * Inicia el supervisor en el Unix domain socket configurado.
   */
  async listen() {
    this._setupSecurityContext();
    this.server = net.createServer((socket) => this._handleClient(socket));
    this.server.maxConnections = 32;

    // Crear socket con permisos 0600 garantizados usando umask(0o177)
    const oldUmask = process.umask(0o177);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            this.server.listen(this.socketPath, resolve);
            this.server.once('error', reject);
          });
          break;
        } catch (error) {
          if (error.code !== 'EADDRINUSE' || attempt > 0) throw error;
          let before;
          try { before = fs.lstatSync(this.socketPath); } catch { continue; }
          if (before.isSymbolicLink() || await this._probeExistingSocket() === 'ACTIVE') throw error;
          try {
            const after = fs.lstatSync(this.socketPath);
            if (before.dev === after.dev && before.ino === after.ino) fs.unlinkSync(this.socketPath);
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
        }
      }
    } finally {
      process.umask(oldUmask);
    }

    this.ownsSocket = true;
    // Binding the socket elects the owner. A losing concurrent starter must not
    // publish its token over the winner's credentials.
    try {
      this._writeAuthFile();
    } catch (error) {
      await new Promise((resolve) => this.server.close(resolve));
      throw error;
    }

    // Iniciar temporizador de limpieza de tombstones vencidos
    this.sweeperTimer = setInterval(() => this._sweepTombstones(), 60_000);
    this.sweeperTimer.unref();

    return {
      socketPath: this.socketPath,
      authPath: this.authPath,
      tokenHex: this.authToken.toString('hex'),
      pid: process.pid,
    };
  }

  _sweepTombstones() {
    const now = Date.now();
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) {
        tombstone.buffer.state.dispose();
        this.tombstones.delete(id);
      }
    }
  }

  /**
   * Maneja una conexion de cliente entrante.
   */
  _handleClient(socket) {
    this.clients.add(socket);

    let authenticated = false;
    let lineBuffer = '';
    const decoder = new StringDecoder('utf8');

    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        this._sendError(socket, undefined, 'UNAUTHORIZED', 'Authentication handshake timeout');
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);

    socket.on('data', (chunk) => {
      lineBuffer += decoder.write(chunk);

      if (lineBuffer.length > MAX_PAYLOAD_SIZE && !lineBuffer.includes('\n')) {
        this._sendError(socket, undefined, 'INVALID_PARAMS', 'Message size exceeds maximum allowed 1 MiB');
        socket.destroy();
        return;
      }

      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);

        if (line.length === 0) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this._sendError(socket, undefined, 'INVALID_PARAMS', 'Malformed NDJSON line');
          continue;
        }

        if (!authenticated) {
          if (message.op !== 'hello') {
            this._sendError(socket, message.reqId, 'UNAUTHORIZED', 'First message must be hello handshake');
            socket.destroy();
            return;
          }

          if (message.version !== PROTOCOL_VERSION) {
            this._sendError(socket, message.reqId, 'VERSION_MISMATCH', `Expected protocol version ${PROTOCOL_VERSION}, received ${message.version}`);
            socket.destroy();
            return;
          }

          const clientTokenHex = typeof message.authToken === 'string' ? message.authToken.trim() : '';
          const clientTokenBuf = Buffer.from(clientTokenHex, 'hex');

          if (
            clientTokenBuf.length !== this.authToken.length ||
            !crypto.timingSafeEqual(clientTokenBuf, this.authToken)
          ) {
            this._sendError(socket, message.reqId, 'UNAUTHORIZED', 'Invalid authentication token');
            socket.destroy();
            return;
          }

          clearTimeout(handshakeTimer);
          authenticated = true;

          if (message.subscribe) {
            this.subscribers.add(socket);
          }

          // Responder con snapshot de sesiones vivas y tombstones
          this._send(socket, {
            op: 'snapshot',
            reqId: message.reqId,
            version: PROTOCOL_VERSION,
            pid: process.pid,
            sessions: this.listSessions(),
            tombstones: this.listTombstones(),
          });
          continue;
        }

        // Cliente autenticado -> despachar operacion
        this._dispatch(socket, message);
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.clients.delete(socket);
      this.subscribers.delete(socket);
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  _sendRaw(socket, payload) {
    if (socket.destroyed) return;

    if (socket.writableLength > MAX_CLIENT_WRITE_BUFFER) {
      socket.destroy();
      return;
    }

    socket.write(payload);
  }

  _send(socket, msg) {
    this._sendRaw(socket, JSON.stringify(msg) + '\n');
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg) + '\n';
    for (const sub of this.subscribers) {
      if (sub.destroyed) {
        this.subscribers.delete(sub);
        continue;
      }
      if (sub.writableLength > MAX_CLIENT_WRITE_BUFFER) {
        sub.destroy();
        this.subscribers.delete(sub);
        continue;
      }
      sub.write(payload);
    }
  }

  _sendError(socket, reqId, code, message) {
    this._send(socket, { op: 'error', reqId, code, message });
  }

  _dispatch(socket, msg) {
    switch (msg.op) {
      case 'spawn':
        this._handleSpawn(socket, msg);
        break;
      case 'write':
        this._handleWrite(socket, msg);
        break;
      case 'resize':
        this._handleResize(socket, msg);
        break;
      case 'replay':
        this._handleReplay(socket, msg).catch((err) => {
          if (!this.closing && !socket.destroyed) {
            this._sendError(socket, msg.reqId, 'INTERNAL_ERROR', `Replay failed: ${err?.message ?? String(err)}`);
          }
        });
        break;
      case 'kill':
        this._handleKill(socket, msg);
        break;
      case 'reap_tombstone':
        this._handleReapTombstone(socket, msg);
        break;
      case 'list':
        this._send(socket, {
          op: 'session_list',
          reqId: msg.reqId,
          sessions: this.listSessions(),
          tombstones: this.listTombstones(),
        });
        break;
      case 'attach':
        this.subscribers.add(socket);
        if (msg.reqId) {
          this._send(socket, { op: 'ack', reqId: msg.reqId, id: msg.id });
        }
        break;
      case 'detach':
        this.subscribers.delete(socket);
        if (msg.reqId) {
          this._send(socket, { op: 'ack', reqId: msg.reqId });
        }
        break;
      case 'shutdown':
        this._handleShutdown(socket, msg);
        break;
      default:
        this._sendError(socket, msg.reqId, 'INVALID_PARAMS', `Unknown operation: ${msg.op}`);
    }
  }

  _handleSpawn(socket, msg) {
    const { reqId, id, sessionId, cmd, args = [], cwd, env = {}, cols = 80, rows = 24 } = msg;
    if (Object.hasOwn(msg, 'agencyManaged') && typeof msg.agencyManaged !== 'boolean') {
      return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Invalid agencyManaged ownership metadata');
    }

    if (!id || typeof id !== 'string') {
      return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Missing or invalid session id');
    }

    // Idempotencia: si la sesion ya existe y esta viva, devolver los datos existentes
    const existing = this.sessions.get(id);
    if (existing) {
      return this._send(socket, {
        op: 'spawned',
        reqId,
        id,
        pid: existing.pid,
      });
    }

    if (this.sessions.size >= this.maxSessions) {
      return this._sendError(socket, reqId, 'QUOTA_EXCEEDED', `Maximum session limit reached (${this.maxSessions})`);
    }

    if (!cmd || typeof cmd !== 'string') {
      return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Missing or invalid executable cmd');
    }

    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols <= 0 ||
      rows <= 0 ||
      cols > MAX_TERMINAL_DIMENSION ||
      rows > MAX_TERMINAL_DIMENSION
    ) {
      return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Invalid cols or rows dimension');
    }

    // Si habia un tombstone previo con este id, limpiarlo
    this.tombstones.get(id)?.buffer.state.dispose();
    this.tombstones.delete(id);

    const buffer = new SupervisorOutputBuffer(DEFAULT_LIMIT_BYTES);
    buffer.state.resize(cols, rows);
    let ptyProcess;

    try {
      ptyProcess = pty.spawn(cmd, [...args], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined,
      });
    } catch (err) {
      buffer.state.dispose();
      return this._sendError(socket, reqId, 'SPAWN_FAILED', `Failed to spawn process ${cmd}: ${err.message}`);
    }

    const sessionRecord = {
      id,
      sessionId,
      ...(Object.hasOwn(msg, 'agencyManaged') ? { agencyManaged: msg.agencyManaged } : {}),
      cmd,
      args,
      cwd,
      env,
      cols,
      rows,
      ptyProcess,
      pid: ptyProcess.pid,
      buffer,
      createdAt: new Date().toISOString(),
      killTimer: null,
    };

    this.sessions.set(id, sessionRecord);

    ptyProcess.onData((data) => {
      buffer.push(data);
      this._broadcast({
        op: 'data',
        id,
        offset: buffer.endOffset,
        dataB64: Buffer.from(data, 'utf8').toString('base64'),
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (sessionRecord.killTimer) {
        clearTimeout(sessionRecord.killTimer);
        sessionRecord.killTimer = null;
      }

      this.sessions.delete(id);

      const exitEvent = {
        op: 'exit',
        id,
        sessionId,
        pid: sessionRecord.pid,
        exitCode: exitCode ?? 0,
        signal: signal ?? null,
        exitedAt: new Date().toISOString(),
        finalOffset: buffer.endOffset,
      };

      // Registrar tombstone con retencion acotada (TTL + limite maximo de entradas)
      this._sweepTombstones();
      const previousTombstone = this.tombstones.get(id);
      if (previousTombstone) {
        previousTombstone.buffer.state.dispose();
        this.tombstones.delete(id);
      }
      while (this.tombstones.size >= this.maxTombstones) {
        const oldestKey = this.tombstones.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.tombstones.get(oldestKey);
        oldest?.buffer.state.dispose();
        this.tombstones.delete(oldestKey);
      }
      this.tombstones.set(id, {
        id,
        sessionId,
        pid: sessionRecord.pid,
        exitCode: exitCode ?? 0,
        signal: signal ?? null,
        exitedAt: exitEvent.exitedAt,
        buffer,
        finalOffset: buffer.endOffset,
        expiresAt: Date.now() + this.tombstoneTtlMs,
      });

      this._broadcast(exitEvent);
    });

    this._send(socket, {
      op: 'spawned',
      reqId,
      id,
      pid: ptyProcess.pid,
    });
  }

  _handleWrite(socket, msg) {
    const { reqId, id, dataB64, data } = msg;
    const session = this.sessions.get(id);

    if (!session) {
      return this._sendError(socket, reqId, 'SESSION_NOT_FOUND', `Session ${id} not found or already exited`);
    }

    let chunk = '';
    if (typeof dataB64 === 'string') {
      try {
        chunk = Buffer.from(dataB64, 'base64').toString('utf8');
      } catch {
        return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Invalid base64 payload');
      }
    } else if (typeof data === 'string') {
      chunk = data;
    }

    try {
      session.ptyProcess.write(chunk);
      if (reqId) {
        this._send(socket, { op: 'ack', reqId, id });
      }
    } catch (err) {
      this._sendError(socket, reqId, 'INTERNAL_ERROR', `Failed to write to pty: ${err.message}`);
    }
  }

  _handleResize(socket, msg) {
    const { reqId, id, cols, rows } = msg;
    const session = this.sessions.get(id);

    if (!session) {
      return this._sendError(socket, reqId, 'SESSION_NOT_FOUND', `Session ${id} not found or already exited`);
    }

    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols <= 0 ||
      rows <= 0 ||
      cols > MAX_TERMINAL_DIMENSION ||
      rows > MAX_TERMINAL_DIMENSION
    ) {
      return this._sendError(socket, reqId, 'INVALID_PARAMS', 'Invalid cols or rows dimension');
    }

    try {
      session.cols = cols;
      session.rows = rows;
      session.buffer.state.resize(cols, rows);
      session.ptyProcess.resize(cols, rows);
      if (reqId) {
        this._send(socket, { op: 'ack', reqId, id });
      }
    } catch (err) {
      this._sendError(socket, reqId, 'INTERNAL_ERROR', `Failed to resize pty: ${err.message}`);
    }
  }

  async _handleReplay(socket, msg) {
    const { reqId, id, sinceOffset } = msg;
    const session = this.sessions.get(id);
    const tombstone = this.tombstones.get(id);

    const buffer = session?.buffer || tombstone?.buffer;
    if (!buffer) {
      return this._sendError(socket, reqId, 'SESSION_NOT_FOUND', `Session or tombstone ${id} not found`);
    }

    const slice = buffer.sliceFrom(sinceOffset);
    // Keep raw data/offsets compatible with existing hosts; checkpoints are
    // separate generated VT bytes and must never enter the raw delta ring.
    let screen;
    if (slice.reset) {
      try {
        screen = await buffer.state.snapshot();
      } catch {
        if (this.closing || socket.destroyed) return;
        if (!this.sessions.has(id) && !this.tombstones.has(id)) {
          this._sendError(socket, reqId, 'SESSION_NOT_FOUND', `Session or tombstone ${id} was disposed during replay`);
          return;
        }
        // Snapshot unavailable; fall back to raw ring replay instead of hanging reqId.
        screen = undefined;
      }
    }

    if (this.closing || socket.destroyed) return;

    const dataBuf = Buffer.from(slice.data, 'utf8');
    const singleMsg = {
      op: 'replay_data',
      reqId,
      id,
      reset: slice.reset,
      startOffset: slice.startOffset,
      endOffset: slice.endOffset,
      sinceOffset: slice.sinceOffset,
      dataB64: dataBuf.toString('base64'),
      truncated: slice.truncated,
      ...(screen ? { screen } : {}),
    };
    const serialized = JSON.stringify(singleMsg);
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_REPLAY_FRAME_BYTES) {
      this._sendRaw(socket, serialized + '\n');
      return;
    }

    // Payload exceeds safe single-frame limit: stream bounded replay_chunk frames
    // followed by the terminating replay_data frame so no NDJSON line exceeds MAX_PAYLOAD_SIZE.
    for (let offset = 0; offset < dataBuf.length; offset += REPLAY_CHUNK_RAW_BYTES) {
      const part = dataBuf.subarray(offset, offset + REPLAY_CHUNK_RAW_BYTES);
      this._send(socket, {
        op: 'replay_chunk',
        reqId,
        id,
        dataB64: part.toString('base64'),
      });
    }

    if (screen && screen.data.length > 0) {
      const screenBuf = Buffer.from(screen.data, 'utf8');
      for (let offset = 0; offset < screenBuf.length; offset += REPLAY_CHUNK_RAW_BYTES) {
        const part = screenBuf.subarray(offset, offset + REPLAY_CHUNK_RAW_BYTES);
        this._send(socket, {
          op: 'replay_chunk',
          reqId,
          id,
          screenDataB64: part.toString('base64'),
        });
      }
    }

    this._send(socket, {
      op: 'replay_data',
      reqId,
      id,
      reset: slice.reset,
      startOffset: slice.startOffset,
      endOffset: slice.endOffset,
      sinceOffset: slice.sinceOffset,
      dataB64: '',
      truncated: slice.truncated,
      chunked: true,
      ...(screen ? { screen: { data: '', cols: screen.cols, rows: screen.rows } } : {}),
    });
  }

  _handleKill(socket, msg) {
    const { reqId, id, signal = 'SIGTERM' } = msg;
    const session = this.sessions.get(id);

    if (!session) {
      // Si habia tombstone, eliminarlo en kill explicito
      this.tombstones.get(id)?.buffer.state.dispose();
      this.tombstones.delete(id);
      return this._send(socket, { op: 'killed', reqId, id });
    }

    const pid = session.pid;

    // Terminacion segura de grupo de procesos POSIX
    try {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, signal); } catch {}
      }
      process.kill(pid, signal);
    } catch {}

    // Escalamiento elegante a SIGKILL si no termina tras 3s (sin filtrar timers en kills repetidos)
    if (process.platform !== 'win32') {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      session.killTimer = setTimeout(() => {
        session.killTimer = null;
        if (this.sessions.get(id) !== session) return;
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }, GRACEFUL_KILL_TIMEOUT_MS);
      session.killTimer.unref();
    }

    this._send(socket, { op: 'killed', reqId, id });
  }

  _handleReapTombstone(socket, msg) {
    const { reqId, id } = msg;
    this.tombstones.get(id)?.buffer.state.dispose();
    this.tombstones.delete(id);
    if (reqId) {
      this._send(socket, { op: 'ack', reqId, id });
    }
  }

  _handleShutdown(socket, msg) {
    const { reqId, killAll } = msg;
    this._send(socket, { op: 'ack', reqId });

    this.close({ killAll });
  }

  listSessions() {
    const result = [];
    for (const [id, s] of this.sessions) {
      result.push({
        id,
        sessionId: s.sessionId,
        ...(Object.hasOwn(s, 'agencyManaged') ? { agencyManaged: s.agencyManaged } : {}),
        pid: s.pid,
        alive: true,
        startOffset: s.buffer.startOffset,
        endOffset: s.buffer.endOffset,
        cmd: s.cmd,
        cwd: s.cwd,
        createdAt: s.createdAt,
      });
    }
    return result;
  }

  listTombstones() {
    const result = [];
    for (const [id, t] of this.tombstones) {
      result.push({
        id,
        sessionId: t.sessionId,
        pid: t.pid,
        exitCode: t.exitCode,
        signal: t.signal,
        exitedAt: t.exitedAt,
        startOffset: t.buffer.startOffset,
        endOffset: t.buffer.endOffset,
      });
    }
    return result;
  }

  close({ killAll = false } = {}) {
    if (this.closing) return;
    this.closing = true;
    for (const session of this.sessions.values()) {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      session.buffer.state.dispose();
    }
    for (const tombstone of this.tombstones.values()) tombstone.buffer.state.dispose();

    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }

    if (killAll || this.killChildrenOnExit) {
      for (const [id, s] of this.sessions) {
        try {
          if (process.platform !== 'win32') {
            try { process.kill(-s.pid, 'SIGKILL'); } catch {}
          }
          process.kill(s.pid, 'SIGKILL');
        } catch {}
      }
      this.sessions.clear();
    }

    for (const client of this.clients) {
      try { client.destroy(); } catch {}
    }
    this.clients.clear();
    this.subscribers.clear();

    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }

    if (this.ownsSocket) {
      try {
        if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
      } catch {}
      try {
        if (fs.existsSync(this.authPath) && !fs.lstatSync(this.authPath).isSymbolicLink() &&
            fs.readFileSync(this.authPath, 'utf8').trim() === this.authToken.toString('hex')) fs.unlinkSync(this.authPath);
      } catch {}
      this.ownsSocket = false;
    }
  }
}

// -------------------------------------------------------------
// Punto de entrada CLI si se ejecuta directamente
// -------------------------------------------------------------

export function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--socket' && i + 1 < args.length) {
      options.socketPath = args[++i];
    } else if (arg === '--auth-file' && i + 1 < args.length) {
      options.authPath = args[++i];
    } else if (arg === '--auth-token' && i + 1 < args.length) {
      options.authToken = args[++i];
    } else if (arg === '--runtime-dir' && i + 1 < args.length) {
      options.runtimeDir = args[++i];
    } else if (arg === '--kill-children-on-exit') {
      options.killChildrenOnExit = true;
    }
  }

  return options;
}

export function isMainModule(importMetaUrl = import.meta.url) {
  if (!process.argv || !process.argv[1] || typeof process.argv[1] !== 'string') {
    return false;
  }
  try {
    let argvPath = process.argv[1];
    if (argvPath.startsWith('file://')) {
      try {
        argvPath = fileURLToPath(argvPath);
      } catch {}
    }
    const scriptPath = fs.realpathSync(path.resolve(argvPath));
    const modulePath = fs.realpathSync(fileURLToPath(importMetaUrl));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  const options = parseCliArgs();
  const supervisor = new PtySupervisor(options);

  supervisor.listen()
    .then(({ socketPath, authPath, pid }) => {
      console.log(`[maw-ptyd] Listening on ${socketPath} (pid: ${pid}, auth: ${authPath})`);
    })
    .catch((err) => {
      console.error(`[maw-ptyd] Failed to start: ${err.message}`);
      process.exit(1);
    });

  const onSignal = () => {
    supervisor.close();
    process.exit(0);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}
