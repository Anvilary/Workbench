import { useEffect, useRef } from 'react';

/**
 * Invokes `onEscape` when Escape is pressed while `enabled` is true.
 */
export function useEscapeKey(onEscape: () => void, enabled = true, capture = false): void {
  const callbackRef = useRef(onEscape);
  callbackRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      callbackRef.current();
    };
    window.addEventListener('keydown', onKeyDown, capture);
    return () => window.removeEventListener('keydown', onKeyDown, capture);
  }, [enabled, capture]);
}
