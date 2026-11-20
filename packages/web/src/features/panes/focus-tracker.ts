/**
 * MAW Lane C - Focus-Aware Notification Suppression & Channel Routing.
 *
 * Implements precise focus and visibility modeling across:
 *   - Application window focus (document.hasFocus)
 *   - Window minimized state / document visibility (document.hidden)
 *   - Active workspace selection
 *   - Active pane & selected tab
 *   - Native WebContentsView focus (ChatGPT, Perplexity via desktop bridge)
 *
 * Invariants:
 *   - Actively viewed sessions never generate redundant completion toasts or OS notifications.
 *   - A session in another tab or workspace generates an in-app toast when MAW is focused.
 *   - When MAW is minimized or another OS application has focus, an OS desktop alert is dispatched.
 */

import { nativeLayoutCoordinator } from '../browser/native-layout-coordinator.js';

export interface FocusContext {
  activeWorkspaceId: string | null;
  showingDone: boolean;
  activeTabId?: string | null;
  visibleTabIds?: ReadonlySet<string>;
}

export type NotificationDeliveryChannel = 'suppress' | 'toast' | 'os';

export class FocusTracker {
  private nativeViewFocused = false;
  private nativeFocusedTabId: string | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  private lastNativeFocusTime = 0;

  constructor() {
    this.init();
  }

  private init(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('focus', () => {
      // Shell renderer gained focus directly
      this.nativeViewFocused = false;
    });

    window.addEventListener('blur', () => {
      // If a native view just reported focus within 150ms, the blur was caused by
      // clicking into the child WebContentsView, so MAW window is still actively used.
      if (Date.now() - this.lastNativeFocusTime > 150) {
        this.nativeViewFocused = false;
        this.nativeFocusedTabId = null;
      }
    });

    // Subscribe to native view focus events from Electron desktop bridge
    const bridge = (window as unknown as { mawChatGpt?: { subscribe: (fn: (e: { type: string; id?: string }) => void) => () => void } }).mawChatGpt;
    if (bridge && typeof bridge.subscribe === 'function') {
      try {
        this.unsubscribeBridge = bridge.subscribe((state) => {
          if (state.type === 'focused' && state.id) {
            this.lastNativeFocusTime = Date.now();
            this.nativeViewFocused = true;
            this.nativeFocusedTabId = state.id;
          }
        });
      } catch {
        // Safe fallback in test or restricted environments
      }
    }
  }

  /**
   * Returns whether the MAW application window currently has user focus,
   * either in the shell renderer or in an attached native WebContentsView.
   */
  isWindowFocused(): boolean {
    if (typeof document === 'undefined') return false;
    if (this.isDocumentHidden()) return false;

    const rendererHasFocus = typeof document.hasFocus === 'function' && document.hasFocus();
    return rendererHasFocus || this.nativeViewFocused;
  }

  /**
   * Returns whether the window is minimized or document is occluded/hidden.
   */
  isDocumentHidden(): boolean {
    if (typeof document === 'undefined') return false;
    return document.hidden === true || document.visibilityState === 'hidden';
  }

  /**
   * Returns the tabId of the focused native WebContentsView, if any.
   */
  getNativeFocusedTabId(): string | null {
    return this.nativeViewFocused ? this.nativeFocusedTabId : null;
  }

  /**
   * Determines whether the user is actively viewing the specified session tab.
   *
   * A session is actively viewed iff:
   *   1. The MAW window is focused and visible (not minimized/hidden).
   *   2. The user is not on the archive/Done view.
   *   3. The notification's workspace matches the currently active workspace.
   *   4. The tab is currently selected in the focused pane or layout coordinator.
   */
  isSessionActivelyViewed(
    session: { workspaceId: string; tabId: string },
    context: FocusContext,
  ): boolean {
    if (!this.isWindowFocused() || this.isDocumentHidden()) {
      return false;
    }

    if (context.showingDone) {
      return false;
    }

    if (!context.activeWorkspaceId || context.activeWorkspaceId !== session.workspaceId) {
      return false;
    }

    // Check tab active view state
    const matchesActiveTab = Boolean(context.activeTabId && context.activeTabId === session.tabId);
    const matchesLayoutCoordinator = nativeLayoutCoordinator.isViewing(session.tabId);
    const matchesNativeFocus = this.nativeViewFocused && this.nativeFocusedTabId === session.tabId;

    return matchesActiveTab || matchesLayoutCoordinator || matchesNativeFocus;
  }

  /**
   * Determines which channel should receive the notification:
   *   - 'suppress': Session is actively viewed; redundant alert suppressed.
   *   - 'os': MAW is minimized or another application has focus; dispatch OS alert.
   *   - 'toast': MAW is focused, but user is on another tab/workspace; show in-app toast.
   */
  determineDeliveryChannel(
    session: { workspaceId: string; tabId: string },
    context: FocusContext,
  ): NotificationDeliveryChannel {
    if (this.isSessionActivelyViewed(session, context)) {
      return 'suppress';
    }

    if (!this.isWindowFocused() || this.isDocumentHidden()) {
      return 'os';
    }

    return 'toast';
  }

  dispose(): void {
    if (this.unsubscribeBridge) {
      this.unsubscribeBridge();
      this.unsubscribeBridge = null;
    }
  }
}

export const focusTracker = new FocusTracker();
