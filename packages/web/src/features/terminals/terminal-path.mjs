/**
 * Turn a terminal selection into a workspace-relative path.
 * The text is never passed to a shell. Quotes are unwrapped once.
 * `~`, newlines, and shell metacharacters are rejected.
 */

function unwrap(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function terminalPathCandidate(selection, cwd) {
  if (typeof selection !== 'string' || typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return { ok: false, error: 'invalid' };
  }
  const text = unwrap(selection);
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'invalid' };
  if (text.includes('~') || /[|&;`$<>]/.test(text) || text.includes('\\')) return { ok: false, error: 'invalid' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return { ok: false, error: 'invalid' };

  const root = cwd.replace(/\/+$/, '') || '/';
  const combined = text.startsWith('/') ? text : `${root}/${text}`;
  const parts = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return { ok: false, error: 'outside' };
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const absolute = `/${parts.join('/')}`;
  if (absolute !== root && !absolute.startsWith(`${root}/`)) return { ok: false, error: 'outside' };
  const relative = absolute === root ? '' : absolute.slice(root.length + 1);
  if (!relative) return { ok: false, error: 'directory' };
  return { ok: true, relative, absolute };
}
