/** Where a dragged tab would be inserted, using the horizontal midpoint of each tab. */
export function insertionIndex(clientX, rects) {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (clientX < rect.left + rect.width / 2) return index;
  }
  return rects.length;
}

/**
 * Pixel shift for a neighboring tab while a drag is in progress.
 * The dragged tab itself stays put. Tabs between the source and the
 * insertion index slide by one tab width so the gap is visible.
 */
export function tabShift(index, sourceIndex, overIndex, width, samePane) {
  if (!Number.isFinite(width) || width <= 0 || overIndex == null || overIndex < 0) return 0;
  if (samePane) {
    if (index === sourceIndex) return 0;
    if (sourceIndex < overIndex && index > sourceIndex && index < overIndex) return -width;
    if (overIndex < sourceIndex && index >= overIndex && index < sourceIndex) return width;
    return 0;
  }
  return index >= overIndex ? width : 0;
}
