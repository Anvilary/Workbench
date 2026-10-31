export interface NativeViewRegistration {
  id: string;
  element: HTMLElement;
  onDisplayed: (ready: boolean) => void;
  setCaptureBackdrop: (dataUrl: string | null) => void;
  onError?: (message: string) => void;
  onDownloadEvent?: (event: { type: string; filename?: string; percent?: number | null; message?: string }) => void;
}

function hasIntersectingOverlay(viewBounds: { left: number; top: number; right: number; bottom: number }): boolean {
  if (viewBounds.right <= viewBounds.left || viewBounds.bottom <= viewBounds.top) return false;
  const items = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], .agency-modal-backdrop, .agency-dropdown-menu, .maw-toast-item, .context-menu, .agency-dialog, .maw-context-menu'
  );
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const rects = item.getClientRects();
    if (rects.length === 0) continue;
    const style = window.getComputedStyle(item);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j]!;
      if (r.width <= 0 || r.height <= 0) continue;
      if (
        r.left < viewBounds.right &&
        r.right > viewBounds.left &&
        r.top < viewBounds.bottom &&
        r.bottom > viewBounds.top
      ) {
        return true;
      }
    }
  }
  return false;
}

type TrackedView = NativeViewRegistration & {
  isReady: boolean;
  hasBackdrop: boolean;
  /** Bumped to invalidate an in-flight capturePage result. */
  captureEpoch: number;
  capturePending: boolean;
  backdropApplied: boolean;
  nativeVisible: boolean;
  captureBounds: string;
};

class NativeLayoutCoordinator {
  private readonly views = new Map<string, TrackedView>();
  private frame = 0;
  private lastSerialized = '';
  private observer: MutationObserver | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  private focusedId: string | null = null;

  /** Drop a capture that must not land on a visible view, and release its bitmap. */
  private cancelCapture(entry: TrackedView): void {
    if (!entry.capturePending && !entry.hasBackdrop && !entry.backdropApplied) return;
    entry.captureEpoch += 1;
    entry.capturePending = false;
    entry.hasBackdrop = false;
    if (entry.backdropApplied) {
      entry.backdropApplied = false;
      entry.setCaptureBackdrop(null);
    }
  }

  setFocusedTabId(id: string | null) {
    if (this.focusedId !== id) {
      this.focusedId = id;
      this.lastSerialized = '';
      this.measure();
    }
  }

  register(reg: NativeViewRegistration): () => void {
    this.views.set(reg.id, {
      ...reg,
      isReady: false,
      hasBackdrop: false,
      captureEpoch: 0,
      capturePending: false,
      backdropApplied: false,
      nativeVisible: false,
      captureBounds: '',
    });
    this.lastSerialized = '';

    if (this.views.size === 1) {
      this.start();
    }
    this.measure();

    return () => {
      const existing = this.views.get(reg.id);
      if (existing) {
        existing.captureEpoch += 1;
        existing.capturePending = false;
        existing.hasBackdrop = false;
        existing.backdropApplied = false;
        existing.onDisplayed(false);
      }
      this.views.delete(reg.id);
      this.lastSerialized = '';

      if (this.views.size === 0) {
        this.stop();
        // Hide all views when no ChatGPT components are mounted
        window.mawChatGpt?.command({
          type: 'layout',
          views: [],
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }).catch(() => {});
      } else {
        this.measure();
      }
    };
  }

  private start() {
    const bridge = window.mawChatGpt;
    if (!bridge) return;

    this.observer = new MutationObserver(() => this.measure());
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true });

    const handleEvent = () => { this.lastSerialized = ''; this.measure(); };
    window.addEventListener('pointerup', handleEvent, true);
    window.addEventListener('pointercancel', handleEvent, true);
    window.addEventListener('lostpointercapture', handleEvent, true);
    window.addEventListener('blur', handleEvent);
    window.addEventListener('focus', handleEvent);
    window.addEventListener('resize', handleEvent);
    document.addEventListener('visibilitychange', handleEvent);

    this.unsubscribeBridge = bridge.subscribe((state) => {
      const entry = this.views.get(state.id ?? '');
      if (state.type === 'ready' && entry) {
        entry.isReady = true;
        this.lastSerialized = '';
        this.measure();
      } else if (state.type === 'loading' && entry) {
        entry.isReady = false;
        entry.onDisplayed(false);
      } else if (state.type === 'layout-needed') {
        this.lastSerialized = '';
        this.measure();
      } else if (state.type === 'error') {
        if (entry) {
          entry.onError?.(state.message ?? 'Native page unavailable.');
        } else {
          for (const v of this.views.values()) {
            v.onError?.(state.message ?? 'Native page unavailable.');
          }
        }
      } else if (state.type.startsWith('download-') && entry?.onDownloadEvent) {
        entry.onDownloadEvent(state);
      }
    });

    const tick = () => {
      this.measure();
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  private stop() {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.observer = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
  }

  measure() {
    const bridge = window.mawChatGpt;
    if (!bridge) return;

    const visibleViews: Array<{
      id: string;
      bounds: { x: number; y: number; width: number; height: number };
    }> = [];

    const viewport = { width: window.innerWidth, height: window.innerHeight };

    for (const [id, reg] of this.views) {
      const el = reg.element;
      if (!el || !el.isConnected || document.hidden || window.getComputedStyle(el).visibility !== 'visible') {
        reg.nativeVisible = false;
        this.cancelCapture(reg);
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        reg.nativeVisible = false;
        this.cancelCapture(reg);
        continue;
      }

      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(viewport.width, rect.right);
      let bottom = Math.min(viewport.height, rect.bottom);

      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }

      const x = Math.ceil(left);
      const y = Math.ceil(top);
      const width = Math.max(0, Math.floor(right) - x);
      const height = Math.max(0, Math.floor(bottom) - y);

      if (width <= 0 || height <= 0) {
        reg.nativeVisible = false;
        this.cancelCapture(reg);
        continue;
      }

      const viewBounds = { left: x, top: y, right: x + width, bottom: y + height };
      const isIntersecting = hasIntersectingOverlay(viewBounds);
      const boundsKey = `${x},${y},${width},${height}`;

      if (!isIntersecting) {
        reg.nativeVisible = true;
        reg.captureBounds = boundsKey;
        this.cancelCapture(reg);
        visibleViews.push({ id, bounds: { x, y, width, height } });
        continue;
      }

      reg.nativeVisible = false;
      if (reg.captureBounds !== boundsKey) this.cancelCapture(reg);
      reg.captureBounds = boundsKey;
      if (!reg.hasBackdrop && !reg.capturePending && reg.isReady) {
        const epoch = ++reg.captureEpoch;
        reg.capturePending = true;
        reg.hasBackdrop = true;
        void bridge.command({ type: 'capture', id }).then((res: unknown) => {
          const current = this.views.get(id);
          if (!current || current !== reg || current.captureEpoch !== epoch || current.nativeVisible) return;
          current.capturePending = false;
          const result = res as { ok?: boolean; dataUrl?: string } | undefined;
          if (result?.ok && result.dataUrl && current.hasBackdrop) {
            current.backdropApplied = true;
            current.setCaptureBackdrop(result.dataUrl);
            return;
          }
          current.hasBackdrop = false;
          if (current.backdropApplied) {
            current.backdropApplied = false;
            current.setCaptureBackdrop(null);
          }
        }).catch(() => {
          const current = this.views.get(id);
          if (!current || current !== reg || current.captureEpoch !== epoch) return;
          current.capturePending = false;
          current.hasBackdrop = false;
        });
      }
    }

    const command = {
      type: 'layout',
      views: visibleViews,
      viewport,
      focusedId: this.focusedId,
    };

    const serialized = JSON.stringify(command);
    if (serialized !== this.lastSerialized) {
      this.lastSerialized = serialized;
      void bridge.command(command).then(() => {
        const visibleSet = new Set(visibleViews.map((v) => v.id));
        for (const [id, reg] of this.views) {
          reg.onDisplayed(visibleSet.has(id) && reg.isReady);
        }
      }).catch((err) => {
        console.warn('[maw-chatgpt] layout command error:', err);
      });
    }
  }
}

export const nativeLayoutCoordinator = new NativeLayoutCoordinator();
