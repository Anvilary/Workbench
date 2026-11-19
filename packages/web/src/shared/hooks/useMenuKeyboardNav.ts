import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FORM_CONTROL_SELECTOR = 'select, input, textarea';

/**
 * Handles ArrowDown, ArrowUp, Home, End, and Tab focus traversal inside a role="menu" container.
 * Preserves native keyboard interaction when focus is inside embedded form controls like <select>.
 */
export function handleMenuArrowNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  menuContainer: HTMLElement | null,
  onTabDismiss?: () => void,
): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const inFormControl = Boolean(target?.closest(FORM_CONTROL_SELECTOR));

  if (event.key === 'Tab') {
    const hasEmbeddedControls = Boolean(menuContainer?.querySelector(FORM_CONTROL_SELECTOR));
    if (!hasEmbeddedControls) {
      onTabDismiss?.();
      return;
    }
    const focusables = Array.from(
      menuContainer!.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
      ),
    );
    if (focusables.length === 0) {
      onTabDismiss?.();
      return;
    }
    const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
    if ((event.shiftKey && activeIndex <= 0) || (!event.shiftKey && activeIndex === focusables.length - 1)) {
      onTabDismiss?.();
    }
    return;
  }

  if (inFormControl) return;

  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = menuContainer?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
  if (!items || items.length === 0) return;

  event.preventDefault();
  event.stopPropagation();
  const itemsArray = Array.from(items);
  const currentIndex = itemsArray.indexOf(document.activeElement as HTMLButtonElement);

  let nextIndex: number;
  if (event.key === 'ArrowDown') {
    nextIndex = currentIndex === -1 || currentIndex === itemsArray.length - 1 ? 0 : currentIndex + 1;
  } else if (event.key === 'ArrowUp') {
    nextIndex = currentIndex <= 0 ? itemsArray.length - 1 : currentIndex - 1;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else {
    nextIndex = itemsArray.length - 1;
  }

  itemsArray[nextIndex]?.focus();
}
