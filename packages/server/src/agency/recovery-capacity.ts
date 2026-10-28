import { readdir, readFile, stat } from 'node:fs/promises';
import type { CliProvider } from '@agent-workbench/shared';
/** Conservative observation of existing same-user AGY processes; never signal them. */
export async function nativeRecoveryCapacity(provider: CliProvider, procRoot = '/proc'): Promise<boolean> {
  if (provider !== 'antigravity') return true;
  if (process.platform !== 'linux' || !process.getuid) return false;
  try {
    let count = 0;
    for (const pid of await readdir(procRoot)) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if ((await stat(procRoot + '/' + pid)).uid !== process.getuid()) continue;
        if (/^agy(?:0[0-5])?$/.test((await readFile(procRoot + '/' + pid + '/comm', 'utf8')).trim())) count++;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      }
      if (count >= 4) return false;
    }
    return true;
  } catch { return false; }
}
