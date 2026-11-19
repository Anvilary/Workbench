import { useEffect, useRef, type RefObject } from 'react';

export const DEFAULT_FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function isElementFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  if (typeof el.getClientRects === 'function') {
    // Only filter by client rects when layout exists in a real browser DOM
    const rectCount = el.getClientRects().length;
    if (rectCount === 0 && typeof document !== 'undefined' && document.body?.getClientRects().length > 0) {
      return false;
    }
  }
  return true;
}

export function getFocusableElements(
  container: HTMLElement | null,
  selector = DEFAULT_FOCUSABLE_SELECTOR,
): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(isElementFocusable);
}

/**
 * Returns true if `container` is the topmost open dialog in the document.
 */
export function isTopmostDialog(container: HTMLElement | null): boolean {
  if (!container || typeof document === 'undefined') return false;
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')).filter(
    (el) => !el.hidden && !el.closest('[hidden], [aria-hidden="true"]'),
  );
  if (dialogs.length === 0) return true;
  return dialogs[dialogs.length - 1] === container;
}

/**
 * Wraps Tab/Shift+Tab focus within `container` when active.
 */
export function trapTabFocus(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  container: HTMLElement | null,
  selector = DEFAULT_FOCUSABLE_SELECTOR,
): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = getFocusableElements(container, selector);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active) || !focusable.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface UseFocusTrapOptions {
  restoreFocus?: boolean;
  selector?: string;
}

/**
 * Traps keyboard Tab navigation inside `containerRef` while `active` is true,
 * and optionally restores focus to the previously focused element on cleanup.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: UseFocusTrapOptions = {},
): void {
  const { restoreFocus = false, selector = DEFAULT_FOCUSABLE_SELECTOR } = options;
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !restoreFocus) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previousFocusRef.current?.focus?.();
      previousFocusRef.current = null;
    };
  }, [active, restoreFocus]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container || !isTopmostDialog(container)) return;
      if (!document.activeElement || !container.contains(document.activeElement)) {
        const focusable = getFocusableElements(container, selector);
        focusable[0]?.focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog(containerRef.current)) return;
      trapTabFocus(event, containerRef.current, selector);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active, containerRef, selector]);
}
