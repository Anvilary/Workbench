import { useEffect, useRef } from 'react';

/**
 * Invokes `onEscape` when Escape is pressed while `enabled` is true.
 */
export function useEscapeKey(onEscape: (event: KeyboardEvent) => void, enabled = true, capture = false): void {
  const callbackRef = useRef(onEscape);
  callbackRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      callbackRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown, capture);
    return () => window.removeEventListener('keydown', onKeyDown, capture);
  }, [enabled, capture]);
}
