import type { TerminalId } from '@agent-workbench/shared';

/**
 * Per-socket backpressure for PTY output (audit N-3).
 *
 * `ws` buffers whatever is sent to a client that is not reading (suspended phone, frozen tab, slow link), so
 * a verbose process could grow the server's memory without bound. Above `high` buffered bytes, output for a
 * terminal is no longer queued; once the socket drains below `low`, `resync` is called with the skipped
 * terminals so the client receives the server's replay buffer (the same state a reconnect gets) instead of
 * an unbounded backlog.
 */
export class OutputBackpressure {
  private readonly lagging = new Set<TerminalId>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly socket: { readonly bufferedAmount: number; readonly readyState: number; readonly OPEN: number },
    private readonly resync: (terminalIds: readonly TerminalId[]) => void,
    private readonly high = 8 * 1024 * 1024,
    private readonly low = 1024 * 1024,
    private readonly intervalMs = 250,
  ) {}

  /** Whether this chunk should be queued on the socket now. */
  shouldSend(terminalId: TerminalId): boolean {
    if (this.lagging.has(terminalId)) return false;
    if (this.socket.bufferedAmount <= this.high) return true;
    this.lagging.add(terminalId);
    this.timer ??= setInterval(() => this.check(), this.intervalMs);
    return false;
  }

  /** The client detached or closed this terminal: never resync it. */
  forget(terminalId: TerminalId): void {
    this.lagging.delete(terminalId);
    if (this.lagging.size === 0) this.dispose();
  }

  isLagging(terminalId: TerminalId): boolean {
    return this.lagging.has(terminalId);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.lagging.clear();
  }

  private check(): void {
    if (this.socket.readyState !== this.socket.OPEN) { this.dispose(); return; }
    if (this.socket.bufferedAmount > this.low) return;
    const terminals = [...this.lagging];
    this.dispose();
    this.resync(terminals);
  }
}
