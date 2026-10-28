import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomically } from './atomic-write.js';

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
    server.listen('\0maw-store-' + key, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

export async function publishReadiness(directory: string, url: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'maw-ready.json');
  await writeAtomically(file, Buffer.from(JSON.stringify({ pid: process.pid, url }) + '\n'), { mode: 0o600 });
  return () => rm(file, { force: true });
}
