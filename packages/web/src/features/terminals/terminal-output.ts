import type { Terminal } from '@xterm/xterm';
import type { ServerTerminalReplayMessage } from '@agent-workbench/shared';

/** One ordered render lane per xterm. reset() is synchronous; write() is not. */
export class TerminalOutput {
  private readonly queue: { data: string; replay?: ServerTerminalReplayMessage }[] = [];
  private writing = false;
  private disposed = false;
  offset: number | undefined;

  constructor(private readonly terminal: Terminal,
    private readonly restoring: (active: boolean) => void = () => {}) {}

  output(data: string, offset?: number): void {
    if (this.disposed) return;
    if (offset !== undefined && this.offset !== undefined) {
      if (offset <= this.offset) return;
      const bytes = new TextEncoder().encode(data);
      const overlap = this.offset - (offset - bytes.length);
      if (overlap > 0) data = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(overlap));
    }
    if (offset !== undefined) this.offset = offset;
    this.enqueue({ data });
  }

  replay(message: ServerTerminalReplayMessage): void {
    if (this.disposed) return;
    if (!(message.reset ?? true)) {
      this.output(message.data, message.endOffset ?? message.offset);
      return;
    }
    this.offset = message.endOffset ?? message.offset;
    this.enqueue({ data: message.data, replay: message });
  }

  private enqueue(item: { data: string; replay?: ServerTerminalReplayMessage }): void {
    this.queue.push(item);
    this.drain();
  }

  private drain(): void {
    if (this.writing || this.disposed) return;
    const item = this.queue.shift();
    if (!item) return;
    this.writing = true;
    const finish = (): void => {
      if (this.disposed) return;
      this.writing = false;
      this.drain();
    };
    if (!item.replay) {
      this.terminal.write(item.data, finish);
      return;
    }
    // Wait for prior xterm writes before changing its parser/buffers. Subsequent
    // output stays in this lane until the entire checkpoint has been parsed.
    // CAN abandons any partial CSI/OSC/DCS. xterm 5.5 reset() alone does
    // not reset its escape parser, so the first checkpoint byte can be eaten.
    this.terminal.write('\x18', () => {
      if (this.disposed) return;
      const { cols, rows } = this.terminal;
      const replay = item.replay!;
      const preserveScrollback = Boolean(replay.truncated) && this.terminal.buffer.normal.baseY > 0;
      this.restoring(true);
      if (preserveScrollback) {
        // Soft-reset modes/parser and exit alternate screen without wiping 42k-line scrollback.
        this.terminal.write('\x1b[!p\x1b[?1049l\r\n');
      } else {
        this.terminal.reset();
      }
      if (replay.cols && replay.rows) this.terminal.resize(replay.cols, replay.rows);
      this.terminal.write(item.data, () => {
        if (this.disposed) return;
        if (this.terminal.cols !== cols || this.terminal.rows !== rows) this.terminal.resize(cols, rows);
        this.restoring(false);
        finish();
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }
}
