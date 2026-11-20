/**
 * A pty that lives in the persistent PTY supervisor (`pty-host`), seen from
 * the backend. The supervisor owns the process; this proxy only forwards input,
 * resizes and termination, and stops forwarding once it has been disposed.
 */

import type { PtyHostClient } from '../../pty-host/pty-host-client.js';

export interface IPtySession {
  readonly pid: number;
  readonly cwd: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export class RemotePtySession implements IPtySession {
  private disposed = false;

  constructor(
    private readonly client: PtyHostClient,
    readonly id: string,
    readonly pid: number,
    readonly cwd: string,
  ) {}

  write(data: string): void {
    if (this.disposed) return;
    this.client.write(this.id, data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.client.resize(this.id, cols, rows);
  }

  async terminate(signal = 'SIGTERM'): Promise<boolean> {
    try {
      await this.client.kill(this.id, signal);
      this.disposed = true;
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('[SESSION_NOT_FOUND]')) {
        this.disposed = true;
        return true;
      }
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    void this.terminate('SIGTERM');
  }
}
