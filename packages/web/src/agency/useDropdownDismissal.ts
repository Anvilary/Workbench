import { useEffect } from 'react';

/** Dismiss via the owning trigger so React remains the source of menu state. */
export function useDropdownDismissal(): void {
  useEffect(() => {
    const opened = () => [...document.querySelectorAll<HTMLButtonElement>('.agency-dropdown > button[aria-expanded="true"]')];
    const pointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest('.agency-dropdown') : null;
      for (const trigger of opened()) {
        if (trigger.parentElement !== target) trigger.click();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const triggers = opened();
      if (!triggers.length) return;
      event.preventDefault();
      for (const trigger of triggers) trigger.click();
      triggers[0]?.focus();
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key);
    };
  }, []);
}
