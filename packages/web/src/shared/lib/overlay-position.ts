export interface ViewportPlacementParams {
  triggerRect: { left: number; top: number; right: number; bottom: number };
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  offset?: number;
}

/**
 * Computes fixed viewport coordinates for a dropdown menu anchored to a trigger,
 * flipping horizontally or vertically when it would overflow the viewport.
 */
export function calculateSidebarDropdownPosition(params: ViewportPlacementParams): { left: number; top: number } {
  const { triggerRect, menuWidth, menuHeight, viewportWidth, viewportHeight } = params;
  const margin = params.margin ?? 8;
  const offset = params.offset ?? 4;

  let left = triggerRect.left;
  if (left + menuWidth > viewportWidth - margin) {
    left = triggerRect.right - menuWidth;
  }
  if (left < margin) {
    left = margin;
  }
  if (left + menuWidth > viewportWidth - margin) {
    left = Math.max(margin, viewportWidth - menuWidth - margin);
  }

  let top: number;
  if (triggerRect.bottom + menuHeight + margin <= viewportHeight) {
    top = triggerRect.bottom + offset;
  } else if (triggerRect.top - menuHeight - margin >= 0) {
    top = triggerRect.top - menuHeight - offset;
  } else {
    top = Math.max(margin, viewportHeight - menuHeight - margin);
  }

  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Clamps a viewport-anchored menu below or above its trigger button.
 */
export function calculateViewportMenuPosition(params: ViewportPlacementParams): { left: number; top: number } {
  const { triggerRect, menuWidth, menuHeight, viewportWidth, viewportHeight } = params;
  const margin = params.margin ?? 8;
  const offset = params.offset ?? 4;

  const left = Math.max(margin, Math.min(triggerRect.left, viewportWidth - menuWidth - margin));
  const top = Math.max(
    margin,
    triggerRect.bottom + menuHeight + margin <= viewportHeight
      ? triggerRect.bottom + offset
      : Math.min(triggerRect.top - menuHeight - offset, viewportHeight - menuHeight - margin),
  );

  return { left, top };
}
