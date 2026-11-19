// Build only. Installation is a separate explicit administrator action.
import { cp, mkdir, mkdtemp, writeFile, chmod, rm, readdir, lstat, utimes } from 'node:fs/promises';
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

function resolveSourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH && /^\d+$/.test(process.env.SOURCE_DATE_EPOCH)) {
    return Number(process.env.SOURCE_DATE_EPOCH);
  }
  try {
    const gitEpoch = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^\d+$/.test(gitEpoch)) return Number(gitEpoch);
  } catch {}
  return 1704067200;
}

const sourceDateEpoch = resolveSourceDateEpoch();
const stage = await mkdtemp(path.join(tmpdir(), 'maw-desktop-deb-'));
const out = path.resolve(process.argv[2] || path.join(root, 'dist-desktop'));
try {
  await chmod(stage, 0o755);
  await mkdir(path.join(stage, 'DEBIAN'));
  await mkdir(out, { recursive: true });
  await cp(dist, path.join(stage, directory), { recursive: true });
  async function normalize(targetDir) {
    await chmod(targetDir, 0o755);
    for (const name of await readdir(targetDir)) {
      const file = path.join(targetDir, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
      if (info.isDirectory()) await normalize(file);
      else {
        await chmod(file, info.mode & 0o111 ? 0o755 : 0o644);
        await utimes(file, sourceDateEpoch, sourceDateEpoch);
      }
    }
    await utimes(targetDir, sourceDateEpoch, sourceDateEpoch);
  }
  await normalize(path.join(stage, 'opt'));
  // Do not reuse hard links to pnpm's store. dpkg installs these as root-owned files.
  const sandboxPath = path.join(stage, directory, 'chrome-sandbox');
  await chmod(sandboxPath, 0o4755);
  await utimes(sandboxPath, sourceDateEpoch, sourceDateEpoch);
  await utimes(path.join(stage, directory), sourceDateEpoch, sourceDateEpoch);
  await writeFile(path.join(stage, 'DEBIAN/control'), `Package: maw-electron-${version.replaceAll('.', '-')}
Version: ${version}
Architecture: ${arch}
Maintainer: Anvilary Workbench Maintainers <maintainers@anvilary.dev>
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libgbm1, libxss1, libxtst6, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libdrm2, libxkbcommon0, libnotify4, libsecret-1-0
Description: Versioned Chromium sandbox runtime for Anvilary Workbench
 Co-installable runtime; no service or user data changes.
`);
  // Ubuntu user-namespace policy for this exact root-owned executable. SUID
  // sandbox remains packaged for hosts using that Chromium sandbox mechanism.
  const profile = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile maw-electron-${version} ${directory}/electron flags=(unconfined) {\n  userns,\n}\n`;
  await mkdir(path.join(stage, 'etc/apparmor.d'), { recursive: true });
  await writeFile(path.join(stage, `etc/apparmor.d/maw-electron-${version}`), profile);
  await writeFile(
    path.join(stage, 'DEBIAN/postinst'),
    `#!/bin/sh
set -e
case "$1" in
  configure)
    if command -v apparmor_parser >/dev/null 2>&1 && test -w /sys/kernel/security/apparmor/.load && test -f /etc/apparmor.d/maw-electron-${version}; then
      apparmor_parser -r /etc/apparmor.d/maw-electron-${version}
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(stage, 'DEBIAN/postrm'),
    `#!/bin/sh
set -e
case "$1" in
  remove|purge)
    if command -v apparmor_parser >/dev/null 2>&1 && test -w /sys/kernel/security/apparmor/.remove; then
      printf 'profile maw-electron-%s {}\\n' '${version}' | apparmor_parser -R >/dev/null 2>&1 || true
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  // Package permissions and mtimes must not inherit a private developer umask or build clock.
  await normalize(path.join(stage, 'DEBIAN'));
  await normalize(path.join(stage, 'etc'));
  await utimes(stage, sourceDateEpoch, sourceDateEpoch);
  const file = path.join(out, `maw-electron-${version}_${arch}.deb`);
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, file], {
    stdio: 'inherit',
    env: { ...process.env, SOURCE_DATE_EPOCH: String(sourceDateEpoch) },
  });
} finally { await rm(stage, { recursive: true, force: true }); }
