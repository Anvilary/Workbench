/** Native state metadata only; never open credential files or conversation contents. */
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativeIdentity } from './native-identity.js';
import { findReadableRollout } from '../agents/codex/find-rollout.js';
import { projectSlugFor } from '../agents/claude-code/paths.js';

export async function ownsNativeSession(identity: NativeIdentity, id: string, cwd: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  let files: string[];
  if (identity.provider === 'codex') {
    const file = await findReadableRollout(id, { sessionsRoot: path.join(identity.home, 'sessions'), archivedRoot: path.join(identity.home, 'archived_sessions') });
    files = file ? [file] : [];
  } else if (identity.provider === 'antigravity') {
    files = ['db', 'pb'].map(extension => path.join(identity.home, 'conversations', id + '.' + extension));
  } else {
    files = [path.join(identity.home, 'projects', projectSlugFor(cwd), id + '.jsonl')];
  }
  for (const file of files) {
    try {
      const canonical = await realpath(file);
      const relative = path.relative(identity.home, canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const info = await stat(canonical);
      if (!info.isFile() || info.size === 0 || (process.getuid && info.uid !== process.getuid())) continue;
      await access(canonical, constants.R_OK);
      return true;
    } catch { /* Missing, unreadable, or escaped native state is not ownership evidence. */ }
  }
  return false;
}
