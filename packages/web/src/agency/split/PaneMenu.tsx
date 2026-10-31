import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

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
      const margin = 8;
      setPosition({
        left: Math.max(margin, Math.min(button.left, window.innerWidth - popup.width - margin)),
        top: Math.max(margin, button.bottom + popup.height + margin <= window.innerHeight
          ? button.bottom + 4 : Math.min(button.top - popup.height - 4, window.innerHeight - popup.height - margin)),
      });
    };
    place();
    anchor.current?.setAttribute('aria-controls', id);
    window.addEventListener('resize', place);
    // A scroll can move the anchor without changing the pane's geometry.
    window.addEventListener('scroll', place, true);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => { anchor.current?.removeAttribute('aria-controls'); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
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
  return createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
    className="agency-dropdown-menu maw-pane-menu" style={{ ...position, position: 'fixed', zIndex: 150 }}
    onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</div>, document.body);
}
