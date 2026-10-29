import { readFile, stat } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

try {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !path.isAbsolute(runtime)) throw new Error('User runtime directory unavailable');
  const file = path.join(runtime, 'maw', 'maw-ready.json');
  const info = await stat(file);
  if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Readiness permissions are unsafe');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const pid = Number(execFileSync('systemctl', ['--user', 'show', 'maw.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(pid) || pid <= 0 || state.pid !== pid) throw new Error('Service starting, stopped, or stale readiness');
  const url = new URL(state.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !url.searchParams.get('token') || url.username || url.password) throw new Error('Invalid authenticated loopback URL');
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error('Service is not ready');
  if (process.argv[2] === 'status') console.log(`Healthy; PID ${pid}; loopback port ${url.port}`);
  else if (process.argv[2] === 'url') console.log(url.href);
  else if (process.argv[2] === 'open') {
    const browser = process.argv[3] || 'xdg-open';
    const child = spawn(browser, [url.href], { stdio: 'ignore' });
    child.on('error', () => { console.error('Could not open browser'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  } else throw new Error('Unknown control command');
} catch {
  console.error('MAW is not ready. Use maw status and maw logs to inspect startup.');
  process.exitCode = 1;
}
