// Production only: use the existing user unit and profile, without passing credentials on argv.
import { realpath, readFile, mkdir, lstat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readyService, startCurrentService } from './service-readiness.mjs';
import { assertRuntime } from './desktop-runtime.mjs';
// The Electron GPU process is forked from a zygote that exists before any JavaScript runs, so GL/EGL
// vendor selection can only take effect from the environment Electron is spawned with.
// Older (rollback) releases lack the policy module; they simply launch with the unchanged environment.
async function releaseGraphicsEnv(release) {
  try {
    const policy = await import(pathToFileURL(path.join(release, 'packages/desktop/src/gpu/graphics-policy.mjs')).href);
    return policy.graphicsLaunchEnv(policy.resolveGraphicsPolicy());
  } catch { return {}; }
}
export async function launchProduction({ ready = readyService, startService = startCurrentService, runtime = assertRuntime, graphicsEnv = releaseGraphicsEnv, background = false, dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share') } = {}) {
  let serving;
  try { serving = await ready(); }
  catch {
    await startService();
    const deadline = Date.now() + 20_000;
    while (!serving && Date.now() < deadline) {
      try { serving = await ready(); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!serving) throw new Error('Workbench service did not become ready');
  }
  const { url, state, pid } = serving;
  const release = await realpath(`/proc/${pid}/cwd`);
  const metadata = JSON.parse(await readFile(path.join(release, '.workbench-release-meta.json'), 'utf8'));
  if (metadata.releaseId !== state.releaseId || path.basename(release) !== state.releaseId) throw new Error('Service release identity mismatch');
  const { directory } = await runtime(release);
  const profile = path.resolve(dataHome, 'workbench-desktop');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const info = await lstat(profile);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Unsafe desktop profile');
  await chmod(profile, 0o700);
  const env = { ...await graphicsEnv(release), ...process.env, WORKBENCH_DESKTOP_URL: url.href, WORKBENCH_DESKTOP_DATA_DIR: profile, WORKBENCH_DESKTOP_PRODUCTION: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(path.join(directory, 'electron'), [path.join(release, 'packages/desktop')], { env, stdio: 'ignore', detached: background });
  child.on('error', () => { console.error('Could not launch Workbench desktop.'); process.exitCode = 1; });
  if (background) child.once('spawn', () => child.unref());
  else child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  return child;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) try { await launchProduction({ background: true }); } catch {
  console.error('Workbench desktop is unavailable. Check anvi-bench status; install the matching Ubuntu runtime with scripts/workbench/install.sh --desktop. For a legacy rollback release use the legacy launcher.');
  process.exitCode = 1;
}
