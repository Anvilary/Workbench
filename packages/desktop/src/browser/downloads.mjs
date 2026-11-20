import path from 'node:path';

/** Register only validated downloads and release each registration exactly once. */
export function browserDownloadHandler({ provider, views, providers, popupOwners, popups, activeDownloads,
  allowedOrigin, allowedDestination, windowForContents, downloadsDirectory, autoSave, send, ready }) {
  return (event, item, contents) => {
    const id = [...views].find(([, view]) => view.webContents === contents)?.[0] ?? popupOwners.get(contents);
    const initiator = typeof item.getInitiatorOrigin === 'function' ? item.getInitiatorOrigin() : null;
    const chain = [item.getURL(), ...(item.getURLChain?.() ?? [])];
    if (!id || !views.has(id) || providers.get(id) !== provider ||
        (initiator && !allowedOrigin(initiator)) || !chain.every(allowedDestination)) {
      event.preventDefault();
      return;
    }

    const filename = path.basename(item.getFilename() || 'download').replace(/[\u0000-\u001f\u007f\\/:]/g, '_').trim();
    const safeName = !filename || filename === '.' || filename === '..' ? 'download' : filename;
    const target = path.join(downloadsDirectory(), safeName);
    if (autoSave()) item.setSavePath(target);
    else item.setSaveDialogOptions({ defaultPath: target, title: 'Save File' });

    activeDownloads.set(id, (activeDownloads.get(id) ?? 0) + 1);
    const popup = windowForContents(contents);
    if (popup && popups.has(popup)) popup.hide();
    send({ type: 'download-start', id, filename: safeName });
    item.on('updated', (_event, state) => {
      if (state === 'progressing') {
        const total = item.getTotalBytes();
        send({ type: 'download-progress', id, filename: safeName,
          percent: total > 0 ? Math.round(item.getReceivedBytes() / total * 100) : null });
      } else if (state === 'interrupted' && !item.canResume()) item.cancel();
    });
    item.once('done', (_event, state) => {
      const remaining = (activeDownloads.get(id) ?? 1) - 1;
      if (remaining > 0) activeDownloads.set(id, remaining);
      else activeDownloads.delete(id);
      if (popup && popups.has(popup) && !popup.isDestroyed()) popup.close();
      const type = state === 'completed' ? 'download-complete' : state === 'cancelled' ? 'download-cancelled' : 'download-failed';
      send({ type, id, filename: safeName, ...(state === 'completed' ? { savePath: item.getSavePath() } : {}) });
      ready(id);
    });
  };
}
