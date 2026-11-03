export interface NativeViewRegistration {
  id: string;
  element: HTMLElement;
  onDisplayed: (ready: boolean) => void;
  onFocused?: () => void;
  setCaptureBackdrop: (dataUrl: string | null) => void;
  onError?: (message: string) => void;
  onRestoring?: (restoring: boolean) => void;
  onDownloadEvent?: (event: { type: string; filename?: string; percent?: number | null; message?: string }) => void;
}

function hasIntersectingOverlay(viewBounds: { left: number; top: number; right: number; bottom: number }): boolean {
  if (viewBounds.right <= viewBounds.left || viewBounds.bottom <= viewBounds.top) return false;
  const items = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], .agency-modal-backdrop, .agency-dropdown-menu, .maw-toast-item, .context-menu, .agency-dialog, .maw-context-menu, .maw-pane-drag-shield'
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
  backdropReady: boolean;
  nativeVisible: boolean;
  captureBounds: string;
};

class NativeLayoutCoordinator {
  private readonly views = new Map<string, TrackedView>();
  private frame = 0;
  private lastSerialized = '';
  private observer: MutationObserver | null = null;
  private pending = false;
  private resizeObserver: ResizeObserver | null = null;
  private runningTransitions = 0;
  private heartbeat = 0;
  private listeners: Array<[EventTarget, string, EventListener, boolean | undefined]> = [];
  private unsubscribeBridge: (() => void) | null = null;
  private focusedId: string | null = null;

  /** Drop a capture that must not land on a visible view, and release its bitmap. */
  private cancelCapture(entry: TrackedView): void {
    if (!entry.capturePending && !entry.hasBackdrop && !entry.backdropApplied) return;
    entry.backdropReady = false;
    entry.captureEpoch += 1;
    entry.capturePending = false;
    entry.hasBackdrop = false;
    if (entry.backdropApplied) {
      entry.backdropApplied = false;
      entry.setCaptureBackdrop(null);
    }
  }

  /** Coalesce any number of triggers into at most one measure() per animation frame. */
  private schedule() {
    if (this.pending || this.views.size === 0) return;
    this.pending = true;
    this.frame = requestAnimationFrame(() => {
      this.pending = false;
      this.measure();
      // While CSS transitions/animations run (sidebar, split divider), geometry changes every frame.
      if (this.runningTransitions > 0) this.schedule();
    });
  }

  private listen(target: EventTarget, type: string, handler: EventListener, capture?: boolean) {
    target.addEventListener(type, handler, capture);
    this.listeners.push([target, type, handler, capture]);
  }

  setFocusedTabId(id: string | null) {
    if (this.focusedId !== id) {
      this.focusedId = id;
      this.lastSerialized = '';
      this.schedule();
    }
  }

  isViewing(tabId: string): boolean {
    return this.focusedId === tabId;
  }

  register(reg: NativeViewRegistration): () => void {
    this.views.set(reg.id, {
      ...reg,
      isReady: false,
      hasBackdrop: false,
      captureEpoch: 0,
      capturePending: false,
      backdropApplied: false,
      backdropReady: false,
      nativeVisible: false,
      captureBounds: '',
    });
    this.lastSerialized = '';

    if (this.views.size === 1) {
      this.start();
    }
    this.resizeObserver?.observe(reg.element);
    this.measure();

    return () => {
      const existing = this.views.get(reg.id);
      if (existing) {
        existing.captureEpoch += 1;
        existing.capturePending = false;
        existing.hasBackdrop = false;
        existing.backdropApplied = false;
        existing.onDisplayed(false);
        this.resizeObserver?.unobserve(existing.element);
      }
      this.views.delete(reg.id);
      this.lastSerialized = '';
      if (this.focusedId === reg.id) {
        this.focusedId = null;
      }

      if (this.views.size === 0) {
        this.stop();
        // Hide all views when no ChatGPT components are mounted
        window.mawChatGpt?.command({
          type: 'layout',
          views: [],
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }).catch(() => {});
      } else {
        this.schedule();
      }
    };
  }

  private start() {
    const bridge = window.mawChatGpt;
    if (!bridge) return;

    // Terminal repaints (xterm DOM renderer rows, cursor blink) cannot move a native view or open an overlay.
    const ignorable = (n: Node | null): boolean => {
      const el = n && n.nodeType === 1 ? (n as Element) : n?.parentElement ?? null;
      return !!el && el.closest('.xterm') !== null;
    };
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (!ignorable(r.target)) {
          this.schedule();
          return;
        }
      }
    });
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true });

    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(document.documentElement);
    for (const reg of this.views.values()) this.resizeObserver.observe(reg.element);

    const bump = (d: number) => () => {
      this.runningTransitions = Math.max(0, this.runningTransitions + d);
      this.schedule();
    };
    this.listen(document, 'transitionrun', bump(1), true);
    this.listen(document, 'transitionend', bump(-1), true);
    this.listen(document, 'transitioncancel', bump(-1), true);
    this.listen(document, 'scroll', (e) => {
      if (!ignorable(e.target as Node)) this.schedule();
    }, true);

    // Safety net for geometry changes with no DOM/size signal (async font load, ancestor moves): 1 Hz instead of 60-165 Hz.
    this.heartbeat = window.setInterval(() => this.schedule(), 1000);

    const handleEvent = () => {
      this.lastSerialized = '';
      this.schedule();
    };
    this.listen(window, 'pointerup', handleEvent, true);
    this.listen(window, 'pointercancel', handleEvent, true);
    this.listen(window, 'lostpointercapture', handleEvent, true);
    this.listen(window, 'blur', handleEvent);
    this.listen(window, 'focus', handleEvent);
    this.listen(window, 'resize', handleEvent);
    this.listen(document, 'visibilitychange', handleEvent);

    this.unsubscribeBridge = bridge.subscribe((state) => {
      const entry = this.views.get(state.id ?? '');
      if (state.type === 'focused' && entry) {
        window.dispatchEvent(new Event('maw:dismiss-pane-menus'));
        if (entry.nativeVisible && entry.element.isConnected && !document.hidden) entry.onFocused?.();
      } else if (state.type === 'ready' && entry) {
        entry.isReady = true;
        entry.onRestoring?.(false);
        this.lastSerialized = '';
        this.schedule();
      } else if (state.type === 'loading' && entry) {
        entry.isReady = false;
        entry.onDisplayed(false);
      } else if (state.type === 'restoring' && entry) {
        entry.isReady = false;
        entry.onDisplayed(false);
        entry.onRestoring?.(true);
      } else if (state.type === 'suspended' && entry) {
        entry.isReady = false;
        entry.onDisplayed(false);
        entry.onRestoring?.(false);
      } else if (state.type === 'layout-needed') {
        this.lastSerialized = '';
        this.schedule();
      } else if (state.type === 'error') {
        if (entry) {
          entry.onRestoring?.(false);
          entry.onError?.(state.message ?? 'Native page unavailable.');
        } else {
          for (const v of this.views.values()) {
            v.onRestoring?.(false);
            v.onError?.(state.message ?? 'Native page unavailable.');
          }
        }
      } else if (state.type.startsWith('download-') && entry?.onDownloadEvent) {
        entry.onDownloadEvent(state);
      }
    });

    this.schedule();
  }

  private stop() {
    cancelAnimationFrame(this.frame);
    this.pending = false;
    window.clearInterval(this.heartbeat);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const [t, type, h, c] of this.listeners) t.removeEventListener(type, h, c);
    this.listeners = [];
    this.runningTransitions = 0;
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
    const paneDrag = document.querySelector('.maw-pane-drag-shield') !== null;

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
      // A drop may exchange differently sized leaves. Keep the painted drag bitmap
      // until the animation finishes; the existing native view receives final bounds once.
      if (reg.captureBounds !== boundsKey && !(paneDrag && reg.backdropReady)) this.cancelCapture(reg);
      reg.captureBounds = boundsKey;
      // Overlay input cannot wait for a remote page to finish loading.
      if (!reg.hasBackdrop && !reg.capturePending) {
        const epoch = ++reg.captureEpoch;
        reg.capturePending = true;
        reg.hasBackdrop = true;
        void bridge.command({ type: 'capture', id }).then((res: unknown) => {
          const current = this.views.get(id);
          if (!current || current !== reg || current.captureEpoch !== epoch) return;
          current.capturePending = false;
          const result = res as { ok?: boolean; dataUrl?: string } | undefined;
          if (result?.ok && result.dataUrl && current.hasBackdrop) {
            current.backdropApplied = true;
            current.setCaptureBackdrop(result.dataUrl);
            // Let React commit and paint the in-memory bitmap before concealing the native surface.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (this.views.get(id) !== current || current.captureEpoch !== epoch) return;
              current.backdropReady = true;
              this.schedule();
            }));
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
      if (!reg.backdropReady) visibleViews.push({ id, bounds: { x, y, width, height } });
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
