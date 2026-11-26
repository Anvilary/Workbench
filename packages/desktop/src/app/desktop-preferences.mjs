/**
 * Desktop owned preferences that must be known before the app is ready, when
 * the backend is not reachable yet. Stored in `<userData>/desktop-preferences.json`
 * with the same safety rules as download-preferences.json: no symlinks, a 0600
 * file written atomically (temp file + rename). This file is the single source
 * of truth for the keys it holds; they are not mirrored in backend settings.
 *
 * Keys:
 *   hardwareAcceleration: boolean (default true)
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const DESKTOP_PREFS_FILENAME = 'desktop-preferences.json';
const PREFS_VERSION = 1;

function validDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir) && !/[\u0000-\u001f\u007f]/.test(dir);
}

function sanitize(parsed) {
  const prefs = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.hardwareAcceleration === 'boolean') {
    prefs.hardwareAcceleration = parsed.hardwareAcceleration;
  }
  return prefs;
}

/**
 * Synchronous read, safe before app ready. Never throws.
 * @returns {{ prefs: { hardwareAcceleration?: boolean }, state: 'ok'|'missing'|'invalid'|'unreadable', error?: string }}
 */
export function readDesktopPreferences(userDataDir, { fs = nodeFs } = {}) {
  if (!validDir(userDataDir)) return { prefs: {}, state: 'unreadable', error: 'invalid userData path' };
  const file = path.join(path.resolve(userDataDir), DESKTOP_PREFS_FILENAME);
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return { prefs: {}, state: 'invalid', error: 'not a regular file' };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { prefs: {}, state: 'missing' };
    return { prefs: {}, state: 'unreadable', error: error?.code || String(error?.message || error) };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { prefs: {}, state: 'invalid', error: 'not valid JSON' }; }
  const prefs = sanitize(parsed);
  if ('hardwareAcceleration' in (parsed ?? {}) && !('hardwareAcceleration' in prefs)) {
    return { prefs, state: 'invalid', error: 'hardwareAcceleration is not a boolean' };
  }
  return { prefs, state: 'ok' };
}

/**
 * Merges `patch` into the stored preferences and writes them atomically with
 * mode 0600. Returns `{ ok: true }` or `{ ok: false, error }`; never throws.
 */
export function writeDesktopPreferences(userDataDir, patch, { fs = nodeFs, pid = process.pid, now = Date.now } = {}) {
  if (!validDir(userDataDir)) return { ok: false, error: 'invalid userData path' };
  const dir = path.resolve(userDataDir);
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, error: 'userData is not a directory' };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, error: error?.code || 'userData unavailable' };
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (mkdirError) { return { ok: false, error: mkdirError?.code || 'mkdir failed' }; }
  }
  const file = path.join(dir, DESKTOP_PREFS_FILENAME);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) return { ok: false, error: 'preferences path is not a regular file' };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, error: error?.code || 'preferences unavailable' };
  }
  const current = readDesktopPreferences(dir, { fs }).prefs;
  const payload = JSON.stringify({ version: PREFS_VERSION, ...current, ...sanitize(patch) }, null, 2) + '\n';
  const tmp = path.join(dir, `.${DESKTOP_PREFS_FILENAME}.tmp.${pid}.${now()}`);
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: error?.code || 'write failed' };
  }
}
