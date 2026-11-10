// Production only: use the existing user unit and profile, without passing credentials on argv.
import { realpath, readFile, mkdir, lstat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyService, startCurrentService } from './service-readiness.mjs';
import { assertRuntime } from './desktop-runtime.mjs';
export async function launchProduction({ ready = readyService, startService = startCurrentService, runtime = assertRuntime, background = false, dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share') } = {}) {
  let serving;
  try { serving = await ready(); }
  catch {
    await startService();
    const deadline = Date.now() + 20_000;
    while (!serving && Date.now() < deadline) {
      try { serving = await ready(); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!serving) throw new Error('MaW service did not become ready');
  }
  const { url, state, pid } = serving;
  const release = await realpath(`/proc/${pid}/cwd`);
  const metadata = JSON.parse(await readFile(path.join(release, '.maw-release-meta.json'), 'utf8'));
  if (metadata.releaseId !== state.releaseId || path.basename(release) !== state.releaseId) throw new Error('Service release identity mismatch');
  const { directory } = await runtime(release);
  const profile = path.join(dataHome, 'maw-desktop');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const info = await lstat(profile);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Unsafe desktop profile');
  await chmod(profile, 0o700);
  const env = { ...process.env, MAW_DESKTOP_URL: url.href, MAW_DESKTOP_DATA_DIR: profile, MAW_DESKTOP_PRODUCTION: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(path.join(directory, 'electron'), [path.join(release, 'packages/desktop')], { env, stdio: 'ignore', detached: background });
  child.on('error', () => { console.error('Could not launch MAW desktop.'); process.exitCode = 1; });
  if (background) child.once('spawn', () => child.unref());
  else child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  return child;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) try { await launchProduction({ background: true }); } catch {
  console.error('MAW desktop is unavailable. Check maw status; install the matching Ubuntu runtime with scripts/maw/install.sh --desktop. For a legacy rollback release use maw open.');
  process.exitCode = 1;
}
