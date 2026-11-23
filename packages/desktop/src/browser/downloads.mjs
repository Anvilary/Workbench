import fs from 'node:fs';
import path from 'node:path';
import { isSameSite, parseBlobDownloadUrl } from '../../policy.mjs';

const DOWNLOAD_PREFS_FILENAME = 'download-preferences.json';

function tryGetAppPath(app, name) {
  try {
    if (typeof app?.getPath === 'function') {
      const value = app.getPath(name);
      return typeof value === 'string' ? value : '';
    }
  } catch {}
  return '';
}

export function isWritableDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath || !path.isAbsolute(dirPath) || /[\u0000-\u001f\u007f]/.test(dirPath)) {
    return false;
  }
  try {
    const resolved = path.resolve(dirPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return false;
    fs.accessSync(resolved, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveDefaultDownloadsDirectory(app) {
  const configured = tryGetAppPath(app, 'downloads');
  try {
    const home = tryGetAppPath(app, 'home');
    if (configured && home && path.resolve(configured) === path.resolve(home)) {
      const candidate = path.join(home, 'Downloads');
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  } catch {}
  return configured;
}

export function readRememberedDownloadDirectory(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir || !path.isAbsolute(userDataDir) || /[\u0000-\u001f\u007f]/.test(userDataDir)) {
    return null;
  }
  try {
    const resolvedUserData = path.resolve(userDataDir);
    const dirStat = fs.lstatSync(resolvedUserData);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;

    const prefPath = path.join(resolvedUserData, DOWNLOAD_PREFS_FILENAME);
    const prefStat = fs.lstatSync(prefPath);
    if (prefStat.isSymbolicLink() || !prefStat.isFile()) return null;

    const parsed = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    const candidate = parsed?.lastDownloadDirectory;
    if (!isWritableDirectory(candidate)) return null;
    return path.resolve(candidate);
  } catch {
    return null;
  }
}

export function writeRememberedDownloadDirectory(userDataDir, directoryPath) {
  if (typeof userDataDir !== 'string' || !userDataDir || !path.isAbsolute(userDataDir) || /[\u0000-\u001f\u007f]/.test(userDataDir)) {
    return false;
  }
  if (!isWritableDirectory(directoryPath)) return false;

  const resolvedUserData = path.resolve(userDataDir);
  try {
    const dirStat = fs.lstatSync(resolvedUserData);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
    fs.mkdirSync(resolvedUserData, { recursive: true, mode: 0o700 });
  }

  const prefPath = path.join(resolvedUserData, DOWNLOAD_PREFS_FILENAME);
  try {
    const existingStat = fs.lstatSync(prefPath);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
  }

  const payload = JSON.stringify({
    version: 1,
    lastDownloadDirectory: path.resolve(directoryPath),
  }, null, 2) + '\n';
  const tmpPath = path.join(resolvedUserData, `.${DOWNLOAD_PREFS_FILENAME}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, prefPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

export function resolveDownloadsDirectory(app, { userDataDir } = {}) {
  const effectiveUserDataDir = userDataDir ?? tryGetAppPath(app, 'userData');
  const remembered = effectiveUserDataDir ? readRememberedDownloadDirectory(effectiveUserDataDir) : null;
  if (remembered) return remembered;
  return resolveDefaultDownloadsDirectory(app);
}

export function rememberCompletedDownloadPath(savedFilePath, { app, userDataDir } = {}) {
  if (typeof savedFilePath !== 'string' || !savedFilePath || !path.isAbsolute(savedFilePath) || /[\u0000-\u001f\u007f]/.test(savedFilePath)) {
    return false;
  }
  try {
    const resolvedFile = path.resolve(savedFilePath);
    if (!fs.statSync(resolvedFile).isFile()) return false;
    const effectiveUserDataDir = userDataDir ?? tryGetAppPath(app, 'userData');
    if (!effectiveUserDataDir) return false;
    return writeRememberedDownloadDirectory(effectiveUserDataDir, path.dirname(resolvedFile));
  } catch {
    return false;
  }
}

export function sanitizeDownloadFilename(rawName) {
  if (typeof rawName !== 'string') return 'download';
  const lastSegment = rawName.split(/[/\\]/).pop() || '';
  let clean = lastSegment
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[:*?"<>|/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!clean || clean === '.' || clean === '..' || /^[._]+$/.test(clean)) {
    return 'download';
  }
  if (clean.startsWith('.')) {
    clean = `download${clean}`;
  }
  if (clean.length > 200) {
    const ext = path.extname(clean);
    const safeExt = ext && ext.length <= 32 ? ext : '';
    const stem = safeExt ? clean.slice(0, -safeExt.length) : clean;
    clean = `${stem.slice(0, 200 - safeExt.length)}${safeExt}`;
  }
  return clean || 'download';
}

export function formatDuplicateFilename(safeName, index) {
  if (!index || index <= 0) return safeName;
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  return `${stem} (${index})${ext}`;
}

export function allocateDownloadTarget(dir, safeName, reservedPaths = new Set()) {
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) {
    throw new Error('Downloads directory is unavailable');
  }
  const resolvedDir = path.resolve(dir);
  const dirStat = fs.statSync(resolvedDir);
  if (!dirStat.isDirectory()) {
    throw new Error('Downloads destination is not a directory');
  }
  fs.accessSync(resolvedDir, fs.constants.W_OK | fs.constants.X_OK);

  for (let index = 0; index < 10_000; index++) {
    const filename = formatDuplicateFilename(safeName, index);
    const targetPath = path.resolve(resolvedDir, filename);
    if (path.dirname(targetPath) !== resolvedDir || path.basename(targetPath) !== filename) {
      throw new Error('Invalid download target path');
    }
    if (reservedPaths.has(targetPath)) continue;
    let exists = false;
    for (const candidate of [targetPath, `${targetPath}.crdownload`]) {
      try {
        fs.lstatSync(candidate);
        exists = true;
        break;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    if (exists) continue;
    reservedPaths.add(targetPath);
    return { filename, targetPath };
  }
  throw new Error('Too many duplicate download filenames');
}

function resolveBlobContextOrigin(initiator, contents, ownerContents) {
  if (initiator) return initiator;
  for (const target of [contents, ownerContents]) {
    try {
      const current = typeof target?.getURL === 'function' ? (target.getURL() || '') : '';
      if (current && current !== 'about:blank') return current;
    } catch {}
  }
  return null;
}

/** Register only validated downloads and release each registration exactly once. */
export function browserDownloadHandler({
  provider, views, providers, popupOwners, popups, activeDownloads,
  reservedPaths = new Set(),
  allowedOrigin, allowedDestination,
  windowForContents, downloadsDirectory, autoSave = () => false,
  rememberDownloadDirectory = null,
  send, ready,
}) {
  return (event, item, contents) => {
    const id = [...views].find(([, view]) => view.webContents === contents)?.[0] ?? popupOwners.get(contents);
    if (!id || !views.has(id) || providers.get(id) !== provider) {
      event.preventDefault();
      return;
    }

    const safeName = sanitizeDownloadFilename(typeof item.getFilename === 'function' ? item.getFilename() : '');
    const initiator = typeof item.getInitiatorOrigin === 'function' ? item.getInitiatorOrigin() : null;
    const url = typeof item.getURL === 'function' ? item.getURL() : '';
    const rawChain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
    const chain = Array.isArray(rawChain) && rawChain.length > 0 ? rawChain : (url ? [url] : []);

    const ownerContents = views.get(id)?.webContents;
    const blobUrls = chain.filter(entry => typeof entry === 'string' && entry.startsWith('blob:'));
    let blobOriginValid = true;
    if (blobUrls.length > 0) {
      if (chain.length !== 1) {
        blobOriginValid = false;
      } else {
        const blob = parseBlobDownloadUrl(blobUrls[0]);
        if (!blob || !allowedOrigin(blob.origin)) {
          blobOriginValid = false;
        } else {
          const contextOrigin = resolveBlobContextOrigin(initiator, contents, ownerContents);
          if (contextOrigin) {
            try {
              const ctxOrigin = new URL(contextOrigin).origin;
              if (ctxOrigin !== blob.origin && !(provider !== 'other' && isSameSite(ctxOrigin, blob.origin))) {
                blobOriginValid = false;
              }
            } catch {
              blobOriginValid = false;
            }
          }
        }
      }
    }

    if (
      (initiator && !allowedOrigin(initiator)) ||
      chain.length === 0 ||
      !chain.every(allowedDestination) ||
      !blobOriginValid
    ) {
      event.preventDefault();
      send({ type: 'download-failed', id, filename: safeName, reason: 'blocked' });
      return;
    }

    let finalName = safeName;
    let target;
    let reservedTarget = null;
    const saveAutomatically = Boolean(autoSave());
    try {
      const allocated = allocateDownloadTarget(downloadsDirectory(), safeName, reservedPaths);
      finalName = allocated.filename;
      target = allocated.targetPath;
      reservedTarget = allocated.targetPath;
      if (saveAutomatically) item.setSavePath(target);
      else item.setSaveDialogOptions({ defaultPath: target, title: 'Save File' });
    } catch {
      if (reservedTarget) reservedPaths.delete(reservedTarget);
      event.preventDefault();
      send({ type: 'download-failed', id, filename: safeName, reason: 'destination-unavailable' });
      return;
    }

    activeDownloads.set(id, (activeDownloads.get(id) ?? 0) + 1);
    const popup = typeof windowForContents === 'function' ? windowForContents(contents) : null;
    if (popup && popups.has(popup)) popup.hide();
    send({ type: 'download-start', id, filename: finalName });

    let settled = false;
    let interrupted = false;
    const onOwnerGone = () => finalize('interrupted');
    if (ownerContents && typeof ownerContents.once === 'function') {
      ownerContents.once('destroyed', onOwnerGone);
      ownerContents.once('render-process-gone', onOwnerGone);
    }

    function finalize(state) {
      if (settled) return;
      settled = true;
      if (reservedTarget) reservedPaths.delete(reservedTarget);
      if (ownerContents && typeof ownerContents.removeListener === 'function') {
        ownerContents.removeListener('destroyed', onOwnerGone);
        ownerContents.removeListener('render-process-gone', onOwnerGone);
      }
      const remaining = (activeDownloads.get(id) ?? 1) - 1;
      if (remaining > 0) activeDownloads.set(id, remaining);
      else activeDownloads.delete(id);
      if (popup && popups.has(popup) && !popup.isDestroyed()) popup.close();
      const effectiveState = interrupted ? 'interrupted' : state;
      const type = effectiveState === 'completed'
        ? 'download-complete'
        : effectiveState === 'cancelled'
          ? 'download-cancelled'
          : 'download-failed';
      const actualSavePath = typeof item.getSavePath === 'function' ? item.getSavePath() : '';
      const savePath = effectiveState === 'completed'
        ? (actualSavePath || (saveAutomatically ? target : ''))
        : undefined;
      const reportedName = actualSavePath ? sanitizeDownloadFilename(path.basename(actualSavePath)) : finalName;
      if (effectiveState === 'completed' && savePath && typeof rememberDownloadDirectory === 'function') {
        try {
          rememberDownloadDirectory(savePath);
        } catch {}
      }
      send({
        type,
        id,
        filename: reportedName,
        ...(savePath ? { savePath } : {}),
        ...(type === 'download-failed' ? { reason: effectiveState } : {}),
      });
      ready(id);
    }

    item.on('updated', (_event, state) => {
      if (settled) return;
      if (state === 'progressing') {
        const total = typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0;
        send({
          type: 'download-progress',
          id,
          filename: finalName,
          percent: total > 0 ? Math.round(item.getReceivedBytes() / total * 100) : null,
        });
      } else if (state === 'interrupted') {
        interrupted = true;
        if (typeof item.cancel === 'function') item.cancel();
        finalize('interrupted');
      }
    });
    item.once('done', (_event, state) => finalize(state));
  };
}
