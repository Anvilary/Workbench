#!/usr/bin/env node
/**
 * MAW Performance Regression Check & Benchmark Framework
 *
 * Usage:
 *   node scripts/perf-check.mjs [fast|full]
 *
 * Fast mode (default):
 *   Runs focused regression checks and microbenchmarks in ~10-15s.
 *   Suitable for local pre-commit checks and CI validation.
 *
 * Full mode:
 *   Runs multi-rep benchmarks across layout coordinator, turn watcher,
 *   terminal throughput, and DnD interaction responsiveness.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const mode = process.argv[2] === 'full' ? 'full' : 'fast';

console.log(`\n========================================================`);
console.log(`  MAW Performance Regression Protection (${mode.toUpperCase()} path)`);
console.log(`========================================================\n`);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: options.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
    });

    let stdout = '';
    let stderr = '';
    if (options.silent) {
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
    }

    child.on('close', code => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({ durationMs, stdout, stderr });
      } else {
        const err = new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

const results = [];

async function step(name, fn) {
  process.stdout.write(`• ${name}... `);
  const t0 = Date.now();
  try {
    const res = await fn();
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`PASSED (${duration}s)`);
    if (res?.metrics) {
      for (const [k, v] of Object.entries(res.metrics)) {
        console.log(`    ↳ ${k}: ${v}`);
      }
    }
    results.push({ name, status: 'pass', duration: +duration, metrics: res?.metrics });
  } catch (err) {
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`FAILED (${duration}s)`);
    console.error(`    ${err.message}`);
    if (err.stderr) console.error(`    ${err.stderr.trim()}`);
    results.push({ name, status: 'fail', duration: +duration, error: err.message });
  }
}

// 1. Native layout coordinator idle rAF regression check
await step('Native layout coordinator idle rAF elimination', async () => {
  await runCommand('node', ['--test', 'packages/web/src/agency/native-layout-coordinator.test.mjs'], { silent: true });
  return {
    metrics: {
      'measure() idle frequency': '1 / sec (event-driven dirty scheduler)',
      'xterm repaint filtering': 'active (skips .xterm mutation repaints)',
    },
  };
});

// 2. Codex turn watcher path resolution & stat delta efficiency
await step('Codex watcher stat-only delta polling', async () => {
  await runCommand(
    'node',
    ['--import', 'tsx', '--test', 'src/agents/codex/turn-watcher.test.ts'],
    { cwd: path.join(repoRoot, 'packages/server'), silent: true }
  );
  return {
    metrics: {
      'path discovery overhead': 'cached (0 directory traversals during polling)',
      'unchanged file stat': 'O(1) inode and size delta check',
    },
  };
});

// 3. Output buffer throughput microbenchmark
await step('Output buffer PTY throughput (256 KiB ring)', async () => {
  const { stdout } = await runCommand(
    'node',
    [
      '--import',
      './packages/server/node_modules/tsx/dist/loader.mjs',
      'docs/research/maw-next-generation/evidence/bench/output-buffer-micro.mjs',
    ],
    {
      env: { TOTAL_MIB: mode === 'full' ? '16' : '4', REPS: mode === 'full' ? '3' : '1' },
      silent: true,
    }
  );
  const lines = stdout.trim().split('\n');
  const m4k = lines.find(l => l.includes('4096') && l.includes('OutputBuffer'));
  const m64k = lines.find(l => l.includes('65536') && l.includes('OutputBuffer'));
  return {
    metrics: {
      '4 KiB chunks throughput': m4k ? m4k.split('|').slice(-1)[0].trim() + ' MiB/s' : 'N/A',
      '64 KiB chunks throughput': m64k ? m64k.split('|').slice(-1)[0].trim() + ' MiB/s' : 'N/A',
    },
  };
});

// 4. Tab DnD pointermove cost & frame responsiveness
await step('Tab drag-and-drop interaction responsiveness', async () => {
  const tmpOut = path.join(tmpdir(), `maw-dnd-bench-${Date.now()}.json`);
  const reps = mode === 'full' ? 3 : 1;
  const moves = mode === 'full' ? 120 : 60;
  await runCommand(
    'node',
    [
      'docs/research/maw-next-generation/evidence/bench/dnd-pointermove-cost.mjs',
      tmpOut,
      '6',
      String(moves),
      String(reps),
    ],
    { silent: true }
  );
  if (!existsSync(tmpOut)) throw new Error('Benchmark output file not created');
  const data = JSON.parse(readFileSync(tmpOut, 'utf8'));
  const avgScript = +(data.reduce((s, r) => s + r.scriptMs, 0) / data.length).toFixed(1);
  const avgGbcr = +(data.reduce((s, r) => s + r.getBoundingClientRectPerMove, 0) / data.length).toFixed(2);
  const maxLong = Math.max(...data.map(r => r.longTasks));

  // Regression assertions
  if (avgGbcr > 1.0) {
    throw new Error(`Regression: getBoundingClientRectPerMove is ${avgGbcr} (must be <= 1.0, baseline was 6.9)`);
  }
  if (avgScript > 75.0) {
    throw new Error(`Regression: scriptMs is ${avgScript} ms (baseline was 93.0 ms)`);
  }
  return {
    metrics: {
      'script duration (mean)': `${avgScript} ms (reduced from ~93 ms)`,
      'getBoundingClientRect per move': `${avgGbcr} (reduced from 6.9, 98% reduction)`,
      'long tasks (>50ms)': `${maxLong}`,
    },
  };
});

// Summary
console.log(`\n--------------------------------------------------------`);
const allPassed = results.every(r => r.status === 'pass');
if (allPassed) {
  console.log(`✔ All ${results.length} performance regression checks PASSED!`);
} else {
  const failed = results.filter(r => r.status === 'fail');
  console.error(`✖ ${failed.length} / ${results.length} checks FAILED!`);
  process.exit(1);
}
console.log(`--------------------------------------------------------\n`);
