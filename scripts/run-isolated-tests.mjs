import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'workbench-tests-'));
const home = path.join(root, 'home');
const testControls = new Set([
  'WORKBENCH_CODEX_EXECUTABLE',
  'WORKBENCH_CODEX_SOAK_SECONDS',
  'WORKBENCH_ELECTRON_EXECUTABLE',
  'WORKBENCH_NAUTILUS_TEST_ISOLATED',
  'WORKBENCH_TEST_NO_CHROMIUM_SANDBOX',
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
  const key = name.toUpperCase();
  return testControls.has(key) || !/^(?:MAW_|WORKBENCH_|AGENT_WORKBENCH_|ELECTRON_RUN_AS_NODE$)/.test(key);
}));

// Browser installation is a prerequisite of the tests and lives outside the disposable home.
const browserCache = process.platform === 'win32'
  ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
  : process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Caches')
    : process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(browserCache, 'ms-playwright');
const directories = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_HOME: path.join(home, '.codex'),
};
Object.assign(env, directories);

try {
  await Promise.all(Object.values(directories).map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const args = process.argv.slice(2);
  const executable = args[0] === '--sh' ? (args.shift(), '/bin/sh') : process.execPath;
  const child = spawn(executable, args, { env, stdio: 'inherit' });
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
