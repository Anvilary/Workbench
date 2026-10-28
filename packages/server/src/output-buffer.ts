/**
 * Buffer circular de la salida reciente de una terminal.
 *
 * Existe porque las pty sobreviven a la caida del WebSocket (CLAUDE.md 3.0):
 * cuando el navegador recarga y se vuelve a enganchar, hay que repintarle la
 * pantalla. Sin esto, reconectarse a una sesion viva muestra un terminal negro
 * hasta que el usuario aprieta una tecla.
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

export class OutputBuffer {
  private chunks: string[] = [];
  private sizeBytes = 0;
  private truncated = false;

  constructor(private readonly limitBytes: number = DEFAULT_LIMIT_BYTES) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.sizeBytes += Buffer.byteLength(chunk, 'utf8');

    while (this.sizeBytes > this.limitBytes && this.chunks.length > 0) {
      const oldest = this.chunks[0]!;
      const size = Buffer.byteLength(oldest, 'utf8');
      const remainingWithoutOldest = this.sizeBytes - size;
      if (remainingWithoutOldest >= this.limitBytes) {
        this.chunks.shift();
        this.sizeBytes -= size;
      } else {
        const suffix = suffixWithinBytes(oldest, this.limitBytes - remainingWithoutOldest);
        if (suffix.length === 0) this.chunks.shift();
        else this.chunks[0] = suffix;
        this.sizeBytes -= size - Buffer.byteLength(suffix, 'utf8');
      }
      this.truncated = true;
    }
  }

  /**
   * Todo lo que tenemos, concatenado.
   *
   * Puede empezar a mitad de una secuencia ANSI si el buffer se desbordo. No se
   * intenta reparar: la CLI redibuja la pantalla en cuanto llega cualquier
   * evento, y adivinar donde cortar una secuencia haria mas dano que bien.
   */
  read(): string {
    return this.chunks.join('');
  }

  /** true si se perdio salida vieja por desborde. */
  isTruncated(): boolean {
    return this.truncated;
  }

  clear(): void {
    this.chunks = [];
    this.sizeBytes = 0;
    this.truncated = false;
  }
}
