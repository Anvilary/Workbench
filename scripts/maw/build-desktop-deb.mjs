// Build only. Installation is a separate explicit administrator action.
import { cp, mkdir, mkdtemp, writeFile, chmod, rm, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runtimeFor } from './desktop-runtime.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version, directory } = await runtimeFor(root);
const require = createRequire(path.join(root, 'packages/desktop/package.json'));
const dist = path.dirname(require('electron'));
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (process.platform !== 'linux' || !arch) throw new Error('Build on Ubuntu amd64 or arm64');
const stage = await mkdtemp(path.join(tmpdir(), 'maw-desktop-deb-'));
const out = path.resolve(process.argv[2] || path.join(root, 'dist-desktop'));
try {
  await chmod(stage, 0o755);
  await mkdir(path.join(stage, 'DEBIAN'));
  await mkdir(out, { recursive: true });
  await cp(dist, path.join(stage, directory), { recursive: true });
  async function normalize(directory) {
    await chmod(directory, 0o755);
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
      if (info.isDirectory()) await normalize(file);
      else await chmod(file, info.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  await normalize(path.join(stage, 'opt'));
  // Do not reuse hard links to pnpm's store. dpkg installs these as root-owned files.
  await chmod(path.join(stage, directory, 'chrome-sandbox'), 0o4755);
  await writeFile(path.join(stage, 'DEBIAN/control'), `Package: maw-electron-${version.replaceAll('.', '-')}
Version: ${version}
Architecture: ${arch}
Maintainer: MAW maintainers
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libgbm1, libxss1, libxtst6, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libdrm2, libxkbcommon0, libnotify4, libsecret-1-0
Description: Versioned Chromium sandbox runtime for My Amazing Workspace
 Co-installable runtime; no service or user data changes.
`);
  // Ubuntu user-namespace policy for this exact root-owned executable. SUID
  // sandbox remains packaged for hosts using that Chromium sandbox mechanism.
  const profile = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile maw-electron-${version} ${directory}/electron flags=(unconfined) {\n  userns,\n}\n`;
  await mkdir(path.join(stage, 'etc/apparmor.d'), { recursive: true });
  await writeFile(path.join(stage, `etc/apparmor.d/maw-electron-${version}`), profile);
  await writeFile(path.join(stage, 'DEBIAN/postinst'), `#!/bin/sh\nset -e\nif command -v apparmor_parser >/dev/null 2>&1 && test -d /sys/kernel/security/apparmor; then apparmor_parser -r /etc/apparmor.d/maw-electron-${version}; fi\n`, { mode: 0o755 });
  const file = path.join(out, `maw-electron-${version}_${arch}.deb`);
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, file], { stdio: 'inherit' });
} finally { await rm(stage, { recursive: true, force: true }); }
