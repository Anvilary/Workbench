import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomically } from './shared/persistence/atomic-write.js';

/** Linux abstract socket: kernel releases ownership on crash/reboot, no stale PID guessing. */
export async function acquireStoreOwnership(directory: string): Promise<Server | null> {
  if (process.platform !== 'linux') return null;
  // Do not create the destination before the legacy-config migration runs.
  let ancestor = path.resolve(directory);
  const suffix: string[] = [];
  let canonical: string;
  for (;;) {
    try { canonical = path.join(await realpath(ancestor), ...suffix); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const key = createHash('sha256').update(canonical).digest('hex');
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen('\0workbench-store-' + key, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

/**
 * The Workbench release this process was started from, as written by `maw update` into the release root.
 * `null` when running from a source checkout (no release metadata) or when the metadata is unusable.
 * Read once at startup: the process stays pinned to its release even if `current` is switched later.
 */
export async function readReleaseIdentity(root: string): Promise<string | null> {
  try {
    const meta: unknown = JSON.parse(await readFile(path.join(root, '.workbench-release-meta.json'), 'utf8'));
    const id = typeof meta === 'object' && meta !== null ? (meta as { releaseId?: unknown }).releaseId : undefined;
    return typeof id === 'string' && /^[0-9]{14}-[0-9a-f]{4,40}(-[0-9]+)?$/.test(id) && id === path.basename(root) ? id : null;
  } catch { return null; }
}

export async function publishReadiness(directory: string, url: string, releaseId: string | null = null): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'workbench-ready.json');
  await writeAtomically(file, Buffer.from(JSON.stringify({ pid: process.pid, url, releaseId }) + '\n'), { mode: 0o600 });
  return () => rm(file, { force: true });
}
