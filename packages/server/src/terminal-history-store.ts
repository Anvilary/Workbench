/**
 * Almacenamiento persistente del historial de salida de terminales (Lane F).
 *
 * Utiliza archivos segmentados append-only con un indice JSON atomico para
 * garantizar lecturas O(1) por paginas sin cargar historiales masivos en memoria.
 *
 * Cada terminal posee su propia subcarpeta: <baseDir>/<terminalId>/
 * Dentro residen los segmentos seg-<N>.bin (texto UTF-8 plano) y el indice index.json.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, chmod } from 'node:fs/promises';
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
const DEFAULT_MAX_SEGMENT_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_POLICY: HistoryRetentionPolicy = { maxDiskBytes: 64 * 1024 * 1024, maxTotalLines: 1_000_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 };

/** Limite maximo de memoria de la cola pendiente (1 MB). */
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;

/** Estructura del indice persistido en index.json. */
export interface HistoryIndex {
  version: 1;
  terminalId: string;
  totalLines: number;
  prunedLines?: number;
  droppedBytes?: number;
  incomplete?: boolean;
  nextSegmentId?: number;
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
  droppedBytes: number;
  incomplete: boolean;
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
  maxSegmentBytes?: number;
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
  private readonly maxSegmentBytes: number;
  private readonly writeIntervalMs: number;
  private readonly maxQueueBytes: number;
  private readonly retentionPolicy: HistoryRetentionPolicy;

  private index: HistoryIndex;
  private writeQueue: string[] = [];
  private queueBytes = 0;
  private pendingPartial = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private scheduledFlush: Promise<void> | null = null;
  private forceFlushRequested = false;
  private metadataDirty = false;
  private disposed = false;
  private closingPromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private incomplete = false;
  private failedClosed = false;

  constructor(terminalId: string, options?: TerminalHistoryStoreOptions) {
    if (!UUID_REGEX.test(terminalId)) {
      throw new Error(`Invalid terminalId: "${terminalId}" is not a valid UUID`);
    }

    this.terminalId = terminalId;
    this.baseDir = options?.baseDir ?? terminalHistoryDir();
    this.dir = path.join(this.baseDir, this.terminalId);
    this.indexPath = path.join(this.dir, 'index.json');
    this.maxSegmentLines = options?.maxSegmentLines ?? DEFAULT_MAX_SEGMENT_LINES;
    this.maxSegmentBytes = options?.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.writeIntervalMs = options?.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    this.maxQueueBytes = options?.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.retentionPolicy = this.validatePolicy(options?.retentionPolicy);
    for (const value of [this.maxSegmentLines, this.maxSegmentBytes, this.writeIntervalMs, this.maxQueueBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('History limits must be positive safe integers');
    }

    this.index = this.loadIndexSync();
    this.incomplete = this.index.incomplete ?? false;
  }

  private validatePolicy(policy?: HistoryRetentionPolicy, defaults = DEFAULT_RETENTION_POLICY): HistoryRetentionPolicy {
    const result = {
      maxDiskBytes: policy?.maxDiskBytes ?? defaults.maxDiskBytes!,
      maxTotalLines: policy?.maxTotalLines ?? defaults.maxTotalLines!,
      maxAgeMs: policy?.maxAgeMs ?? defaults.maxAgeMs!,
    };
    for (const value of Object.values(result)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('History retention limits must be nonnegative safe integers');
    }
    return result;
  }

  private recordLoss(bytes = 0): void {
    this.index.droppedBytes = (this.index.droppedBytes ?? 0) + bytes;
    this.incomplete = true;
    this.metadataDirty = true;
  }

  /** Discard only complete UTF-8 code points from the oldest pending data. */
  private trimPending(): void {
    let excess = this.pendingQueueBytes - this.maxQueueBytes;
    if (excess <= 0) return;
    const trim = (text: string): string => {
      const bytes = Buffer.from(text, 'utf8');
      let cut = Math.min(bytes.length, excess);
      while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
      excess -= cut;
      this.recordLoss(cut);
      return bytes.subarray(cut).toString('utf8');
    };
    if (this.pendingPartial) this.pendingPartial = trim(this.pendingPartial);
    while (excess > 0 && this.writeQueue.length) {
      const first = this.writeQueue[0]!;
      const kept = trim(first);
      this.queueBytes -= Buffer.byteLength(first, 'utf8') - Buffer.byteLength(kept, 'utf8');
      if (kept) this.writeQueue[0] = kept;
      else this.writeQueue.shift();
    }
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
        if (parsed && parsed.version === 1 && parsed.terminalId === this.terminalId && Number.isSafeInteger(parsed.totalLines) && parsed.totalLines >= 0 && Array.isArray(parsed.segments) && parsed.segments.every((s) => typeof s.file === 'string' && /^seg-[0-9]+\.bin$/.test(s.file) && Number.isSafeInteger(s.startLine) && Number.isSafeInteger(s.endLine) && s.startLine >= 0 && s.endLine >= s.startLine && Number.isSafeInteger(s.byteOffset) && s.byteOffset >= 0 && Number.isSafeInteger(s.byteLength) && s.byteLength >= 0)) {
          const names = new Set(parsed.segments.map(seg => seg.file));
          const lastId = parsed.segments.reduce((max, seg) => Math.max(max, Number(seg.file.slice(4, -4))), -1);
          if (!Number.isSafeInteger(lastId) || names.size !== parsed.segments.length ||
              parsed.segments.some((seg, i) => seg.startLine !== (i === 0 ? 0 : parsed.segments[i - 1]!.endLine)) ||
              parsed.segments.reduce((n, seg) => n + seg.endLine - seg.startLine, 0) !== parsed.totalLines ||
              [parsed.prunedLines, parsed.droppedBytes, parsed.nextSegmentId].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
              (parsed.nextSegmentId !== undefined && parsed.nextSegmentId <= lastId) ||
              (parsed.incomplete !== undefined && typeof parsed.incomplete !== 'boolean')) throw new Error('Invalid history index ranges');
          for (const seg of parsed.segments) {
            if (seg.createdAt === undefined) {
              try { seg.createdAt = statSync(path.join(this.dir, seg.file)).mtimeMs; }
              catch { parsed.incomplete = true; }
            } else if (!Number.isFinite(seg.createdAt) || seg.createdAt < 0) throw new Error('Invalid history segment age');
          }
          return parsed;
        }
        throw new Error('Invalid history index');
      }
    } catch {
      if (existsSync(this.indexPath)) throw new Error(`Corrupt history index: ${this.indexPath}`);
    }

    if (existsSync(this.dir) && readdirSync(this.dir).some(name => /^seg-[0-9]+\.bin$/.test(name))) {
      throw new Error('History segments exist without a committed index');
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

  get droppedBytes(): number { return this.index.droppedBytes ?? 0; }
  get isIncomplete(): boolean { return this.incomplete || this.droppedBytes > 0; }

  /** Bytes de datos pendientes en la cola de memoria antes de persistir. */
  get pendingQueueBytes(): number {
    return this.queueBytes + Buffer.byteLength(this.pendingPartial, 'utf8');
  }

  /**
   * Agrega un fragmento de salida PTY. Encola los datos y programa o dispara
   * la persistencia a disco segun tiempo o volumen acumulado.
   */
  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    if (this.failedClosed) { this.recordLoss(Buffer.byteLength(chunk, 'utf8')); return; }

    this.writeQueue.push(chunk);
    this.queueBytes += Buffer.byteLength(chunk, 'utf8');
    this.trimPending();

    if (this.queueBytes >= FLUSH_BYTE_THRESHOLD) {
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.forceFlushRequested = true;
      if (this.scheduledFlush === null) void this.flush();
    } else if (this.flushTimer === null && this.scheduledFlush === null) {
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
    this.forceFlushRequested ||= force;
    if (this.scheduledFlush) return this.scheduledFlush;
    const pending = this.serialize(async () => {
      do {
        const nextForce = this.forceFlushRequested;
        this.forceFlushRequested = false;
        await this.flushUnlocked(nextForce);
      } while (this.forceFlushRequested || this.writeQueue.length > 0);
    });
    this.scheduledFlush = pending;
    void pending.then(() => { if (this.scheduledFlush === pending) this.scheduledFlush = null; },
      () => { if (this.scheduledFlush === pending) this.scheduledFlush = null; });
    return pending;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async flushUnlocked(force: boolean = true): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.performSingleFlush(force);
  }

  /**
   * Realiza un vaciado individual hacia los archivos de segmento y actualiza
   * el indice de manera atomica.
   */
  private async performSingleFlush(force: boolean): Promise<void> {
    if (this.failedClosed) {
      const lost = this.pendingQueueBytes;
      this.writeQueue = [];
      this.queueBytes = 0;
      this.pendingPartial = '';
      if (lost > 0) this.recordLoss(lost);
      if (this.metadataDirty) await this.persistLoss();
      return;
    }
    if (this.writeQueue.length === 0 && this.pendingPartial.length === 0) {
      if (this.metadataDirty) await this.persistLoss();
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
      this.trimPending();
      if (this.metadataDirty) await this.persistLoss();
      return;
    }

    if (lines.length === 0) {
      return;
    }

    const originalIndex = structuredClone(this.index);
    const originalFileSizes = new Map<string, number | null>();
    let rotateNext = false;
    let persisted = false;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);

      let lineOffset = 0;
      while (lineOffset < lines.length) {
        let currentSeg = this.index.segments[this.index.segments.length - 1];
        const currentSegLines = currentSeg ? currentSeg.endLine - currentSeg.startLine : 0;

        // Rotacion de segmento si no existe o alcanzo maxSegmentLines
        if (!currentSeg || currentSegLines >= this.maxSegmentLines || currentSeg.byteLength >= this.maxSegmentBytes || rotateNext) {
          const segIndex = this.index.nextSegmentId ?? (this.index.segments.reduce((max, seg) => Math.max(max, Number(seg.file.match(/^seg-(\d+)\.bin$/)?.[1] ?? -1)), -1) + 1);
          if (!Number.isSafeInteger(segIndex) || segIndex >= Number.MAX_SAFE_INTEGER) throw new Error('History segment ID space exhausted');
          this.index.nextSegmentId = segIndex + 1;
          currentSeg = {
            file: `seg-${segIndex}.bin`,
            startLine: this.index.totalLines,
            endLine: this.index.totalLines,
            byteOffset: 0,
            byteLength: 0,
            createdAt: Date.now(),
          };
          this.index.segments.push(currentSeg);
          rotateNext = false;
        }

        const remainingCapacity = this.maxSegmentLines - (currentSeg.endLine - currentSeg.startLine);
        let take = 0;
        let bytes = 0;
        while (take < remainingCapacity && lineOffset + take < lines.length) {
          const nextBytes = Buffer.byteLength(lines[lineOffset + take]!, 'utf8') + 1;
          if (currentSeg.byteLength + bytes + nextBytes > this.maxSegmentBytes) break;
          bytes += nextBytes;
          take++;
        }
        if (take === 0) {
          const lineBytes = Buffer.byteLength(lines[lineOffset]! + '\n', 'utf8');
          if (currentSeg.endLine !== currentSeg.startLine) {
            rotateNext = true;
          } else {
            this.index.segments.pop();
            this.recordLoss(lineBytes);
            lineOffset++;
          }
          continue;
        }
        const chunkLines = lines.slice(lineOffset, lineOffset + take);

        const textToWrite = chunkLines.map((line) => line + '\n').join('');
        const byteLength = Buffer.byteLength(textToWrite, 'utf8');

        const segFilePath = path.join(this.dir, currentSeg.file);
        if (!originalFileSizes.has(segFilePath)) {
          let size: number | null;
          try { size = (await stat(segFilePath)).size; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            size = null;
          }
          const committedSize = currentSeg.byteOffset + currentSeg.byteLength;
          if ((size ?? 0) < committedSize) {
            this.recordLoss();
            this.failedClosed = true;
            throw new Error('Committed history segment is missing or truncated');
          }
          if (size !== null && size > committedSize) {
            // An interrupted append can leave bytes beyond the committed index.
            // Reconcile before append so new output cannot be hidden behind that tail.
            this.recordLoss(size - committedSize);
            await truncate(segFilePath, committedSize);
            size = committedSize;
          }
          originalFileSizes.set(segFilePath, size);
        }
        await appendFile(segFilePath, textToWrite, { encoding: 'utf8', mode: 0o600 });

        currentSeg.endLine += take;
        currentSeg.byteLength += byteLength;
        this.index.totalLines += take;

        lineOffset += take;
      }

      await this.writeIndexAtomic();
      persisted = true;
    } catch (error) {
      const nextSegmentId = this.index.nextSegmentId;
      const droppedBytes = this.droppedBytes;
      this.index = originalIndex;
      this.index.nextSegmentId = Math.max(originalIndex.nextSegmentId ?? 0, nextSegmentId ?? 0);
      this.index.droppedBytes = Math.max(originalIndex.droppedBytes ?? 0, droppedBytes);
      this.recordLoss(Buffer.byteLength(rawText, 'utf8'));
      for (const [file, size] of originalFileSizes) {
        try {
          if (size === null) await rm(file, { force: true });
          else await truncate(file, size);
        } catch { this.failedClosed = true; }
      }
      await this.writeIndexAtomic().catch(() => {});
      console.warn(`[TerminalHistoryStore] Error writing history for terminal ${this.terminalId}:`, error);
    }
    if (persisted) {
      try { await this.pruneUnlocked(); }
      catch (error) { this.recordLoss(); this.failedClosed = true; await this.persistLoss(); console.warn(`[TerminalHistoryStore] Error pruning history for terminal ${this.terminalId}:`, error); }
    }
  }

  /** Escritura atomica del indice index.json usando archivo temporal y rename. */
  private async writeIndexAtomic(): Promise<void> {
    this.index.incomplete = this.isIncomplete;
    const buffer = Buffer.from(JSON.stringify(this.index, null, 2) + '\n', 'utf8');
    this.metadataDirty = false;
    try { await writeAtomically(this.indexPath, buffer, { mode: 0o600 }); }
    catch (error) { this.metadataDirty = true; throw error; }
  }

  private async persistLoss(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.writeIndexAtomic();
    } catch { this.metadataDirty = true; }
  }

  private async readSegment(seg: HistoryIndex['segments'][number]): Promise<string[]> {
    const bytes = await readFile(path.join(this.dir, seg.file));
    const end = seg.byteOffset + seg.byteLength;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(seg.byteOffset, end));
    const lines = content.length === 0 ? [] : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
    if (bytes.length !== end || lines.length !== seg.endLine - seg.startLine) {
      this.recordLoss();
      await this.persistLoss();
    }
    return lines;
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
    return this.serialize(async () => {
      if (this.writeQueue.length > 0 || this.pendingPartial.length > 0 || this.metadataDirty) await this.flushUnlocked();
      if (!this.failedClosed) await this.pruneUnlocked();

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
          droppedBytes: this.droppedBytes,
          incomplete: this.isIncomplete,
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
        let segLines: string[];
        try {
          segLines = await this.readSegment(seg);
        } catch (error) {
          this.recordLoss();
          await this.persistLoss();
          console.warn(`[TerminalHistoryStore] Error reading segment ${seg.file} for terminal ${this.terminalId}:`, error);
          continue;
        }

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
        droppedBytes: this.droppedBytes,
        incomplete: this.isIncomplete,
      };
    });
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
    return this.serialize(async () => {
      if (this.writeQueue.length > 0 || this.pendingPartial.length > 0) await this.flushUnlocked();

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
        let segLines: string[];
        try {
          segLines = await this.readSegment(seg);
        } catch {
          this.recordLoss();
          await this.persistLoss();
          continue;
        }

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
    });
  }

  /**
   * Aplica politicas de retencion podando los segmentos mas antiguos
   * cuando se superan limites de espacio en disco, total de lineas o antiguedad.
   * Los segmentos historicos son independientes del estado vivo de la PTY.
   */
  async prune(policy?: HistoryRetentionPolicy): Promise<PruneResult> {
    return this.serialize(async () => {
      if (this.writeQueue.length > 0 || this.pendingPartial.length > 0) await this.flushUnlocked();
      return this.pruneUnlocked(policy);
    });
  }

  private async pruneUnlocked(policy?: HistoryRetentionPolicy): Promise<PruneResult> {
    const activePolicy = this.validatePolicy(policy, this.retentionPolicy);

    const { maxDiskBytes, maxTotalLines, maxAgeMs } = activePolicy;
    const now = Date.now();

    const segmentsToKeep = [...this.index.segments];
    const segmentsToRemove: HistoryIndex['segments'] = [];
    let linesPruned = 0;

    while (segmentsToKeep.length > 0) {
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
      const previous = this.index;
      this.index = {
        ...previous,
        segments: segmentsToKeep.map(seg => ({ ...seg, startLine: seg.startLine - linesPruned, endLine: seg.endLine - linesPruned })),
        totalLines: previous.totalLines - linesPruned,
        prunedLines: (previous.prunedLines ?? 0) + linesPruned,
      };
      try { await this.writeIndexAtomic(); }
      catch (error) {
        this.index = previous;
        this.recordLoss();
        throw error;
      }
      // The committed index must stop referencing files before they are removed.
      for (const seg of segmentsToRemove) {
        try { await rm(path.join(this.dir, seg.file), { force: true }); }
        catch (error) {
          this.recordLoss();
          this.failedClosed = true;
          await this.persistLoss();
          throw error;
        }
      }
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
    if (this.closingPromise) return this.closingPromise;
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.closingPromise = this.serialize(() => this.flushUnlocked());
    await this.closingPromise;
  }

  /**
   * Elimina completamente todos los archivos y carpetas del historial de esta terminal.
   */
  async deleteAll(): Promise<void> {
    this.disposed = true;
    if (this.closingPromise) await this.closingPromise;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.serialize(async () => {
      this.writeQueue = [];
      this.queueBytes = 0;
      this.pendingPartial = '';
      try {
        await rm(this.dir, { recursive: true, force: true });
      } catch (error) {
        this.recordLoss();
        throw error;
      }
      this.index = { version: 1, terminalId: this.terminalId, totalLines: 0, segments: [], droppedBytes: 0 };
      this.incomplete = false;
      this.metadataDirty = false;
    });
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
