import { realpath } from 'node:fs/promises';
import path from 'node:path';
/** Missing files may appear later; existing symlinks must never escape the attested namespace. */
export async function withinNativeScope(root: string, file: string): Promise<boolean> {
  try {
    const relative = path.relative(root, await realpath(file));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
