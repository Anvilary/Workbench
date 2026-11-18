import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serviceUrl as defaultServiceUrl } from '../../policy.mjs';

/**
 * Discovers and verifies the active backend readiness descriptor from the user's
 * runtime directory, enforcing regular-file, ownership, 0700/0600 permissions,
 * live PID, and HTTP loopback probe checks.
 */
export async function discoverBackendReadiness({ serviceUrl = defaultServiceUrl } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let file;
  if (process.env.MAW_RUNTIME_DIR) {
    file = path.join(process.env.MAW_RUNTIME_DIR, 'maw-ready.json');
  } else if (process.env.XDG_RUNTIME_DIR) {
    file = path.join(process.env.XDG_RUNTIME_DIR, 'maw', 'maw-ready.json');
  } else if (uid !== null && existsSync(`/run/user/${uid}`)) {
    file = path.join(`/run/user/${uid}`, 'maw', 'maw-ready.json');
  } else {
    file = path.join(os.tmpdir(), 'maw', 'maw-ready.json');
  }

  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid readiness file type');
  if (uid !== null && info.uid !== uid) throw new Error('Unsafe readiness file owner');
  if (info.mode & 0o077) throw new Error('Unsafe readiness file permissions');

  const raw = await readFile(file, 'utf8');
  const state = JSON.parse(raw);
  if (!Number.isInteger(state.pid) || state.pid <= 0) throw new Error('Invalid readiness PID');

  try {
    process.kill(state.pid, 0);
  } catch {
    throw new Error('Service PID not running');
  }

  const parsedUrl = serviceUrl(state.url);
  const probe = await fetch(parsedUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!probe.ok && probe.status !== 401) throw new Error(`Service probe returned ${probe.status}`);

  return { url: parsedUrl, pid: state.pid, state };
}
