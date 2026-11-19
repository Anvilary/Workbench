/**
 * What gets published is `dist-npm/`, built from a whitelist. This fails if
 * anything outside it shows up in the tarball: sources, notes, local files.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-npm');
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: outDir, encoding: 'utf8', shell: process.platform === 'win32' });
const manifest = JSON.parse(raw);
const packages = Array.isArray(manifest) ? manifest : Object.values(manifest);
if (packages.length !== 1 || !Array.isArray(packages[0]?.files)) {
  throw new Error('npm pack did not return a single tarball file list');
}
const files = packages[0].files.map((file) => file.path);

const allowed = (file) =>
  file === 'package.json' ||
  file === 'README.md' ||
  file === 'LICENSE' ||
  file === 'dist/server.js' ||
  file === 'dist/maw-ptyd.mjs' ||
  file === 'dist/terminal-state.mjs' ||
  file.startsWith('dist/web/');
const strangers = files.filter((file) => !allowed(file));

if (strangers.length > 0) {
  console.error('Unexpected files in the tarball:\n  ' + strangers.join('\n  '));
  process.exit(1);
}
if (
  !files.includes('dist/server.js') ||
  !files.includes('dist/maw-ptyd.mjs') ||
  !files.includes('dist/terminal-state.mjs') ||
  !files.includes('dist/web/index.html')
) {
  console.error('The tarball is missing the server, PTY supervisor, or interface.');
  process.exit(1);
}
console.log(`Tarball clean: ${files.length} files`);
