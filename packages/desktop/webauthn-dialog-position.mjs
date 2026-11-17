/**
 * Calculates screen-space position for the PIN dialog relative to originating pane or parent window.
 * @param {object} params
 * @param {{ x: number, y: number, width: number, height: number }} params.contentBounds
 * @param {{ x: number, y: number, width: number, height: number }|null} [params.paneBounds]
 * @param {number} [params.dialogWidth]
 * @param {number} [params.dialogHeight]
 * @returns {{ x: number, y: number }}
 */
export function calculatePinDialogPosition({
  contentBounds,
  paneBounds = null,
  dialogWidth = 400,
  dialogHeight = 230,
}) {
  if (paneBounds && typeof paneBounds.x === 'number' && typeof paneBounds.width === 'number') {
    const screenPaneX = contentBounds.x + paneBounds.x;
    const screenPaneY = contentBounds.y + paneBounds.y;
    return {
      x: Math.round(screenPaneX + (paneBounds.width - dialogWidth) / 2),
      y: Math.round(screenPaneY + 40),
    };
  }
  return {
    x: Math.round(contentBounds.x + (contentBounds.width - dialogWidth) / 2),
    y: Math.round(contentBounds.y + (contentBounds.height - dialogHeight) / 2),
  };
}
