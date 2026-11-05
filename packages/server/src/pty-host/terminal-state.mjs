// A per-PTY rendering checkpoint. Raw offsets belong to OutputBuffer, never to
// these generated VT bytes. Keep this module runnable by the standalone host.
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const C1_TO_ESC = { '\x9b': '\x1b[', '\x9d': '\x1b]', '\x90': '\x1bP', '\x98': '\x1bX', '\x9e': '\x1b^', '\x9f': '\x1b_' };

// Track only an unfinished VT sequence, so a checkpoint can resume the parser
// when a PTY read ends inside CSI, OSC, DCS, or an ESC sequence. xterm remains
// the interpreter. This scanner never transforms the live output stream.
class Continuation {
  state = 'ground';
  pending = '';
  feed(data) {
    for (const ch of data) {
      const n = ch.codePointAt(0);
      if (n === 0x9c) { this.state = 'ground'; this.pending = ''; continue; }
      const c1 = C1_TO_ESC[ch];
      if (c1) {
        this.pending = c1;
        this.state = n === 0x9b ? 'csi' : 'string';
        continue;
      }
      if (ch === '\x18' || ch === '\x1a') { this.state = 'ground'; this.pending = ''; continue; }
      if (this.state === 'string') {
        this.pending += ch;
        if (ch === '\x07' && this.pending.startsWith('\x1b]')) this.state = 'ground';
        else if (ch === '\x1b') this.state = 'stringEscape';
      } else if (this.state === 'stringEscape') {
        if (ch === '\\') { this.pending += ch; this.state = 'ground'; }
        else {
          // ESC followed by a non-ST command abandons the control string.
          this.pending = '\x1b' + ch;
          if (ch === '[') this.state = 'csi';
          else if (']PX^_'.includes(ch)) this.state = 'string';
          else if (ch === '\x1b') { this.pending = ch; this.state = 'escape'; }
          else this.state = n >= 0x30 && n <= 0x7e ? 'ground' : 'escape';
        }
      } else if (ch === '\x1b') {
        this.pending = ch;
        this.state = 'escape';
      } else if (this.state === 'escape') {
        this.pending += ch;
        if (ch === '[') this.state = 'csi';
        else if (']PX^_'.includes(ch)) this.state = 'string';
        else if (n >= 0x30 && n <= 0x7e) this.state = 'ground';
      } else if (this.state === 'csi') {
        this.pending += ch;
        if (n >= 0x40 && n <= 0x7e) this.state = 'ground';
      }
      if (this.state === 'ground') this.pending = '';
      // xterm caps control-string payloads too. Preserve the string parser state
      // without retaining an unbounded title/image payload in a checkpoint.
      if (this.pending.length > 65536 && this.state === 'string') this.pending = this.pending.slice(0, 2);
    }
  }
}

export class TerminalState {
  constructor(cols = 80, rows = 24) {
    this.term = new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    this.serializer = new serialize.SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.continuation = new Continuation();
    this.waiters = new Set();
    this.disposed = false;
    this.margins = { normal: null, alternate: null };
    this.cursorVisible = true;
    this.savedNormal = null;
    this.term.parser.registerCsiHandler({ final: 'r' }, (params) => {
      const top = Number(params[0]) || 1;
      const requested = Number(params[1]);
      const bottom = !requested || requested > this.term.rows ? this.term.rows : requested;
      if (bottom > top) this.margins[this.term.buffer.active.type] = [top, bottom];
      return false;
    });
    for (const final of ['h', 'l']) this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.includes(25)) this.cursorVisible = final === 'h';
      if (params.some((p) => [47, 1047, 1049].includes(p))) {
        if (final === 'h' && this.term.buffer.active.type === 'normal') {
          // xterm 5.5's serializer uses the *active* SGR for both buffers.
          // Capture the saved normal cursor attributes before entering a TUI.
          this.savedNormal = { data: this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }) + this.controlSuffix(false),
            cols: this.term.cols, rows: this.term.rows };
        } else if (final === 'l') { this.savedNormal = null; this.margins.alternate = null; }
      }
      return false;
    });
    this.term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.margins[this.term.buffer.active.type] = null;
      this.cursorVisible = true;
      return false;
    });
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.margins = { normal: null, alternate: null };
      this.cursorVisible = true;
      this.savedNormal = null;
      return false;
    });
  }
  push(data) {
    if (this.disposed) return;
    this.continuation.feed(data);
    this.term.write(data);
  }
  resize(cols, rows) {
    if (this.disposed) return;
    // Like writes, resizes must follow the output that preceded SIGWINCH.
    this.term.write('', () => {
      if (this.disposed) return;
      if (this.term.cols !== cols || this.term.rows !== rows) {
        this.term.resize(cols, rows);
        this.margins = { normal: null, alternate: null };
      }
    });
  }
  snapshot() {
    if (this.disposed) return Promise.reject(new Error('Terminal state disposed'));
    const pending = this.continuation.pending;
    return new Promise((resolve, reject) => {
      this.waiters.add(reject);
      this.term.write('', () => {
        this.waiters.delete(reject);
        if (this.disposed) return;
        try {
          let data = this.serializer.serialize();
          const savedNormal = this.term.buffer.active.type === 'alternate' ? this.savedNormal : null;
          const normalPrefix = savedNormal ? this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }) : '';
          const cols = this.term.cols, rows = this.term.rows;
          data += this.controlSuffix();
          data += pending;
          if (savedNormal && data.startsWith(normalPrefix)) {
            const suffix = data.slice(normalPrefix.length);
            if (savedNormal.cols === cols && savedNormal.rows === rows) {
              resolve({ data: savedNormal.data + suffix, cols, rows });
            } else {
              // Resize the saved normal buffer using the same public xterm API.
              const normal = new TerminalState(savedNormal.cols, savedNormal.rows);
              normal.push(savedNormal.data);
              normal.resize(cols, rows);
              normal.snapshot().then((snapshot) => resolve({ data: snapshot.data + suffix, cols, rows }), reject)
                .finally(() => normal.dispose());
            }
          } else resolve({ data, cols, rows });
        } catch (error) { reject(error); }
      });
    });
  }
  controlSuffix(originOverride) {
    const { cursorX, cursorY, type } = this.term.buffer.active;
    const margins = this.margins[type];
    const origin = originOverride ?? this.term.modes.originMode;
    const top = margins?.[0] ?? 1;
    let data = '';
    if (margins) {
      data += `\x1b[?6l\x1b[${top};${margins[1]}r`;
      if (origin) data += '\x1b[?6h';
    }
    if (margins || origin) data += `\x1b[${cursorY + 1 - (origin ? top - 1 : 0)};${cursorX + 1}H`;
    return data + (this.cursorVisible ? '\x1b[?25h' : '\x1b[?25l');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const reject of this.waiters) reject(new Error('Terminal state disposed'));
    this.waiters.clear();
    this.term.dispose();
  }
}
