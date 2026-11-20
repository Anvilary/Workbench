/**
 * Native view attachment and layout.
 *
 * Owns which native views are attached to the window, their bounds and the
 * focus bookkeeping that goes with them. The views themselves and their
 * lifecycle belong to the BrowserViewController, which creates this module and
 * gives it the shared state.
 */

import { nativeBoundsForRect } from '../../policy.mjs';

export function createViewLayout({ win, send, state }) {
  const { views, attachedViews, lastAccessedAt } = state;

  function hideAll() {
    for (const [id, view] of attachedViews) {
      if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
        try { win.contentView.removeChildView(view); } catch {}
        try { view.setVisible(false); } catch {}
        try { view.webContents.setBackgroundThrottling(true); } catch {}
      }
    }
    attachedViews.clear();
  }

  function hide(id) {
    if (id) {
      const view = attachedViews.get(id);
      if (view) {
        if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
          try { win.contentView.removeChildView(view); } catch {}
          try { view.setVisible(false); } catch {}
          try { view.webContents.setBackgroundThrottling(true); } catch {}
        }
        attachedViews.delete(id);
      }
    } else {
      hideAll();
    }
  }


  function invalidate() { hideAll(); send({ type: 'layout-needed' }); }

  /** Centralized multi-WebContentsView layout coordinator (atomic reconciliation). */
  function applyLayout(command) {
    const focusedId = 'focusedId' in command ? command.focusedId : command.id ?? null;
    if (focusedId) lastAccessedAt.set(focusedId, Date.now());
    const focusChanged = focusedId !== state.layoutFocusedId;
    state.layoutFocusedId = focusedId;
    if (focusChanged) state.reportedFocusedId = focusedId;
    const targetViews = Array.isArray(command.views)
      ? command.views
      : (command.id && command.bounds ? [{ id: command.id, bounds: command.bounds }] : []);

    for (const item of targetViews) {
      lastAccessedAt.set(item.id, Date.now());
    }

    if (win.isMinimized() || targetViews.length === 0) {
      hideAll();
      return;
    }

    const contentSize = win.getContentSize();
    const zoom = win.webContents.getZoomFactor();
    const targetIds = new Set(targetViews.map(v => v.id));

    // 1. Detach views no longer visible
    for (const [attachedId, attachedView] of [...attachedViews.entries()]) {
      if (!targetIds.has(attachedId)) {
        win.contentView.removeChildView(attachedView);
        attachedView.setVisible(false);
        if (!attachedView.webContents.isDestroyed()) {
          try { attachedView.webContents.setBackgroundThrottling(true); } catch {}
        }
        attachedViews.delete(attachedId);
      }
    }

    // 2. Attach and update bounds for visible views
    for (const item of targetViews) {
      const view = views.get(item.id);
      if (!view || view.webContents.isDestroyed()) continue;

      const bounds = nativeBoundsForRect(item.bounds, command.viewport, contentSize, zoom);
      if (!bounds) continue;

      if (!attachedViews.has(item.id)) {
        win.contentView.addChildView(view);
        attachedViews.set(item.id, view);
      }

      view.setBounds(bounds);
      view.setVisible(true);
      try { view.webContents.setBackgroundThrottling(false); } catch {}
    }

    // Geometry updates and overlay restoration must preserve focus in MAW controls.
    if (focusChanged && focusedId && attachedViews.has(focusedId)) {
      const focusedView = attachedViews.get(focusedId);
      if (focusedView && !focusedView.webContents.isDestroyed() && !focusedView.webContents.isFocused()) {
        focusedView.webContents.focus();
      }
    }
  }

  return { hide, hideAll, invalidate, applyLayout };
}
