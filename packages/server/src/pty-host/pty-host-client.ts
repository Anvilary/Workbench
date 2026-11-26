/**
 * Cliente IPC para conectarse a `maw-ptyd` (Persistent PTY Supervisor).
 *
 * Lane A & B - Client Adapter & Reconnection Protocol
 */

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PTY_PROTOCOL_VERSION,
  MAX_PAYLOAD_SIZE,
  type PtyClientRequest,
  type PtyServerMessage,
  type PtyHostSessionInfo,
  type PtyHostTombstoneInfo,
  type PtySnapshotResponse,
  type PtySpawnedResponse,
  type PtyReplayDataResponse,
  type PtyKilledResponse,
  type PtyExitEvent,
} from './pty-host-types.js';

export interface PtyHostClientOptions {
  socketPath?: string;
  authPath?: string;
  authToken?: string;
  autoSpawn?: boolean;
  spawnTimeoutMs?: number;
  supervisorScriptPath?: string;
}

export type PtyDataCallback = (id: string, chunk: string, offset: number) => void;
export type PtyExitCallback = (event: PtyExitEvent) => void;
export type PtyDisconnectCallback = () => void;

function safeReadAuthToken(authPath: string): string {
  try {
    const dir = path.dirname(authPath);
    if (!fs.existsSync(dir) || !fs.existsSync(authPath)) return '';
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`Security violation: socket parent directory ${dir} cannot be a symbolic link`);
    }
    if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) {
      throw new Error(`Security violation: socket parent directory ${dir} is owned by UID ${dirStat.uid}, expected ${process.getuid()}`);
    }
    const authStat = fs.lstatSync(authPath);
    if (authStat.isSymbolicLink()) {
      throw new Error(`Security violation: auth file ${authPath} cannot be a symbolic link`);
    }
    return fs.readFileSync(authPath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Detects whether execution is running inside a test runner environment.
 */
export function isTestExecution(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.npm_lifecycle_event === 'test') return true;
  if (typeof process.env.NODE_TEST_CONTEXT !== 'undefined') return true;
  if (typeof process.env.VITEST !== 'undefined' || typeof process.env.JEST_WORKER_ID !== 'undefined') return true;
  const args = [...process.execArgv, ...process.argv];
  return args.some((arg) =>
    arg === '--test' ||
    arg.startsWith('--test=') ||
    arg.includes('node:test') ||
    /\.test\.[cm]?[jt]sx?$/.test(arg),
  );
}

/** A request the supervisor answered with an `error` op. */
export class PtyHostRequestError extends Error {
  constructor(
    readonly code: string,
    readonly supervisorMessage: string,
  ) {
    super(`[${code}] ${supervisorMessage}`);
    this.name = 'PtyHostRequestError';
  }
}

/** The cap an older supervisor reported in "Maximum session limit reached (N)", or null. */
export function supervisorQuotaLimit(error: unknown): number | null {
  if (!(error instanceof PtyHostRequestError) || error.code !== 'QUOTA_EXCEEDED') return null;
  const match = /\((\d+)\)/.exec(error.supervisorMessage);
  const limit = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
}

export class PtyHostClient {
  private socket: net.Socket | null = null;
  private lineBuffer = '';
  private decoder = new StringDecoder('utf8');
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private replayChunks = new Map<string, { dataParts: Buffer[]; screenParts: Buffer[] }>();
  private dataListeners = new Set<PtyDataCallback>();
  private exitListeners = new Set<PtyExitCallback>();
  private disconnectListeners = new Set<PtyDisconnectCallback>();
  private closed = false;
  private _snapshot: PtySnapshotResponse | null = null;
  private reconnecting = false;

  readonly socketPath: string;
  readonly authPath: string;
  private authToken: string;

  get snapshot(): PtySnapshotResponse | null {
    return this._snapshot;
  }

  private constructor(socketPath: string, authPath: string, authToken: string) {
    this.socketPath = socketPath;
    this.authPath = authPath;
    this.authToken = authToken;
  }

  /**
   * Conecta a un demonio `maw-ptyd` existente o lanza uno en segundo plano si no existe.
   */
  static async connectOrSpawn(options: PtyHostClientOptions = {}): Promise<PtyHostClient> {
    if (
      isTestExecution() &&
      !options.socketPath &&
      !process.env.MAW_PTYD_SOCKET &&
      !process.env.MAW_PTYD_RUNTIME_DIR
    ) {
      throw new Error(
        'Refusing to connect to production PTY supervisor socket in test environment without explicit socketPath or MAW_PTYD_RUNTIME_DIR',
      );
    }

    const baseRuntime = process.env.XDG_RUNTIME_DIR ||
      (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : os.tmpdir());

    const runtimeDir = process.env.MAW_PTYD_RUNTIME_DIR ||
      path.join(baseRuntime, 'maw-ptyd');

    const socketPath = options.socketPath ||
      process.env.MAW_PTYD_SOCKET ||
      // Default: independent runtime dir owned by maw-ptyd.service (not the maw.service runtime dir).
      // This ensures the backend finds the socket after a maw.service restart.
      path.join(runtimeDir, 'ptyd.sock');

    const authPath = options.authPath ||
      process.env.MAW_PTYD_AUTH_FILE ||
      `${socketPath}.auth`;

    const autoSpawn = options.autoSpawn ?? true;
    const timeoutMs = options.spawnTimeoutMs ?? 4000;

    let authToken = options.authToken || '';
    if (!authToken && fs.existsSync(authPath)) {
      try {
        authToken = safeReadAuthToken(authPath);
      } catch (err) {
        throw err;
      }
    }

    const client = new PtyHostClient(socketPath, authPath, authToken);

    try {
      const snap = await client._connect();
      client._snapshot = snap;
      return client;
    } catch (err) {
      if (!autoSpawn) throw err;

      // Intentar lanzar el supervisor en segundo plano
      await client._spawnDaemon(options.supervisorScriptPath);

      // Reintentar conexion con backoff hasta timeout
      const startTime = Date.now();
      let lastErr = err;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));

        // Re-leer token si no lo teniamos
        if (!options.authToken && fs.existsSync(authPath)) {
          try {
            client.authToken = safeReadAuthToken(authPath);
          } catch (err) {
            throw err;
          }
        }

        try {
          const snap = await client._connect();
          client._snapshot = snap;
          return client;
        } catch (e) {
          lastErr = e;
        }
      }

      throw new Error(`Failed to connect to maw-ptyd within ${timeoutMs}ms: ${(lastErr as Error).message}`);
    }
  }

  private async _spawnDaemon(scriptPath?: string): Promise<void> {
    const targetScript = scriptPath ||
      process.env.MAW_PTYD_SCRIPT ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'maw-ptyd.mjs');

    const child = spawn(process.execPath, [
      targetScript,
      '--socket', this.socketPath,
      '--auth-file', this.authPath,
    ], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        MAW_PTYD_SOCKET: this.socketPath,
        MAW_PTYD_AUTH_FILE: this.authPath,
      },
    });

    child.unref();
  }

  private async _connect(): Promise<PtySnapshotResponse> {
    if (!this.authToken && fs.existsSync(this.authPath)) {
      this.authToken = safeReadAuthToken(this.authPath);
    }

    return new Promise<PtySnapshotResponse>((resolve, reject) => {
      this.lineBuffer = '';
      this.decoder = new StringDecoder('utf8');
      const sock = net.connect(this.socketPath);
      let handshook = false;

      const connectTimer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Connection timeout connecting to ${this.socketPath}`));
      }, 2000);

      sock.once('connect', () => {
        clearTimeout(connectTimer);
        this.socket = sock;

        // Enviar handshake hello
        const reqId = randomUUID();
        const helloReq: PtyClientRequest = {
          op: 'hello',
          reqId,
          version: PTY_PROTOCOL_VERSION,
          authToken: this.authToken,
          subscribe: true,
        };

        this._registerPending(reqId, (res) => {
          handshook = true;
          resolve(res as PtySnapshotResponse);
        }, reject, 3000);

        try {
          this._rawSend(helloReq);
        } catch (err) {
          this._clearPending(reqId);
          reject(err as Error);
        }
      });

      sock.on('data', (chunk) => this._onData(chunk));

      sock.on('close', () => {
        clearTimeout(connectTimer);
        if (this.socket !== sock) return;
        this.socket = null;
        this._rejectAllPending(new Error('Connection closed by supervisor'));

        for (const listener of this.disconnectListeners) {
          try { listener(); } catch {}
        }
      });

      sock.once('error', (err) => {
        clearTimeout(connectTimer);
        if (!handshook) {
          reject(err);
        }
      });
    });
  }

  private _clearPending(reqId: string): void {
    const pending = this.pendingRequests.get(reqId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(reqId);
    }
    this.replayChunks.delete(reqId);
  }

  private _rejectAllPending(error: Error): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pendingRequests.clear();
    this.replayChunks.clear();
  }

  private _handleOversizeFrame(): void {
    this.lineBuffer = '';
    this._rejectAllPending(new Error('Received message exceeding maximum protocol line size'));
    this.socket?.destroy();
  }

  private _onData(chunk: Buffer): void {
    this.lineBuffer += this.decoder.write(chunk);

    let newlineIndex: number;
    while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
      if (newlineIndex > MAX_PAYLOAD_SIZE) {
        this._handleOversizeFrame();
        return;
      }

      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (line.length === 0) continue;

      let msg: PtyServerMessage;
      try {
        msg = JSON.parse(line) as PtyServerMessage;
      } catch {
        continue;
      }

      this._handleServerMessage(msg);
    }

    if (this.lineBuffer.length > MAX_PAYLOAD_SIZE) {
      this._handleOversizeFrame();
      return;
    }
  }

  private _handleServerMessage(msg: PtyServerMessage): void {
    if ('reqId' in msg && msg.reqId && this.pendingRequests.has(msg.reqId)) {
      if (msg.op === 'replay_chunk') {
        let acc = this.replayChunks.get(msg.reqId);
        if (!acc) {
          acc = { dataParts: [], screenParts: [] };
          this.replayChunks.set(msg.reqId, acc);
        }
        if (typeof msg.dataB64 === 'string' && msg.dataB64.length > 0) {
          acc.dataParts.push(Buffer.from(msg.dataB64, 'base64'));
        }
        if (typeof msg.screenDataB64 === 'string' && msg.screenDataB64.length > 0) {
          acc.screenParts.push(Buffer.from(msg.screenDataB64, 'base64'));
        }
        return;
      }

      const pending = this.pendingRequests.get(msg.reqId)!;
      this.pendingRequests.delete(msg.reqId);
      clearTimeout(pending.timer);
      const chunks = this.replayChunks.get(msg.reqId);
      this.replayChunks.delete(msg.reqId);

      if (msg.op === 'error') {
        pending.reject(new PtyHostRequestError(msg.code, msg.message));
      } else if (msg.op === 'replay_data' && chunks) {
        const dataParts = msg.dataB64
          ? [...chunks.dataParts, Buffer.from(msg.dataB64, 'base64')]
          : chunks.dataParts;
        const assembledDataB64 = dataParts.length > 0 ? Buffer.concat(dataParts).toString('base64') : '';
        let assembledScreen = msg.screen;
        if (msg.screen && chunks.screenParts.length > 0) {
          const screenData = Buffer.concat(chunks.screenParts).toString('utf8') + msg.screen.data;
          assembledScreen = { ...msg.screen, data: screenData };
        }
        pending.resolve({
          ...msg,
          dataB64: assembledDataB64,
          ...(assembledScreen ? { screen: assembledScreen } : {}),
        });
      } else {
        pending.resolve(msg);
      }
      return;
    }

    if (msg.op === 'data') {
      const chunk = Buffer.from(msg.dataB64, 'base64').toString('utf8');
      for (const listener of this.dataListeners) {
        try { listener(msg.id, chunk, msg.offset); } catch {}
      }
    } else if (msg.op === 'exit') {
      for (const listener of this.exitListeners) {
        try { listener(msg); } catch {}
      }
    }
  }

  private _registerPending(
    reqId: string,
    resolve: (val: any) => void,
    reject: (err: Error) => void,
    timeoutMs = 10_000
  ): void {
    const timer = setTimeout(() => {
      if (this.pendingRequests.has(reqId)) {
        this.pendingRequests.delete(reqId);
        this.replayChunks.delete(reqId);
        reject(new Error(`Request ${reqId} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    this.pendingRequests.set(reqId, { resolve, reject, timer });
  }

  private _rawSend(msg: PtyClientRequest): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Cannot send message: socket is not connected');
    }
    this.socket.write(JSON.stringify(msg) + '\n');
  }

  private async _request<T>(msg: PtyClientRequest, timeoutMs = 10_000): Promise<T> {
    const reqId = msg.reqId || randomUUID();
    const withReqId = { ...msg, reqId };

    return new Promise<T>((resolve, reject) => {
      this._registerPending(reqId, resolve, reject, timeoutMs);
      try {
        this._rawSend(withReqId);
      } catch (err) {
        this._clearPending(reqId);
        reject(err as Error);
      }
    });
  }

  async spawn(params: {
    id: string;
    sessionId?: string;
    agencyManaged?: boolean;
    cmd: string;
    args?: readonly string[];
    cwd: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  }): Promise<PtySpawnedResponse> {
    return this._request<PtySpawnedResponse>({
      op: 'spawn',
      reqId: randomUUID(),
      id: params.id,
      sessionId: params.sessionId,
      ...(params.agencyManaged !== undefined ? { agencyManaged: params.agencyManaged } : {}),
      cmd: params.cmd,
      args: params.args || [],
      cwd: params.cwd,
      env: params.env || {},
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    });
  }

  write(id: string, data: string | Buffer): void {
    const dataB64 = Buffer.isBuffer(data)
      ? data.toString('base64')
      : Buffer.from(data, 'utf8').toString('base64');

    this._rawSend({
      op: 'write',
      id,
      dataB64,
    });
  }

  resize(id: string, cols: number, rows: number): void {
    this._rawSend({
      op: 'resize',
      id,
      cols,
      rows,
    });
  }

  async replay(id: string, sinceOffset?: number): Promise<{
    reset: boolean;
    startOffset: number;
    endOffset: number;
    sinceOffset?: number;
    data: string;
    truncated: boolean;
    screen?: { data: string; cols: number; rows: number };
  }> {
    const res = await this._request<PtyReplayDataResponse>({
      op: 'replay',
      reqId: randomUUID(),
      id,
      sinceOffset,
    });

    return {
      reset: res.reset,
      startOffset: res.startOffset,
      endOffset: res.endOffset,
      sinceOffset: res.sinceOffset,
      data: Buffer.from(res.dataB64, 'base64').toString('utf8'),
      truncated: res.truncated,
      screen: res.screen,
    };
  }

  async kill(id: string, signal = 'SIGTERM'): Promise<PtyKilledResponse> {
    return this._request<PtyKilledResponse>({
      op: 'kill',
      reqId: randomUUID(),
      id,
      signal,
    });
  }

  reapTombstone(id: string): void {
    this._rawSend({
      op: 'reap_tombstone',
      id,
    });
  }

  async list(): Promise<{ sessions: readonly PtyHostSessionInfo[]; tombstones: readonly PtyHostTombstoneInfo[] }> {
    const res = await this._request<{ sessions: readonly PtyHostSessionInfo[]; tombstones: readonly PtyHostTombstoneInfo[] }>({
      op: 'list',
      reqId: randomUUID(),
    });
    return {
      sessions: res.sessions,
      tombstones: res.tombstones,
    };
  }

  /**
   * Cierra la conexion del cliente con maw-ptyd SIN matar ninguna sesion PTY hija.
   */
  detach(): void {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.socket && !this.socket.destroyed) {
        this._rawSend({ op: 'detach' });
        this.socket.end();
      }
    } catch {}
  }

  /**
   * Ordena al demonio terminar y opcionalmente matar todas las sesiones hijas.
   */
  async shutdown(killAll = false): Promise<void> {
    if (this.closed) return;
    try {
      await this._request({ op: 'shutdown', reqId: randomUUID(), killAll });
    } finally {
      this.detach();
    }
  }

  onData(listener: PtyDataCallback): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: PtyExitCallback): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onDisconnect(listener: PtyDisconnectCallback): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async reconnect(): Promise<PtySnapshotResponse> {
    if (this.closed) throw new Error('Supervisor client is detached');
    if (this.reconnecting) throw new Error('Supervisor reconnect is already in progress');
    this.reconnecting = true;
    try {
      this.authToken = safeReadAuthToken(this.authPath);
      if (!this.authToken) throw new Error('Supervisor auth file is unavailable during reconnect');
      const snapshot = await this._connect();
      this._snapshot = snapshot;
      return snapshot;
    } finally {
      this.reconnecting = false;
    }
  }

  get supervisorPid(): number | null {
    return this._snapshot?.pid ?? null;
  }
}
