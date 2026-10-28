import { open } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { asRecord } from '@agent-workbench/shared';
import { withinNativeScope } from '../native-scope.js';
import { findRollout } from './find-rollout.js';

export interface CodexNativeTurn {
  taskId: string;
  phase: 'working' | 'finished' | 'failed' | 'unknown';
}

/**
 * Read only explicit lifecycle events in this launch's attested rollout. This is
 * independent of conversation subscribers and never infers completion from text.
 * Native schema: openai/codex codex-rs/protocol/src/protocol.rs,
 * TurnStartedEvent / TurnCompleteEvent (task_* names have turn_* aliases).
 */
export class CodexTurnWatcher {
  private file: string | null = null;
  private fileIdentity: string | null = null;
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private metadataVerified = false;
  private droppingLine = false;
  private readonly active = new Set<string>();
  private readonly completed = new Set<string>();
  private evidenceLost = false;
  private disposed = false;
  private polling: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly input: {
    home: string;
    cwd: string;
    sessionId: string;
    launchedAt: number;
    onTurn: (turn: CodexNativeTurn) => void;
  }) {}

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => { void this.poll(); }, 300);
    this.timer.unref();
    void this.poll();
  }

  poll(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.read().catch(() => {
      this.loseEvidence();
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  private async read(): Promise<void> {
    const file = await findRollout(this.input.sessionId, {
      sessionsRoot: path.join(this.input.home, 'sessions'),
      archivedRoot: null,
    });
    if (this.disposed) return;
    if (!file || !await withinNativeScope(this.input.home, file)) { this.loseEvidence(); return; }
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) { this.loseEvidence(); return; }
      const identity = `${info.dev}:${info.ino}`;
      if (file !== this.file || identity !== this.fileIdentity || info.size < this.offset) {
        this.loseEvidence();
        this.file = file;
        this.fileIdentity = identity;
        this.offset = 0;
        this.partial = '';
        this.decoder = new StringDecoder('utf8');
        this.metadataVerified = false;
        this.droppingLine = false;
        this.active.clear();
      }
      const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, info.size - this.offset)));
      if (buffer.length === 0) return;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      const text = this.decoder.write(buffer.subarray(0, bytesRead));
      for (const piece of text.split(/(?<=\n)/)) {
        if (this.disposed) return;
        if (!this.droppingLine) this.partial += piece;
        if (this.partial.length > 256 * 1024) { this.partial = ''; this.droppingLine = true; }
        if (piece.endsWith('\n')) {
          if (!this.droppingLine) this.consume(this.partial);
          this.partial = '';
          this.droppingLine = false;
        }
      }
    } finally { await handle.close(); }
  }

  private consume(line: string): void {
    let row: Record<string, unknown> | null;
    try { row = asRecord(JSON.parse(line)); } catch { return; }
    if (!row) return;
    const payload = asRecord(row['payload']);
    if (!payload) return;
    if (row['type'] === 'session_meta') {
      this.metadataVerified = payload['id'] === this.input.sessionId &&
        typeof payload['cwd'] === 'string' && path.resolve(payload['cwd']) === this.input.cwd;
      return;
    }
    if (!this.metadataVerified || row['type'] !== 'event_msg') return;
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : NaN;
    if (!Number.isFinite(at) || at < this.input.launchedAt) return;
    const turnId = payload['turn_id'];
    if (typeof turnId !== 'string' || !turnId || turnId.length > 512 || this.completed.has(turnId)) return;
    const taskId = `${this.input.sessionId}:${turnId}`;
    if (payload['type'] === 'task_started' || payload['type'] === 'turn_started') {
      if (this.active.has(turnId)) return;
      this.evidenceLost = false;
      this.active.add(turnId);
      this.input.onTurn({ taskId, phase: 'working' });
    } else if (this.active.has(turnId) && ['task_complete', 'turn_complete', 'turn_aborted'].includes(String(payload['type']))) {
      this.active.delete(turnId);
      this.completed.add(turnId);
      // turn_complete can carry a terminal error. Aborts never mean success.
      const phase = payload['type'] === 'turn_aborted' ? 'unknown' : payload['error'] ? 'failed' : 'finished';
      this.input.onTurn({ taskId, phase });
    }
  }

  private loseEvidence(): void {
    if (this.disposed || this.evidenceLost) return;
    this.evidenceLost = true;
    for (const turnId of this.active) this.input.onTurn({ taskId: `${this.input.sessionId}:${turnId}`, phase: 'unknown' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
    this.completed.clear();
  }
}
