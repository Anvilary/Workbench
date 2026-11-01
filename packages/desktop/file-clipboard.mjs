import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** file:// URI for a clipboard file list. Spaces stay percent-encoded. */
export function fileUri(absolute) {
  const resolved = path.resolve(absolute);
  return 'file://' + encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * GNOME and URI-list payloads for a copy.
 * text/uri-list uses CR LF. x-special/gnome-copied-files uses the copy verb.
 */
export function fileClipboardPayload(absolute) {
  const uri = fileUri(absolute);
  return {
    uriList: Buffer.from(`${uri}\r\n`, 'utf8'),
    gnome: Buffer.from(`copy\n${uri}\n`, 'utf8'),
  };
}

/**
 * Resolve a relative workspace path and reject anything that leaves it,
 * including a symlink whose target is outside the real workspace directory.
 */
export async function resolveClipboardTarget(cwd, relativePath) {
  if (typeof cwd !== 'string' || typeof relativePath !== 'string') return { ok: false, error: 'invalid' };
  if (!path.isAbsolute(cwd) || !relativePath || relativePath.startsWith('/') || relativePath.includes('\0') || relativePath.includes('~')) {
    return { ok: false, error: 'invalid' };
  }
  let root;
  try {
    root = await realpath(cwd);
  } catch {
    return { ok: false, error: 'missing' };
  }
  const lexical = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, lexical);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return { ok: false, error: 'outside' };
  let info;
  try {
    info = await lstat(lexical);
  } catch {
    return { ok: false, error: 'missing' };
  }
  let target;
  try {
    target = await realpath(lexical);
  } catch {
    return { ok: false, error: 'missing' };
  }
  const stayed = path.relative(root, target);
  if (stayed.startsWith('..') || path.isAbsolute(stayed)) return { ok: false, error: 'outside' };
  let isDir = false;
  try {
    isDir = info.isSymbolicLink() ? (await lstat(target)).isDirectory() : info.isDirectory();
  } catch {
    return { ok: false, error: 'missing' };
  }
  return { ok: true, absolute: target, directory: isDir };
}
