// Development launcher only. No installation, systemd, production state.
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, '.native-chatgpt-local');
const runtime = path.join(data, 'runtime');
await mkdir(runtime, { recursive: true, mode: 0o700 });
const lockPath = path.join(data, 'launcher.lock');
const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Prototype launcher is already running. If it crashed, remove .native-chatgpt-local/launcher.lock after checking that its processes have stopped.'); });
await lock.writeFile(String(process.pid));
const readiness = path.join(runtime, 'maw-ready.json');
await unlink(readiness).catch(error => { if (error.code !== 'ENOENT') throw error; });
const log = await open(path.join(data, 'server.log'), 'a', 0o600);
const backend = spawn('pnpm', ['--filter', '@agent-workbench/server', 'dev'], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: {
  ...process.env, XDG_CONFIG_HOME: path.join(data, 'config'), MAW_RUNTIME_DIR: runtime,
  AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1',
  MAW_UNSAFE_LOCAL_NO_AUTH: '',
} });
let desktop;
function stop() {
  if (desktop && desktop.exitCode === null) { try { process.kill(-desktop.pid, 'SIGTERM'); } catch {} }
  try { process.kill(-backend.pid, 'SIGTERM'); } catch {}
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  let url;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (backend.exitCode !== null || backend.signalCode !== null) throw new Error('Isolated backend exited; see .native-chatgpt-local/server.log');
    try { const ready = JSON.parse(await readFile(readiness, 'utf8')); url = ready.url; if (url) break; } catch {}
    await delay(250);
  }
  if (!url) throw new Error('Isolated backend did not become ready; see .native-chatgpt-local/server.log');
  desktop = spawn('pnpm', ['--filter', '@agent-workbench/desktop', 'start'], { cwd: root, detached: true, stdio: 'inherit', env: {
    ...process.env, MAW_DESKTOP_URL: url, MAW_DESKTOP_DATA_DIR: path.join(data, 'chromium'),
  } });
  console.log('Isolated Anvilary Workbench desktop prototype started. Close its window to stop the isolated backend.');
  const code = await new Promise(resolve => desktop.on('exit', resolve));
  process.exitCode = typeof code === 'number' ? code : 1;
} finally {
  stop();
  if (backend.exitCode === null && backend.signalCode === null) await new Promise(resolve => {
    const timeout = setTimeout(() => { try { process.kill(-backend.pid, 'SIGKILL'); } catch {} }, 5000);
    backend.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  await log.close(); await lock.close(); await unlink(lockPath);
}
