/**
 * Applies bounded zoom adjustments to a native browser WebContents and notifies
 * the renderer UI of the updated percentage.
 */
export function applyWebContentsZoom(id, contents, action, zoomLevels, send) {
  if (!contents || contents.isDestroyed()) return;
  let lvl = contents.getZoomLevel();
  if (action === 'zoom-in') {
    lvl = Math.min(3, Math.round((lvl + 0.5) * 10) / 10);
  } else if (action === 'zoom-out') {
    lvl = Math.max(-3, Math.round((lvl - 0.5) * 10) / 10);
  } else if (action === 'zoom-reset') {
    lvl = 0;
  } else {
    return;
  }
  contents.setZoomLevel(lvl);
  zoomLevels.set(id, lvl);
  let factor;
  try {
    factor = contents.getZoomFactor();
  } catch {
    factor = Math.pow(1.2, lvl);
  }
  if (!Number.isFinite(factor) || factor <= 0) {
    factor = Math.pow(1.2, lvl);
  }
  const percentage = Math.round(factor * 100);
  send({ type: 'browser-zoom', id, zoomFactor: factor, percentage });
}
