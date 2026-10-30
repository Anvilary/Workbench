import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
export async function runtimeFor(release) {
  const pkg = JSON.parse(await readFile(path.join(release, 'packages/desktop/package.json'), 'utf8'));
  const version = pkg.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Desktop runtime version must be pinned');
  return { version, directory: `/opt/maw-electron/${version}` };
}
export async function assertRuntime(release) {
  const runtime = await runtimeFor(release);
  for (const file of ['/opt', '/opt/maw-electron', runtime.directory, path.join(runtime.directory, 'electron'), path.join(runtime.directory, 'chrome-sandbox')]) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || await realpath(file) !== file) throw new Error('Unsafe desktop runtime installation');
    if (file.endsWith('/chrome-sandbox') && (info.mode & 0o4777) !== 0o4755) throw new Error('Desktop sandbox is not installed correctly');
  }
  return runtime;
}

export async function assertLauncher() {
  const lib = process.env.MAW_LIB_DIR || path.join(homedir(), '.local/lib/maw');
  if ((await readFile(path.join(lib, 'desktop-launcher-api'), 'utf8')).trim() !== '1') throw new Error('Desktop launcher is not installed');
  for (const file of ['maw', 'desktop-launch.mjs', 'service-readiness.mjs', 'desktop-runtime.mjs']) {
    if (!(await lstat(path.join(lib, file))).isFile()) throw new Error('Desktop launcher installation is incomplete');
  }
}
