import { readFile, realpath, lstat } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

function systemdEnv() {
  const env = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let rdir = process.env.MAW_SYSTEMD_RUNTIME_DIR || '';
  if (!rdir) {
    if (uid !== null && existsSync(`/run/user/${uid}`) && (existsSync(`/run/user/${uid}/systemd/private`) || existsSync(`/run/user/${uid}/bus`))) {
      rdir = `/run/user/${uid}`;
    } else if (process.env.XDG_RUNTIME_DIR && (existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'systemd/private')) || existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'bus')))) {
      rdir = process.env.XDG_RUNTIME_DIR;
    } else if (uid !== null && existsSync(`/run/user/${uid}`)) {
      rdir = `/run/user/${uid}`;
    } else if (process.env.XDG_RUNTIME_DIR) {
      rdir = process.env.XDG_RUNTIME_DIR;
    }
  }

  let bus = process.env.MAW_SYSTEMD_BUS_ADDRESS || '';
  if (!bus) {
    if (rdir && existsSync(path.join(rdir, 'bus'))) {
      bus = `unix:path=${path.join(rdir, 'bus')}`;
    } else if (uid !== null && existsSync(`/run/user/${uid}/bus`)) {
      bus = `unix:path=/run/user/${uid}/bus`;
    }
  }

  if (rdir) env.XDG_RUNTIME_DIR = rdir;
  if (bus) {
    env.DBUS_SESSION_BUS_ADDRESS = bus;
  } else {
    delete env.DBUS_SESSION_BUS_ADDRESS;
  }
  return env;
}

/** A launcher can start the current release; staging and promotion stay explicit. */
export async function startCurrentService() {
  await promisify(execFile)('systemctl', ['--user', 'start', '--no-block', process.env.MAW_UNIT || 'maw.service'],
    { env: systemdEnv(), timeout: 5000 });
}

export async function readyService() {
  let file;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (process.env.MAW_RUNTIME_DIR) {
    file = path.join(process.env.MAW_RUNTIME_DIR, 'maw-ready.json');
  } else if (process.env.XDG_RUNTIME_DIR) {
    file = path.join(process.env.XDG_RUNTIME_DIR, 'maw', 'maw-ready.json');
  } else if (uid !== null && existsSync(`/run/user/${uid}`)) {
    file = path.join(`/run/user/${uid}`, 'maw', 'maw-ready.json');
  } else {
    throw new Error('User runtime directory unavailable');
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Readiness permissions are unsafe');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const unit = process.env.MAW_UNIT || 'maw.service';
  const pid = Number(execFileSync('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { encoding: 'utf8', env: systemdEnv() }).trim());
  if (!Number.isInteger(pid) || pid <= 0 || state.pid !== pid) throw new Error('Service starting, stopped, or stale readiness');
  // Release identity: the activation helper names the release it expects. A server that publishes its
  // release ID must match it exactly; an older server without the field is checked through the working
  // directory systemd gave it (WorkingDirectory=<state>/current, resolved when the process started).
  const expected = process.env.MAW_EXPECT_RELEASE_ID || '';
  if (expected) {
    if (typeof state.releaseId === 'string' || state.releaseId === null) {
      if (state.releaseId !== expected) throw new Error(`Serving release ${state.releaseId}, expected ${expected}`);
    } else if (path.basename(await realpath(`/proc/${pid}/cwd`)) !== expected) {
      throw new Error(`Service working directory is not release ${expected}`);
    }
  }
  const url = new URL(state.url);
  // Loopback only. Either authenticated (?token=...) or token-free local mode.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.hash) {
    throw new Error('Invalid loopback URL');
  }
  const noAuth = !url.searchParams.get('token');
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error('Service is not ready');
  return { url, state, pid, noAuth };
}
