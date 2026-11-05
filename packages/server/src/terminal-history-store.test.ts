import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TerminalHistoryStore } from './terminal-history-store.js';

async function createTempBaseDir(): Promise<string> {
  const dir = path.join(tmpdir(), `maw-history-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('1. Push and flush: written lines appear in getPage(0)', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  store.push('line 1\nline 2\nline 3\n');
  await store.flush();

  const page = await store.getPage(0, 10);
  assert.equal(page.page, 0);
  assert.equal(page.pageSize, 10);
  assert.equal(page.totalLines, 3);
  assert.equal(page.totalPages, 1);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.lines, ['line 1', 'line 2', 'line 3']);

  await store.dispose();
});

test('2. Multiple segments: pushing > maxSegmentLines causes segment rotation, all lines recoverable', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir,
    maxSegmentLines: 20,
  });

  // Escribir 50 lineas con rotacion cada 20 lineas (20 + 20 + 10 = 3 segmentos)
  for (let i = 0; i < 50; i++) {
    store.push(`line-${i}\n`);
  }
  await store.flush();

  assert.equal(store.totalLines, 50);

  const page = await store.getPage(0, 100);
  assert.equal(page.totalLines, 50);
  assert.equal(page.lines.length, 50);
  assert.equal(page.lines[0], 'line-0');
  assert.equal(page.lines[19], 'line-19');
  assert.equal(page.lines[20], 'line-20');
  assert.equal(page.lines[49], 'line-49');

  await store.dispose();
});

test('3. Pagination: pushing 2500 lines, getPage(0,1000) returns lines 0-999, getPage(1,1000) returns 1000-1999, getPage(2,1000) returns 2000-2499', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir,
    maxSegmentLines: 1000,
  });

  for (let i = 0; i < 2500; i++) {
    store.push(`line ${i}\n`);
  }
  await store.flush();

  assert.equal(store.totalLines, 2500);

  // Pagina 0: lineas 0 a 999
  const page0 = await store.getPage(0, 1000);
  assert.equal(page0.page, 0);
  assert.equal(page0.pageSize, 1000);
  assert.equal(page0.totalLines, 2500);
  assert.equal(page0.totalPages, 3);
  assert.equal(page0.hasMore, true);
  assert.equal(page0.lines.length, 1000);
  assert.equal(page0.lines[0], 'line 0');
  assert.equal(page0.lines[999], 'line 999');

  // Pagina 1: lineas 1000 a 1999
  const page1 = await store.getPage(1, 1000);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 1000);
  assert.equal(page1.totalLines, 2500);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.lines.length, 1000);
  assert.equal(page1.lines[0], 'line 1000');
  assert.equal(page1.lines[999], 'line 1999');

  // Pagina 2: lineas 2000 a 2499
  const page2 = await store.getPage(2, 1000);
  assert.equal(page2.page, 2);
  assert.equal(page2.pageSize, 1000);
  assert.equal(page2.totalLines, 2500);
  assert.equal(page2.totalPages, 3);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.lines.length, 500);
  assert.equal(page2.lines[0], 'line 2000');
  assert.equal(page2.lines[499], 'line 2499');

  // Pagina 3 (fuera de rango): vacia
  const page3 = await store.getPage(3, 1000);
  assert.equal(page3.page, 3);
  assert.equal(page3.hasMore, false);
  assert.deepEqual(page3.lines, []);

  await store.dispose();
});

test('4. Disk-full simulation: if writes fail, push does not throw, server continues', async (t) => {
  const baseDir = await createTempBaseDir();
  // Creamos un archivo comun con el nombre del baseDir para que mkdir lance ENOTDIR
  const blockingFile = path.join(baseDir, 'blocking-file');
  await writeFile(blockingFile, 'blocking content');

  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir: blockingFile, // baseDir es un archivo, la creacion de carpeta fallara
  });

  // push no debe lanzar excepcion aunque falle la escritura
  assert.doesNotThrow(() => {
    store.push('this write will fail on disk\n');
  });

  // flush no debe tumbar el servidor
  await assert.doesNotReject(async () => {
    await store.flush();
  });

  await assert.doesNotReject(async () => {
    await store.dispose();
  });
});

test('5. ANSI preservation: lines containing ANSI sequences are stored and retrieved intact', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  const ansiLine1 = '\x1b[31mRed text\x1b[0m';
  const ansiLine2 = '\x1b[1;34mBold Blue\x1b[0m';
  const ansiLine3 = '\x1b[?1049h\x1b[H\x1b[2JTUI header';

  store.push(`${ansiLine1}\n${ansiLine2}\n${ansiLine3}\n`);
  await store.flush();

  const page = await store.getPage(0);
  assert.equal(page.lines.length, 3);
  assert.equal(page.lines[0], ansiLine1);
  assert.equal(page.lines[1], ansiLine2);
  assert.equal(page.lines[2], ansiLine3);

  await store.dispose();
});

test('6. Unicode: lines containing multi-byte UTF-8 characters round-trip correctly', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  const unicode1 = '🚀 Cohete y fuegos artificiales 🎉🔥';
  const unicode2 = 'Ñandú con acento y diéresis: pingüino';
  const unicode3 = 'こんにちは世界 (CJK characters)';

  store.push(`${unicode1}\n${unicode2}\n${unicode3}\n`);
  await store.flush();

  const page = await store.getPage(0);
  assert.equal(page.lines.length, 3);
  assert.equal(page.lines[0], unicode1);
  assert.equal(page.lines[1], unicode2);
  assert.equal(page.lines[2], unicode3);

  await store.dispose();
});

test('7. Total lines count: matches actual pushed lines after flush', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  assert.equal(store.totalLines, 0);

  for (let i = 0; i < 123; i++) {
    store.push(`line ${i}\n`);
  }
  await store.flush();
  assert.equal(store.totalLines, 123);

  for (let i = 0; i < 77; i++) {
    store.push(`line ${123 + i}\n`);
  }
  await store.flush();
  assert.equal(store.totalLines, 200);

  await store.dispose();
});

test('8. deleteAll: after deleteAll, getPage returns empty, totalLines is 0', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  for (let i = 0; i < 15; i++) {
    store.push(`entry ${i}\n`);
  }
  await store.flush();

  assert.equal(store.totalLines, 15);
  const beforeDelete = await store.getPage(0);
  assert.equal(beforeDelete.lines.length, 15);
  const usageBefore = await store.diskUsageBytes();
  assert.ok(usageBefore > 0);

  await store.deleteAll();

  assert.equal(store.totalLines, 0);
  const afterDelete = await store.getPage(0);
  assert.deepEqual(afterDelete.lines, []);
  assert.equal(afterDelete.totalLines, 0);
  assert.equal(afterDelete.totalPages, 0);
  assert.equal(afterDelete.hasMore, false);

  const usageAfter = await store.diskUsageBytes();
  assert.equal(usageAfter, 0);

  await store.dispose();
});

test('9. Dispose and re-open: data written before dispose is accessible after creating a new store for the same terminalId', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();

  // Primera instancia escribe datos y se descarta
  const store1 = new TerminalHistoryStore(terminalId, { baseDir });
  store1.push('alpha\nbeta\ngamma\n');
  await store1.dispose();

  // Segunda instancia para el mismo terminalId reabre la historia
  const store2 = new TerminalHistoryStore(terminalId, { baseDir });
  assert.equal(store2.totalLines, 3);

  const page = await store2.getPage(0);
  assert.equal(page.totalLines, 3);
  assert.deepEqual(page.lines, ['alpha', 'beta', 'gamma']);

  // Escribir mas en la segunda instancia continua normalmente
  store2.push('delta\n');
  await store2.flush();
  assert.equal(store2.totalLines, 4);

  const pageUpdated = await store2.getPage(0);
  assert.deepEqual(pageUpdated.lines, ['alpha', 'beta', 'gamma', 'delta']);

  await store2.dispose();
});

test('10. Invalid terminalId (path traversal attempt): constructor throws immediately', () => {
  assert.throws(
    () => new TerminalHistoryStore('../../evil-dir'),
    /Invalid terminalId/,
  );
  assert.throws(
    () => new TerminalHistoryStore('/etc/shadow'),
    /Invalid terminalId/,
  );
  assert.throws(
    () => new TerminalHistoryStore('..\\windows\\traversal'),
    /Invalid terminalId/,
  );
  assert.throws(
    () => new TerminalHistoryStore('not-a-valid-uuid'),
    /Invalid terminalId/,
  );
  assert.throws(
    () => new TerminalHistoryStore(''),
    /Invalid terminalId/,
  );
});

test('Trailing partial line buffering: buffered until newline or forced by flush', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });

  // Empujar fragmentos sin salto de linea
  store.push('hello ');
  store.push('world\nsecond line without newline');
  // Flush explicito fuerza el volcado de la linea parcial final
  await store.flush();

  const page = await store.getPage(0);
  assert.equal(page.totalLines, 2);
  assert.deepEqual(page.lines, ['hello world', 'second line without newline']);

  await store.dispose();
});

test('12. Backward pagination (direction: backward): page 0 is latest slice, page 1 is older slice', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir,
    maxSegmentLines: 500,
  });

  for (let i = 0; i < 2500; i++) {
    store.push(`item ${i}\n`);
  }
  await store.flush();

  // Pagina 0 en backward: lineas 1500 a 2499 (las 1000 mas recientes)
  const page0 = await store.getPage(0, 1000, 'backward');
  assert.equal(page0.page, 0);
  assert.equal(page0.pageSize, 1000);
  assert.equal(page0.lines.length, 1000);
  assert.equal(page0.lines[0], 'item 1500');
  assert.equal(page0.lines[999], 'item 2499');
  assert.equal(page0.hasMore, true);

  // Pagina 1 en backward: lineas 500 a 1499
  const page1 = await store.getPage(1, 1000, 'backward');
  assert.equal(page1.page, 1);
  assert.equal(page1.lines.length, 1000);
  assert.equal(page1.lines[0], 'item 500');
  assert.equal(page1.lines[999], 'item 1499');
  assert.equal(page1.hasMore, true);

  // Pagina 2 en backward: lineas 0 a 499 (primeras lineas del historial)
  const page2 = await store.getPage(2, 1000, 'backward');
  assert.equal(page2.page, 2);
  assert.equal(page2.lines.length, 500);
  assert.equal(page2.lines[0], 'item 0');
  assert.equal(page2.lines[499], 'item 499');
  assert.equal(page2.hasMore, false);

  await store.dispose();
});

test('13. Retention pruning: prunes oldest completed segments when quota exceeded', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir,
    maxSegmentLines: 100,
    retentionPolicy: {
      maxTotalLines: 250, // Conserva como maximo 250 lineas
    },
  });

  // Escribir 500 lineas (5 segmentos de 100 lineas)
  for (let i = 0; i < 500; i++) {
    store.push(`line-${i}\n`);
  }
  await store.flush();

  // El flush automatico ya aplica retentionPolicy configurado
  assert.equal(store.totalLines <= 250, true);

  // Comprobar que getPage reporta las lineas podadas
  const page = await store.getPage(0, 100);
  assert.equal(page.prunedLines! >= 200, true);

  // Podado manual adicional a un limite mas bajo (150 lineas)
  const result = await store.prune({ maxTotalLines: 150 });
  assert.equal(result.remainingLines <= 150, true);
  assert.equal(result.prunedLines > 0, true);

  await store.dispose();
});

test('14. exportSlice: bounded streaming export with optional ANSI stripping', async (t) => {
  const baseDir = await createTempBaseDir();
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir, maxSegmentLines: 50 });

  for (let i = 0; i < 100; i++) {
    store.push(`\x1b[32mline ${i}\x1b[0m\n`);
  }
  await store.flush();

  // Exportar con ANSI removido
  const exported = await store.exportSlice(10, 20, { stripAnsi: true });
  assert.equal(exported.lines.length, 10);
  assert.equal(exported.lines[0], 'line 10');
  assert.equal(exported.lines[9], 'line 19');
  assert.equal(exported.truncated, false);

  // Exportar con limite estricto de bytes
  const smallExport = await store.exportSlice(0, 100, { maxBytes: 150 });
  assert.equal(smallExport.truncated, true);
  assert.equal(smallExport.lines.length < 100, true);

  await store.dispose();
});
