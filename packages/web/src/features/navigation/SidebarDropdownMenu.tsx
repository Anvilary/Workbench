import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { calculateSidebarDropdownPosition } from '../../shared/lib/overlay-position.js';

export interface SidebarDropdownMenuProps {
  anchor: HTMLElement | null;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  menuRef: (el: HTMLDivElement | null) => void;
}

export function SidebarDropdownMenu({
  anchor,
  children,
  onMouseEnter,
  onMouseLeave,
  onKeyDown,
  menuRef,
}: SidebarDropdownMenuProps): JSX.Element | null {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number }>(() => {
    if (!anchor) return { left: 0, top: 0 };
    return calculateSidebarDropdownPosition({
      triggerRect: anchor.getBoundingClientRect(),
      menuWidth: 160,
      menuHeight: 140,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
    });
  });
  const internalRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (!anchor || !internalRef.current) return;
      const triggerRect = anchor.getBoundingClientRect();
      const popupRect = internalRef.current.getBoundingClientRect();
      const pos = calculateSidebarDropdownPosition({
        triggerRect,
        menuWidth: popupRect.width > 0 ? popupRect.width : 160,
        menuHeight: popupRect.height > 0 ? popupRect.height : 140,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPosition((prev) => {
        if (prev.left === pos.left && prev.top === pos.top) return prev;
        return pos;
      });
    };

    update();
    anchor?.setAttribute('aria-controls', id);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      anchor?.removeAttribute('aria-controls');
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, id]);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      internalRef.current = el;
      menuRef(el);
    },
    [menuRef],
  );

  return createPortal(
    <div
      ref={setRefs}
      id={id}
      className="agency-dropdown-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        right: 'auto',
        bottom: 'auto',
        margin: 0,
        zIndex: 950,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
