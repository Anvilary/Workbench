#!/usr/bin/env node
/**
 * Production ESM Server Bundler for MAW.
 *
 * Compiles packages/server/src/index.ts into a standalone, prebuilt ESM artifact
 * at packages/server/dist/index.mjs.
 *
 * Externalizes:
 * - Native C++ addons (node-pty)
 * - Server runtimes with native bindings (ws, @xterm/headless)
 * - Pure Node dependencies resolved from node_modules (chokidar, express, fzstd)
 * - Dev-only dependencies (vite)
 *
 * Bundles:
 * - Local TypeScript server code
 * - Internal workspace packages (@agent-workbench/shared)
 */

import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const entryPoint = path.join(serverRoot, 'src/index.ts');
const outdir = path.join(serverRoot, 'dist');
const outfile = path.join(outdir, 'index.mjs');

if (!fs.existsSync(outdir)) {
  fs.mkdirSync(outdir, { recursive: true });
}

const external = [
  'node-pty',
  'ws',
  'chokidar',
  'express',
  'fzstd',
  '@xterm/headless',
  'vite',
];

const startTime = Date.now();

try {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    sourcemap: true,
    metafile: true,
    logLevel: 'info',
  });

  const durationMs = Date.now() - startTime;
  const stats = fs.statSync(outfile);
  const sizeKiB = (stats.size / 1024).toFixed(1);

  console.log(`[build-bundle] Server bundle built in ${durationMs} ms (${sizeKiB} KiB) -> ${outfile}`);

  const supervisorSrc = path.join(serverRoot, 'src/pty-host/maw-ptyd.mjs');
  const supervisorDest = path.join(outdir, 'maw-ptyd.mjs');
  if (fs.existsSync(supervisorSrc)) {
    fs.copyFileSync(supervisorSrc, supervisorDest);
    fs.chmodSync(supervisorDest, 0o755);
    console.log(`[build-bundle] Copied standalone supervisor to ${supervisorDest}`);
  }
} catch (error) {
  console.error('[build-bundle] Failed to bundle server:', error);
  process.exit(1);
}
