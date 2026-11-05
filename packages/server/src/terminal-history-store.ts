/**
 * Almacenamiento persistente del historial de salida de terminales (Lane F).
 *
 * Utiliza archivos segmentados append-only con un indice JSON atomico para
 * garantizar lecturas O(1) por paginas sin cargar historiales masivos en memoria.
 *
 * Cada terminal posee su propia subcarpeta: <baseDir>/<terminalId>/
 * Dentro residen los segmentos seg-<N>.bin (texto UTF-8 plano) y el indice index.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomically } from './atomic-write.js';
import { terminalHistoryDir } from './paths.js';

/** Expresion regular estricta para validar que el terminalId sea un UUID valido. */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Umbral de bytes en cola para disparar un flush inmediato (32 KB). */
const FLUSH_BYTE_THRESHOLD = 32 * 1024;

/** Intervalo por defecto para consolidar escrituras (100 ms). */
const DEFAULT_WRITE_INTERVAL_MS = 100;

/** Tamano maximo de lineas por segmento antes de rotar (10.000 lineas). */
const DEFAULT_MAX_SEGMENT_LINES = 10_000;

/** Limite maximo de memoria de la cola pendiente (1 MB). */
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;

/** Estructura del indice persistido en index.json. */
export interface HistoryIndex {
  version: 1;
  terminalId: string;
  totalLines: number;
  prunedLines?: number;
  segments: Array<{
    file: string;      // Nombre base del archivo, ej: "seg-0.bin"
    startLine: number; // Indice 0-based inclusivo de inicio
    endLine: number;   // Indice 0-based exclusivo de fin
    byteOffset: number;// Byte inicial dentro del archivo (0 para archivos nuevos)
    byteLength: number;// Tamano en bytes de los datos escritos
    createdAt?: number;// Timestamp de creacion para retencion por antiguedad
  }>;
}

/** Resultado de una consulta de paginacion. */
export interface HistoryPage {
  page: number;
  pageSize: number;
  totalLines: number;
  totalPages: number;
  lines: string[];  // Lineas de texto reales (secuencias ANSI preservadas)
  hasMore: boolean;
  prunedLines?: number;
  direction?: 'backward' | 'forward';
}

/** Politica configurable de retencion de historial. */
export interface HistoryRetentionPolicy {
  maxDiskBytes?: number;
  maxTotalLines?: number;
  maxAgeMs?: number;
}

/** Resultado de podado de historial. */
export interface PruneResult {
  prunedSegments: number;
  prunedLines: number;
  remainingSegments: number;
  remainingLines: number;
  remainingDiskBytes: number;
}

/** Opciones de configuracion para TerminalHistoryStore. */
export interface TerminalHistoryStoreOptions {
  baseDir?: string;
  maxSegmentLines?: number;
  writeIntervalMs?: number;
  maxQueueBytes?: number;
  retentionPolicy?: HistoryRetentionPolicy;
}

export class TerminalHistoryStore {
  readonly terminalId: string;
  private readonly baseDir: string;
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly maxSegmentLines: number;
  private readonly writeIntervalMs: number;
  private readonly maxQueueBytes: number;
  private readonly retentionPolicy?: HistoryRetentionPolicy;

  private index: HistoryIndex;
  private writeQueue: string[] = [];
  private queueBytes = 0;
  private pendingPartial = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlushPromise: Promise<void> | null = null;
  private pendingFlushRequested = false;
  private disposed = false;

  constructor(terminalId: string, options?: TerminalHistoryStoreOptions) {
    if (!UUID_REGEX.test(terminalId)) {
      throw new Error(`Invalid terminalId: "${terminalId}" is not a valid UUID`);
    }

    this.terminalId = terminalId;
    this.baseDir = options?.baseDir ?? terminalHistoryDir();
    this.dir = path.join(this.baseDir, this.terminalId);
    this.indexPath = path.join(this.dir, 'index.json');
    this.maxSegmentLines = options?.maxSegmentLines ?? DEFAULT_MAX_SEGMENT_LINES;
    this.writeIntervalMs = options?.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    this.maxQueueBytes = options?.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.retentionPolicy = options?.retentionPolicy;

    this.index = this.loadIndexSync();
  }

  /**
   * Carga sincrona del indice al instanciar si ya existe en disco.
   * Permite reabrir tiendas cerradas previamente sin llamadas async iniciales.
   */
  private loadIndexSync(): HistoryIndex {
    try {
      if (existsSync(this.indexPath)) {
        const raw = readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(raw) as HistoryIndex;
        if (parsed && parsed.version === 1 && typeof parsed.totalLines === 'number' && Array.isArray(parsed.segments)) {
          return parsed;
        }
      }
    } catch {
      // Si el archivo estuviera danado o inaccesible, se inicia un indice limpio
    }

    return {
      version: 1,
      terminalId: this.terminalId,
      totalLines: 0,
      segments: [],
    };
  }

  /** Total de lineas almacenadas segun el indice actual. */
  get totalLines(): number {
    return this.index.totalLines;
  }

  /** Total de lineas podadas por politica de retencion. */
  get prunedLines(): number {
    return this.index.prunedLines ?? 0;
  }

  /** Bytes de datos pendientes en la cola de memoria antes de persistir. */
  get pendingQueueBytes(): number {
    return this.queueBytes;
  }

  /**
   * Agrega un fragmento de salida PTY. Encola los datos y programa o dispara
   * la persistencia a disco segun tiempo o volumen acumulado.
   */
  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;

    this.writeQueue.push(chunk);
    this.queueBytes += Buffer.byteLength(chunk, 'utf8');

    // Mantiene acotada la memoria descartando lo mas viejo si se supera maxQueueBytes
    if (this.queueBytes > this.maxQueueBytes) {
      while (this.queueBytes > this.maxQueueBytes && this.writeQueue.length > 1) {
        const removed = this.writeQueue.shift()!;
        this.queueBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }

    if (this.queueBytes >= FLUSH_BYTE_THRESHOLD) {
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush(false);
      }, this.writeIntervalMs);
    }
  }

  /**
   * Fuerza la escritura inmediata de los datos encolados a disco.
   * Concurrente-seguro: serializa las operaciones de vaciado consecutivas.
   * Por defecto fuerza lineas parciales (force = true). El temporizador periodico
   * retiene lineas parciales incompletas hasta que llegue mas salida.
   */
  async flush(force: boolean = true): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.activeFlushPromise) {
      this.pendingFlushRequested = true;
      await this.activeFlushPromise;
      return;
    }

    this.activeFlushPromise = this.performFlushLoop(force);
    try {
      await this.activeFlushPromise;
    } finally {
      this.activeFlushPromise = null;
    }
  }

  /**
   * Bucle secuencial de vaciado que consume nuevas escrituras encoladas durante
   * la ejecucion de un flush anterior.
   */
  private async performFlushLoop(initialForce: boolean): Promise<void> {
    let force = initialForce;
    do {
      this.pendingFlushRequested = false;
      await this.performSingleFlush(force);
      force = true; // Flushes pendientes encadenados fuerzan datos acumulados
    } while (this.pendingFlushRequested);
  }

  /**
   * Realiza un vaciado individual hacia los archivos de segmento y actualiza
   * el indice de manera atomica.
   */
  private async performSingleFlush(force: boolean): Promise<void> {
    if (this.writeQueue.length === 0 && this.pendingPartial.length === 0) {
      return;
    }

    const chunks = this.writeQueue;
    this.writeQueue = [];
    this.queueBytes = 0;

    const rawText = this.pendingPartial + chunks.join('');
    this.pendingPartial = '';

    if (rawText.length === 0) {
      return;
    }

    let lines: string[];
    if (force || Buffer.byteLength(rawText, 'utf8') >= FLUSH_BYTE_THRESHOLD) {
      // Flush forzado: cualquier linea parcial se convierte en linea completa
      lines = rawText.endsWith('\n')
        ? rawText.slice(0, -1).split('\n')
        : rawText.split('\n');
    } else if (rawText.includes('\n')) {
      // Flush periodico: retiene el fragmento posterior al ultimo \n
      const lastNewline = rawText.lastIndexOf('\n');
      const completePart = rawText.slice(0, lastNewline);
      this.pendingPartial = rawText.slice(lastNewline + 1);
      lines = completePart.split('\n');
    } else {
      // No hay \n y no esta forzado: mantiene en buffer hasta mas datos o flush forzado
      this.pendingPartial = rawText;
      return;
    }

    if (lines.length === 0) {
      return;
    }

    try {
      await mkdir(this.dir, { recursive: true });

      let lineOffset = 0;
      while (lineOffset < lines.length) {
        let currentSeg = this.index.segments[this.index.segments.length - 1];
        const currentSegLines = currentSeg ? currentSeg.endLine - currentSeg.startLine : 0;

        // Rotacion de segmento si no existe o alcanzo maxSegmentLines
        if (!currentSeg || currentSegLines >= this.maxSegmentLines) {
          const segIndex = this.index.segments.length;
          currentSeg = {
            file: `seg-${segIndex}.bin`,
            startLine: this.index.totalLines,
            endLine: this.index.totalLines,
            byteOffset: 0,
            byteLength: 0,
            createdAt: Date.now(),
          };
          this.index.segments.push(currentSeg);
        }

        const remainingCapacity = this.maxSegmentLines - (currentSeg.endLine - currentSeg.startLine);
        const take = Math.min(lines.length - lineOffset, remainingCapacity);
        const chunkLines = lines.slice(lineOffset, lineOffset + take);

        const textToWrite = chunkLines.map((line) => line + '\n').join('');
        const byteLength = Buffer.byteLength(textToWrite, 'utf8');

        const segFilePath = path.join(this.dir, currentSeg.file);
        await appendFile(segFilePath, textToWrite, 'utf8');

        currentSeg.endLine += take;
        currentSeg.byteLength += byteLength;
        this.index.totalLines += take;

        lineOffset += take;
      }

      await this.writeIndexAtomic();
      if (this.retentionPolicy) {
        await this.prune();
      }
    } catch (error) {
      console.warn(`[TerminalHistoryStore] Error writing history for terminal ${this.terminalId}:`, error);
    }
  }

  /** Escritura atomica del indice index.json usando archivo temporal y rename. */
  private async writeIndexAtomic(): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(this.index, null, 2) + '\n', 'utf8');
    await writeAtomically(this.indexPath, buffer);
  }

  /**
   * Obtiene una pagina de lineas a partir de los segmentos en disco.
   * Lee unicamente los segmentos relevantes para el rango pedido.
   *
   * direction:
   *  - 'forward' (por omision): la pagina 0 es el tramo mas antiguo (desde el inicio historico).
   *  - 'backward': la pagina 0 es el tramo mas reciente (inmediatamente previo a la pty viva).
   */
  async getPage(
    page: number,
    pageSize: number = 1000,
    direction: 'backward' | 'forward' = 'forward',
  ): Promise<HistoryPage> {
    if (this.writeQueue.length > 0 || this.pendingPartial.length > 0) {
      await this.flush();
    }

    const size = pageSize > 0 ? pageSize : 1000;
    const total = this.index.totalLines;
    const totalPages = Math.ceil(total / size);

    if (page < 0 || total === 0 || page >= totalPages) {
      return {
        page,
        pageSize: size,
        totalLines: total,
        totalPages,
        lines: [],
        hasMore: false,
        prunedLines: this.index.prunedLines ?? 0,
        direction,
      };
    }

    let startLine: number;
    let endLine: number;

    if (direction === 'backward') {
      endLine = total - (page * size);
      startLine = Math.max(0, endLine - size);
    } else {
      startLine = page * size;
      endLine = Math.min(startLine + size, total);
    }

    const hasMore = direction === 'backward' ? startLine > 0 : endLine < total;

    // Filtra segmentos que se solapan con el rango [startLine, endLine)
    const relevantSegments = this.index.segments.filter(
      (seg) => seg.startLine < endLine && seg.endLine > startLine,
    );

    const resultLines: string[] = [];

    for (const seg of relevantSegments) {
      const filePath = path.join(this.dir, seg.file);
      let content = '';
      try {
        content = await readFile(filePath, 'utf8');
      } catch (error) {
        console.warn(`[TerminalHistoryStore] Error reading segment ${seg.file} for terminal ${this.terminalId}:`, error);
        continue;
      }

      const segLines = content.length === 0 ? [] : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
      const segStart = Math.max(startLine, seg.startLine) - seg.startLine;
      const segEnd = Math.min(endLine, seg.endLine) - seg.startLine;

      const slice = segLines.slice(segStart, segEnd);
      for (let i = 0; i < slice.length; i++) {
        resultLines.push(slice[i]!);
      }
    }

    return {
      page,
      pageSize: size,
      totalLines: total,
      totalPages,
      lines: resultLines,
      hasMore,
      prunedLines: this.index.prunedLines ?? 0,
      direction,
    };
  }

  /**
   * Exporta un tramo acotado de lineas para operaciones de portapapeles (Lane B)
   * sin requerir cargar todo el archivo en memoria.
   */
  async exportSlice(
    startLine: number,
    endLine: number,
    options?: { stripAnsi?: boolean; maxBytes?: number },
  ): Promise<{ lines: string[]; byteLength: number; truncated: boolean }> {
    if (this.writeQueue.length > 0 || this.pendingPartial.length > 0) {
      await this.flush();
    }

    const clampedStart = Math.max(0, startLine);
    const clampedEnd = Math.min(this.index.totalLines, Math.max(clampedStart, endLine));
    const maxBytes = options?.maxBytes ?? (10 * 1024 * 1024);
    const stripAnsi = options?.stripAnsi ?? false;

    const relevantSegments = this.index.segments.filter(
      (seg) => seg.startLine < clampedEnd && seg.endLine > clampedStart,
    );

    const lines: string[] = [];
    let currentBytes = 0;
    let truncated = false;

    for (const seg of relevantSegments) {
      const filePath = path.join(this.dir, seg.file);
      let content = '';
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      const segLines = content.length === 0 ? [] : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
      const segStart = Math.max(clampedStart, seg.startLine) - seg.startLine;
      const segEnd = Math.min(clampedEnd, seg.endLine) - seg.startLine;
      const slice = segLines.slice(segStart, segEnd);

      for (const line of slice) {
        const text = stripAnsi ? line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') : line;
        const lineBytes = Buffer.byteLength(text, 'utf8') + 1;
        if (currentBytes + lineBytes > maxBytes) {
          truncated = true;
          break;
        }
        lines.push(text);
        currentBytes += lineBytes;
      }

      if (truncated) break;
    }

    return { lines, byteLength: currentBytes, truncated };
  }

  /**
   * Aplica politicas de retencion podando los segmentos mas antiguos
   * cuando se superan limites de espacio en disco, total de lineas o antiguedad.
   * Nunca poda el ultimo segmento activo de una sesion en curso.
   */
  async prune(policy?: HistoryRetentionPolicy): Promise<PruneResult> {
    const activePolicy = policy ?? this.retentionPolicy;
    if (!activePolicy) {
      const diskBytes = await this.diskUsageBytes();
      return {
        prunedSegments: 0,
        prunedLines: 0,
        remainingSegments: this.index.segments.length,
        remainingLines: this.index.totalLines,
        remainingDiskBytes: diskBytes,
      };
    }

    if (this.writeQueue.length > 0 || this.pendingPartial.length > 0) {
      await this.flush();
    }

    const { maxDiskBytes, maxTotalLines, maxAgeMs } = activePolicy;
    const now = Date.now();

    const segmentsToKeep = [...this.index.segments];
    const segmentsToRemove: HistoryIndex['segments'] = [];
    let linesPruned = 0;

    // Solo podemos podar si hay mas de 1 segmento (nunca el activo)
    while (segmentsToKeep.length > 1) {
      const oldest = segmentsToKeep[0]!;
      const totalDisk = segmentsToKeep.reduce((acc, s) => acc + s.byteLength, 0);
      const totalLines = this.index.totalLines - linesPruned;

      const exceedsBytes = maxDiskBytes !== undefined && totalDisk > maxDiskBytes;
      const exceedsLines = maxTotalLines !== undefined && totalLines > maxTotalLines;
      const exceedsAge = maxAgeMs !== undefined && oldest.createdAt !== undefined && (now - oldest.createdAt > maxAgeMs);

      if (exceedsBytes || exceedsLines || exceedsAge) {
        segmentsToRemove.push(oldest);
        segmentsToKeep.shift();
        linesPruned += (oldest.endLine - oldest.startLine);
      } else {
        break;
      }
    }

    if (segmentsToRemove.length > 0) {
      for (const seg of segmentsToRemove) {
        try {
          await rm(path.join(this.dir, seg.file), { force: true });
        } catch (error) {
          console.warn(`[TerminalHistoryStore] Error removing pruned segment ${seg.file}:`, error);
        }
      }

      const lineShift = linesPruned;
      for (const seg of segmentsToKeep) {
        seg.startLine = Math.max(0, seg.startLine - lineShift);
        seg.endLine = Math.max(0, seg.endLine - lineShift);
      }

      this.index.segments = segmentsToKeep;
      this.index.totalLines = Math.max(0, this.index.totalLines - lineShift);
      this.index.prunedLines = (this.index.prunedLines ?? 0) + lineShift;

      await this.writeIndexAtomic();
    }

    const remainingDiskBytes = await this.diskUsageBytes();
    return {
      prunedSegments: segmentsToRemove.length,
      prunedLines: linesPruned,
      remainingSegments: this.index.segments.length,
      remainingLines: this.index.totalLines,
      remainingDiskBytes,
    };
  }

  /**
   * Libera recursos del almacen, vaciando datos pendientes y cancelando temporizadores.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.disposed = true;
  }

  /**
   * Elimina completamente todos los archivos y carpetas del historial de esta terminal.
   */
  async deleteAll(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.writeQueue = [];
    this.queueBytes = 0;
    this.pendingPartial = '';

    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[TerminalHistoryStore] Error deleting history directory for terminal ${this.terminalId}:`, error);
    }

    this.index = {
      version: 1,
      terminalId: this.terminalId,
      totalLines: 0,
      segments: [],
    };
  }

  /**
   * Retorna el espacio total ocupado en disco por esta terminal en bytes.
   */
  async diskUsageBytes(): Promise<number> {
    try {
      const entries = await readdir(this.dir);
      let totalBytes = 0;
      for (const entry of entries) {
        try {
          const fileStat = await stat(path.join(this.dir, entry));
          if (fileStat.isFile()) {
            totalBytes += fileStat.size;
          }
        } catch {
          // El archivo pudo haber cambiado entre readdir y stat
        }
      }
      return totalBytes;
    } catch {
      return 0;
    }
  }
}
