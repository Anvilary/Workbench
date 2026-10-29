#!/bin/sh
# Proves a Node+tsx process started through a `current` symlink keeps resolving
# its modules, static assets and cwd-relative paths in the ORIGINAL release after
# `current` is atomically swapped (what `maw update --no-restart` does).
# Disposable: everything lives under a fresh temp dir. Requires `pnpm install`.
set -eu
REPO=$(git rev-parse --show-toplevel)
TSX=$(readlink -f "$REPO/packages/server/node_modules/tsx")
S=$(mktemp -d "${TMPDIR:-/tmp}/maw-symlink.XXXX")
for R in R0 R1; do
  mkdir -p $S/releases/$R/packages/server/src $S/releases/$R/packages/server/node_modules $S/releases/$R/packages/web/dist
  ln -s "$TSX" $S/releases/$R/packages/server/node_modules/tsx
  echo '{"type":"module"}' > $S/releases/$R/packages/server/package.json
  echo "asset-from-$R" > $S/releases/$R/packages/web/dist/app.js
  echo "export const who: string = 'lazy-module-from-$R';" > $S/releases/$R/packages/server/src/lazy.ts
  cat > $S/releases/$R/packages/server/src/index.ts <<'TS'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
const serverDir = path.dirname(fileURLToPath(import.meta.url));   // same expression as packages/server/src/index.ts:76
const webDist = path.join(path.resolve(serverDir, '../../web'), 'dist');
console.log('serverDir=' + serverDir);
console.log('cwd=' + process.cwd());
while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 50));
console.log('after-swap lazy=' + (await import('./lazy.ts')).who);
console.log('after-swap static=' + readFileSync(path.join(webDist, 'app.js'), 'utf8').trim());
console.log('after-swap cwd-relative=' + readFileSync('packages/web/dist/app.js', 'utf8').trim());
TS
done
ln -s $S/releases/R0 $S/current
# spawn() with cwd performs chdir() through the symlink, like systemd WorkingDirectory=
node -e "
const { spawn } = require('child_process'); const fs = require('fs'); const cur = '$S/current';
const p = spawn(process.execPath, ['--import', cur + '/packages/server/node_modules/tsx/dist/loader.mjs', cur + '/packages/server/src/index.ts', '$S/flag'], { cwd: cur, stdio: 'inherit' });
setTimeout(() => { fs.symlinkSync('$S/releases/R1', cur + '.tmp'); fs.renameSync(cur + '.tmp', cur); console.log('SWAPPED current -> R1'); fs.writeFileSync('$S/flag', ''); }, 1500);
p.on('exit', c => process.exit(c));
" | sed "s#$S#\$FIX#g"
rm -rf "$S"
