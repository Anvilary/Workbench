import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Handles ArrowDown, ArrowUp, Home, End, and Tab focus traversal inside a role="menu" container.
 */
export function handleMenuArrowNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  menuContainer: HTMLElement | null,
  onTabDismiss?: () => void,
): void {
  if (event.key === 'Tab') {
    onTabDismiss?.();
    return;
  }

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
