import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { trapTabFocus } from './useFocusTrap.js';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface ConfirmKeyboardOptions {
  /** Whether the confirmation surface is currently shown. */
  open: boolean;
  /** Changes whenever a different item is being confirmed; resets the one-shot guard. */
  resetKey?: string | null;
  /** False while another dialog sits on top and owns the keyboard. */
  active?: boolean;
  /** Confirmation is allowed (not busy, not in flight, online). */
  canConfirm: boolean;
  /** Cancellation is allowed (not in flight). */
  canCancel: boolean;
  /** When true, a plain Enter anywhere in the surface confirms, except on the Cancel button. */
  enterConfirms: boolean;
  onConfirm: () => void | Promise<unknown>;
  onCancel: () => void;
  containerRef: RefObject<HTMLElement | null>;
  confirmRef?: RefObject<HTMLElement | null>;
  cancelRef?: RefObject<HTMLElement | null>;
  /** Element to focus when opening. Defaults to `confirmRef`, then `cancelRef`. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  focusSelector?: string;
}

function isNativeEnterTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

/**
 * Keyboard contract for small confirmation dialogs (tab close and similar):
 * Enter confirms once, Escape cancels, Tab stays trapped, handled keys never
 * reach listeners behind the dialog (xterm, window shortcuts), and focus
 * returns to where it was when the dialog closes.
 *
 * Returns a guarded confirm callback that click handlers must use too, so a
 * repeated key, a double Enter, or Enter plus click cannot confirm twice.
 */
export function useConfirmKeyboard({
  open,
  resetKey = null,
  active = true,
  canConfirm,
  canCancel,
  enterConfirms,
  onConfirm,
  onCancel,
  containerRef,
  confirmRef,
  cancelRef,
  initialFocusRef,
  focusSelector = 'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
}: ConfirmKeyboardOptions): () => void {
  const submittedRef = useRef(false);
  const latest = useRef({ canConfirm, canCancel, onConfirm, onCancel });
  latest.current = { canConfirm, canCancel, onConfirm, onCancel };

  const confirm = useCallback(() => {
    const state = latest.current;
    if (submittedRef.current || !state.canConfirm) return;
    submittedRef.current = true;
    const result = state.onConfirm();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // Allow a retry once the attempt settles (for example after an error).
      void (result as Promise<unknown>).then(
        () => { submittedRef.current = false; },
        () => { submittedRef.current = false; },
      );
    }
  }, []);

  // Initial focus and focus restoration. Runs in layout so the previously
  // focused element is captured before anything else moves focus.
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    submittedRef.current = false;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    const candidates = [initialFocusRef?.current, confirmRef?.current, cancelRef?.current];
    const target = candidates.find(
      (el): el is HTMLElement => !!el && !(el as HTMLButtonElement).disabled,
    );
    if (target) target.focus();
    else container?.focus();
    return () => {
      if (!previous || !previous.isConnected) return;
      const current = document.activeElement;
      const focusLeftDialog =
        !current || current === document.body || !current.isConnected || (container?.contains(current) ?? false);
      if (focusLeftDialog) previous.focus();
    };
    // Re-run only when a new confirmation opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetKey]);

  useEffect(() => {
    if (!open || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Tab') {
        trapTabFocus(event, containerRef.current, focusSelector);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && latest.current.canCancel) latest.current.onCancel();
        return;
      }
      if (event.key !== 'Enter' || !enterConfirms) return;
      const target = event.target;
      const cancel = cancelRef?.current ?? null;
      // A focused Cancel button keeps its native activation (Enter cancels),
      // but the key must still not leak to listeners behind the dialog.
      if (cancel && target === cancel) {
        event.stopPropagation();
        return;
      }
      const container = containerRef.current;
      if (container && target instanceof Node && container.contains(target) && isNativeEnterTarget(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      confirm();
    };
    // Capture phase on window runs before the focused target (for example an
    // xterm textarea) so handled keys never reach it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, active, enterConfirms, containerRef, cancelRef, focusSelector, confirm]);

  return confirm;
}
