import path from 'node:path';
import { tmpdir } from 'node:os';
// Run from repo root:
// node --import ./packages/server/node_modules/tsx/dist/loader.mjs scripts/audit/terminal-rendering-reproduction.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { OutputBuffer } from '../../packages/server/src/features/terminals/output-buffer.ts';
import { TerminalOutput } from '../../packages/web/src/features/terminals/terminal-output.ts';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { Terminal } = require('@xterm/headless');
const baseline = '85dd91c745980a9870eb591dc0936b40ce7da86c';
const source = execFileSync('git', ['show', baseline + ':packages/server/src/output-buffer.ts'], { encoding: 'utf8' });
const code = (await transform(source, { loader: 'ts', format: 'esm' })).code;
const { OutputBuffer: BeforeBuffer } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const makeTerminal = () => new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
const drain = term => new Promise(resolve => term.write('', resolve));
const firstLine = term => term.buffer.active.getLine(0).translateToString(true);
const seq = '\x1b[38;2;120;40;230mRGB\x1b[0m';
const limit = Buffer.byteLength(seq.slice(seq.indexOf('120')));
const old = new BeforeBuffer(limit), fixed = new OutputBuffer(limit);
const beforeTerm = makeTerminal(), afterTerm = makeTerminal(), oldReset = makeTerminal(), newReset = makeTerminal();
const output = new TerminalOutput(newReset);
try {
  old.push(seq); fixed.push(seq);
  beforeTerm.write(old.read()); afterTerm.write((await fixed.checkpoint()).data);
  oldReset.write('\x1b[38;2;'); oldReset.reset(); oldReset.write('RECOVERED');
  output.output('\x1b[38;2;');
  output.replay({ type:'terminal.replay', terminalId:'fixture', reset:true, truncated:false, data:'RECOVERED' });
  for (let i=0;i<20 && firstLine(newReset)!=='RECOVERED';i++) await new Promise(resolve=>setTimeout(resolve,5));
  await Promise.all([beforeTerm, afterTerm, oldReset, newReset].map(drain));
  const seed = new BeforeBuffer(); seed.seed('\x1b[?1049h'+'x'.repeat(20),100,120,true);
  const result = {
    baseline,
    rgbTruncation: { before: firstLine(beforeTerm), after: firstLine(afterTerm), rawRetained: JSON.stringify(old.read()) },
    queuedReset: { before: firstLine(oldReset), after: firstLine(newReset) },
    legacySeed: { expectedStart: 100, beforeStart: seed.startOffset },
  };
  assert.equal(result.rgbTruncation.before,'120;40;230mRGB');
  assert.equal(result.rgbTruncation.after,'RGB');
  assert.notEqual(result.queuedReset.before,'RECOVERED');
  assert.equal(result.queuedReset.after,'RECOVERED');
  const directory=path.join(tmpdir(), 'workbench-evidence', 'terminal-rendering');
  await mkdir(directory,{recursive:true});
  await writeFile(directory+'/protocol-reproduction.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally { fixed.dispose(); output.dispose(); [beforeTerm,afterTerm,oldReset,newReset].forEach(t=>t.dispose()); }
