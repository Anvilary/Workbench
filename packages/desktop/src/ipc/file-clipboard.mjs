import { workbenchEnv } from '../../../../packages/shared/src/workbench-env.mjs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/** file:// URI for a clipboard file list. Spaces stay percent-encoded. */
export function fileUri(absolute) {
  const resolved = path.resolve(absolute);
  return 'file://' + encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * GNOME and URI-list payloads for a copy.
 * text/uri-list uses CR LF. x-special/gnome-copied-files uses the copy verb
 * without trailing newline (Nautilus requires no empty lines).
 */
export function fileClipboardPayload(absolute) {
  const uri = fileUri(absolute);
  return {
    uriList: Buffer.from(`${uri}\r\n`, 'utf8'),
    gnome: Buffer.from(`copy\n${uri}`, 'utf8'),
  };
}

/**
 * Retrieve authoritative workspace roots from options, env variables, or agency-state.json.
 */
export async function getAuthoritativeRoots(options = {}) {
  const roots = new Set();
  if (options.authoritativeRoots && Array.isArray(options.authoritativeRoots)) {
    for (const r of options.authoritativeRoots) {
      if (typeof r === 'string') {
        try {
          roots.add(await realpath(r));
        } catch {
          // Ignore missing roots
        }
      }
    }
  }

  const envSingle = workbenchEnv('WORKSPACE_ROOT');
  if (envSingle) {
    try {
      roots.add(await realpath(envSingle));
    } catch {}
  }

  const envMulti = workbenchEnv('WORKSPACE_ROOTS');
  if (envMulti) {
    const delimiter = process.platform === 'win32' ? ';' : /[:;,]/;
    for (const part of envMulti.split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed) {
        try {
          roots.add(await realpath(trimmed));
        } catch {}
      }
    }
  }

  const statePath = options.statePath ?? (
    workbenchEnv('STATE_PATH') ?? (
      process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'workbench', 'agency-state.json')
        : path.join(process.env.HOME ?? '', '.config', 'workbench', 'agency-state.json')
    )
  );
  try {
    const raw = await readFile(statePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.workspaces)) {
      for (const ws of data.workspaces) {
        if (typeof ws.cwd === 'string') {
          try {
            roots.add(await realpath(ws.cwd));
          } catch {}
        }
      }
    }
  } catch {}

  return Array.from(roots);
}

/**
 * Resolve a relative workspace path and reject anything that leaves it,
 * including a symlink whose target is outside the real workspace directory,
 * or a cwd that is not within an authoritative workspace root.
 */
export async function resolveClipboardTarget(cwd, relativePath, options = {}) {
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

  if (options.requireAuthoritative || options.authoritativeRoots) {
    const authRoots = await getAuthoritativeRoots(options);
    if (authRoots.length === 0) {
      return { ok: false, error: 'denied' };
    }
    const isUnderAuthRoot = authRoots.some((ar) => {
      const rel = path.relative(ar, root);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!isUnderAuthRoot) {
      return { ok: false, error: 'denied' };
    }
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
