/**
 * Tipos y contratos para la comunicacion IPC con el supervisor de PTYs (maw-ptyd).
 *
 * Lane A & B - Protocolo Version 1 (Frozen Contract)
 */

export const PTY_PROTOCOL_VERSION = 1;
export const DEFAULT_SOCKET_NAME = 'ptyd.sock';
export const DEFAULT_AUTH_FILE_NAME = 'ptyd.auth';
export const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB max por mensaje NDJSON
export const MAX_SESSIONS = 24;
export const TOMBSTONE_TTL_MS = 10 * 60 * 1000; // 10 minutos
export const CLIENT_WRITE_BUFFER_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB max backpressure

export type PtyHostErrorCode =
  | 'UNAUTHORIZED'
  | 'VERSION_MISMATCH'
  | 'INVALID_PARAMS'
  | 'QUOTA_EXCEEDED'
  | 'SESSION_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'INTERNAL_ERROR'
  | 'BACKPRESSURE_OVERFLOW';

export interface PtyHostSessionInfo {
  readonly id: string;
  readonly sessionId?: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly createdAt: string;
}

export interface PtyHostTombstoneInfo {
  readonly id: string;
  readonly sessionId?: string;
  readonly pid: number;
  readonly exitCode: number;
  readonly signal: number | null;
  readonly exitedAt: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

// -------------------------------------------------------------
// Mensajes Cliente -> Supervisor
// -------------------------------------------------------------

export interface PtyHelloRequest {
  readonly op: 'hello';
  readonly reqId: string;
  readonly version: number;
  readonly authToken: string;
  readonly subscribe?: boolean;
}

export interface PtySpawnRequest {
  readonly op: 'spawn';
  readonly reqId: string;
  readonly id: string;
  readonly sessionId?: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyWriteRequest {
  readonly op: 'write';
  readonly reqId?: string;
  readonly id: string;
  readonly dataB64?: string;
  readonly data?: string;
}

export interface PtyResizeRequest {
  readonly op: 'resize';
  readonly reqId?: string;
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyReplayRequest {
  readonly op: 'replay';
  readonly reqId: string;
  readonly id: string;
  readonly sinceOffset?: number;
}

export interface PtyKillRequest {
  readonly op: 'kill';
  readonly reqId: string;
  readonly id: string;
  readonly signal?: string;
}

export interface PtyReapTombstoneRequest {
  readonly op: 'reap_tombstone';
  readonly reqId?: string;
  readonly id: string;
}

export interface PtyListRequest {
  readonly op: 'list';
  readonly reqId: string;
}

export interface PtyAttachRequest {
  readonly op: 'attach';
  readonly reqId?: string;
  readonly id: string;
  readonly sinceOffset?: number;
}

export interface PtyDetachRequest {
  readonly op: 'detach';
  readonly reqId?: string;
  readonly id?: string;
}

export interface PtyShutdownRequest {
  readonly op: 'shutdown';
  readonly reqId: string;
  readonly killAll: boolean;
}

export type PtyClientRequest =
  | PtyHelloRequest
  | PtySpawnRequest
  | PtyWriteRequest
  | PtyResizeRequest
  | PtyReplayRequest
  | PtyKillRequest
  | PtyReapTombstoneRequest
  | PtyListRequest
  | PtyAttachRequest
  | PtyDetachRequest
  | PtyShutdownRequest;

// -------------------------------------------------------------
// Mensajes Supervisor -> Cliente
// -------------------------------------------------------------

export interface PtySnapshotResponse {
  readonly op: 'snapshot';
  readonly reqId: string;
  readonly version: number;
  readonly pid: number;
  readonly sessions: readonly PtyHostSessionInfo[];
  readonly tombstones: readonly PtyHostTombstoneInfo[];
}

export interface PtySpawnedResponse {
  readonly op: 'spawned';
  readonly reqId: string;
  readonly id: string;
  readonly pid: number;
}

export interface PtyReplayDataResponse {
  readonly op: 'replay_data';
  readonly reqId: string;
  readonly id: string;
  readonly reset: boolean;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sinceOffset?: number;
  readonly dataB64: string;
  readonly truncated: boolean;
}

export interface PtyKilledResponse {
  readonly op: 'killed';
  readonly reqId: string;
  readonly id: string;
}

export interface PtyAckResponse {
  readonly op: 'ack';
  readonly reqId: string;
  readonly id?: string;
}

export interface PtySessionListResponse {
  readonly op: 'session_list';
  readonly reqId: string;
  readonly sessions: readonly PtyHostSessionInfo[];
  readonly tombstones: readonly PtyHostTombstoneInfo[];
}

export interface PtyErrorResponse {
  readonly op: 'error';
  readonly reqId?: string;
  readonly code: PtyHostErrorCode;
  readonly message: string;
}

// Eventos broadcast
export interface PtyDataEvent {
  readonly op: 'data';
  readonly id: string;
  readonly offset: number;
  readonly dataB64: string;
}

export interface PtyExitEvent {
  readonly op: 'exit';
  readonly id: string;
  readonly sessionId?: string;
  readonly pid: number;
  readonly exitCode: number;
  readonly signal: number | null;
  readonly exitedAt: string;
  readonly finalOffset: number;
}

export type PtyServerMessage =
  | PtySnapshotResponse
  | PtySpawnedResponse
  | PtyReplayDataResponse
  | PtyKilledResponse
  | PtyAckResponse
  | PtySessionListResponse
  | PtyErrorResponse
  | PtyDataEvent
  | PtyExitEvent;
