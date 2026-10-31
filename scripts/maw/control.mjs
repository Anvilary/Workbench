import { spawn } from 'node:child_process';
import { readyService } from './service-readiness.mjs';

try {
  const { url, state, pid, noAuth } = await readyService();
  const release = typeof state.releaseId === 'string' ? `; release ${state.releaseId}` : '';
  const modeLabel = noAuth ? '; token-free local mode (MAW_UNSAFE_LOCAL_NO_AUTH=1)' : '';
  if (process.argv[2] === 'status') {
    console.log(`Healthy; PID ${pid}; loopback port ${url.port}${release}${modeLabel}`);
    console.log(`URL: ${url.origin}/`);
  }
  else if (process.argv[2] === 'url') console.log(noAuth ? url.origin + '/' : url.href);
  else if (process.argv[2] === 'open') {
    const browser = process.argv[3] || 'xdg-open';
    const child = spawn(browser, [url.href], { stdio: 'ignore' });
    child.on('error', () => { console.error('Could not open browser'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  } else throw new Error('Unknown control command');
} catch (err) {
  console.error('MAW is not ready. Use maw status and maw logs to inspect startup.');
  process.exitCode = 1;
}
