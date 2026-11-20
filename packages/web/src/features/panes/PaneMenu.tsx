import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { handleMenuArrowNavigation } from '../../shared/hooks/useMenuKeyboardNav.js';
import { calculateViewportMenuPosition } from '../../shared/lib/overlay-position.js';

const opened = 'maw:pane-menu-opened';
export const dismissPaneMenus = () => window.dispatchEvent(new Event('maw:dismiss-pane-menus'));

/** A viewport anchored menu: never participates in tab-strip or terminal overflow. */
export function PaneMenu({ anchor, label, onClose, children }: {
  anchor: RefObject<HTMLButtonElement>; label: string; onClose: () => void; children: ReactNode;
}): JSX.Element {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const popup = menu.current?.getBoundingClientRect();
      if (!button || !popup) return;
      setPosition(calculateViewportMenuPosition({
        triggerRect: button,
        menuWidth: popup.width,
        menuHeight: popup.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }));
    };
    place();
    anchor.current?.setAttribute('aria-controls', id);
    window.addEventListener('resize', place);
    // A scroll can move the anchor without changing the pane's geometry.
    window.addEventListener('scroll', place, true);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      anchor.current?.removeAttribute('aria-controls');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, id]);

  useEffect(() => {
    const token = {};
    window.dispatchEvent(new CustomEvent(opened, { detail: token }));
    const another = (event: Event) => { if ((event as CustomEvent).detail !== token) close.current(); };
    const dismiss = () => close.current();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current(); anchor.current?.focus();
      } else if (event.key === 'Tab') close.current();
    };
    window.addEventListener(opened, another);
    window.addEventListener('maw:dismiss-pane-menus', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener(opened, another);
      window.removeEventListener('maw:dismiss-pane-menus', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      className="agency-dropdown-menu maw-pane-menu"
      style={{ ...position, position: 'fixed', zIndex: 150 }}
      onKeyDown={(event) => handleMenuArrowNavigation(event, event.currentTarget)}
    >
      {children}
    </div>,
    document.body,
  );
}
