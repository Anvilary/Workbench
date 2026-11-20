import { TerminalState, type TerminalCheckpoint } from '../../pty-host/terminal-state.mjs';

/**
 * Buffer circular de la salida reciente de una terminal con soporte para
 * offsets monotonicos y replay incremental acotado (Hito A4 / Lane A & B).
 *
 * Existe porque las pty sobreviven a la caida del WebSocket (CLAUDE.md 3.0):
 * cuando el navegador recarga y se vuelve a enganchar, hay que repintarle la
 * pantalla. Sin esto, reconectarse a una sesion viva muestra un terminal negro
 * hasta que el usuario aprieta una tecla.
 *
 * Ademas, el seguimiento de byte offsets monotonicos permite reconexiones
 * sin parpadeo (zero-flicker) reenviando unicamente los bytes emitidos mientras
 * el cliente o backend estuvieron desconectados.
 *
 * Guarda bytes, no lineas: lo que llega son secuencias ANSI y cortarlas por
 * lineas no significa nada.
 */

/** Suficiente para varias pantallas de una TUI, sin que 10 pestanas pesen. */
const DEFAULT_LIMIT_BYTES = 256 * 1024;

/** Keep a Unicode-safe suffix whose UTF-8 bytes fit into the remaining budget. */
function suffixWithinBytes(value: string, budget: number): string {
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

export interface OutputSlice {
  /**
   * Indica si el cliente debe reiniciar su estado de terminal antes de renderizar.
   * Es true cuando no se indico sinceOffset (primera conexion), cuando sinceOffset
   * cayo en el tramo ya sobreescrito del ring buffer, o cuando el offset pedido
   * excede endOffset.
   */
  readonly reset: boolean;
  /** Offset monotonico mas antiguo aun retenido en memoria. */
  readonly startOffset: number;
  /** Offset monotonico actual tras el ultimo byte recibido. */
  readonly endOffset: number;
  /** El offset solicitado por el cliente (si se envio). */
  readonly sinceOffset?: number;
  /** Datos UTF-8 correspondientes a la rodaja solicitada o al snapshot completo. */
  readonly data: string;
  /** Indica si se descartaron bytes historicos por desborde del buffer circular. */
  readonly truncated: boolean;
}

export class OutputBuffer {
  private state = new TerminalState();
  private chunks: string[] = [];
  private chunkSizes: number[] = [];
  private head = 0;
  private sizeBytes = 0;
  private totalBytesPushed = 0;
  private truncated = false;
  private inAlternateScreen = false;

  private readonly limitBytes: number;

  constructor(limitBytes: number = DEFAULT_LIMIT_BYTES) {
    this.limitBytes = limitBytes;
  }

  /** Offset monotonico del byte mas antiguo actualmente en el buffer. */
  get startOffset(): number {
    return Math.max(0, this.totalBytesPushed - this.sizeBytes);
  }

  /** Offset monotonico acumulado (total de bytes pasados por push). */
  get endOffset(): number {
    return this.totalBytesPushed;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
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
      const oldest = this.chunks[this.head]!;
      const size = this.chunkSizes[this.head]!;
      const remainingWithoutOldest = this.sizeBytes - size;
      if (remainingWithoutOldest >= this.limitBytes) {
        this.chunks[this.head] = '';
        this.head++;
        this.sizeBytes -= size;
      } else {
        const suffix = suffixWithinBytes(oldest, this.limitBytes - remainingWithoutOldest);
        if (suffix.length === 0) {
          this.chunks[this.head] = '';
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

    if (this.head > 4096 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.chunkSizes = this.chunkSizes.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Todo lo que tenemos actualmente en el buffer, concatenado.
   *
   * Puede empezar a mitad de una secuencia ANSI si el buffer se desbordo.
   * Si el buffer desbordo mientras corria una app en pantalla alterna (TUI) y la
   * secuencia de entrada a pantalla alterna cayo en el tramo descartado, se
   * reinyecta para que xterm pinte en el buffer alterno y no sobre el normal.
   */
  read(): string {
    const activeChunks = this.head === 0 ? this.chunks : this.chunks.slice(this.head);
    const raw = activeChunks.join('');
    if (this.truncated && this.inAlternateScreen && !raw.includes('\x1b[?1049h') && !raw.includes('\x1b[?47h')) {
      return '\x1b[?1049h' + raw;
    }
    return raw;
  }

  /** Alias de read() para alineacion con la especificacion del supervisor. */
  snapshot(): string {
    return this.read();
  }

  /**
   * Extrae la rodaja de salida desde `sinceOffset` hasta `endOffset`.
   *
   * Garantiza semanticas seguras:
   * - Si sinceOffset no esta definido -> snapshot completo con reset = true.
   * - Si sinceOffset < startOffset -> el cliente perdio bytes ya expulsados del ring;
   *   retorna el snapshot retenido con reset = true (lossless replay imposible).
   * - Si sinceOffset > endOffset -> offset invalido en el futuro; retorna snapshot completo con reset = true.
   * - Si sinceOffset === endOffset -> el cliente no se perdio ningun byte; retorna '' con reset = false.
   * - Si startOffset <= sinceOffset < endOffset -> retorna exactamente el sufijo de bytes missed con reset = false.
   */
  sliceFrom(sinceOffset?: number): OutputSlice {
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
    const resultParts: string[] = [];

    for (let i = this.head; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      const chunkBytes = this.chunkSizes[i]!;
      const chunkEnd = skipped + chunkBytes;

      if (chunkEnd <= bytesToSkip) {
        skipped = chunkEnd;
        continue;
      }

      if (skipped < bytesToSkip) {
        const offsetWithinChunk = bytesToSkip - skipped;
        const buf = Buffer.from(chunk, 'utf8');
        if ((buf[offsetWithinChunk]! & 0xc0) === 0x80) {
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

  /** true si se perdio salida vieja por desborde. */
  isTruncated(): boolean {
    return this.truncated;
  }

  resize(cols: number, rows: number): void {
    this.state.resize(cols, rows);
  }

  /** A rendering checkpoint and its raw byte watermark captured in one FIFO turn. */
  async checkpoint(signal?: AbortSignal): Promise<TerminalCheckpoint & { endOffset: number }> {
    const endOffset = this.endOffset;
    const snapshot = await this.state.snapshot(signal);
    return { ...snapshot, endOffset };
  }

  dispose(): void { this.state.dispose(); }

  clear(): void {
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

  seed(data: string, startOffset: number, endOffset: number, truncated: boolean, checkpoint?: TerminalCheckpoint): void {
    this.state.dispose();
    this.state = new TerminalState(checkpoint?.cols, checkpoint?.rows);
    this.state.push(checkpoint?.data ?? data);
    // Older hosts prefix alternate-screen entry without counting it in offsets.
    // Keep generated bytes out of the raw offset-addressed ring.
    const rawBytes = Buffer.from(data, 'utf8');
    if (rawBytes.length > endOffset - startOffset) {
      data = rawBytes.subarray(rawBytes.length - (endOffset - startOffset)).toString('utf8');
    }
    this.chunks = data.length > 0 ? [data] : [];
    const byteLen = Buffer.byteLength(data, 'utf8');
    this.chunkSizes = data.length > 0 ? [byteLen] : [];
    this.head = 0;
    this.sizeBytes = byteLen;
    this.totalBytesPushed = endOffset;
    this.truncated = truncated;
    if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
      this.inAlternateScreen = true;
    }
    if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
      this.inAlternateScreen = false;
    }
  }
}
