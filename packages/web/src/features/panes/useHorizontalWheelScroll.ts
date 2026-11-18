import { useEffect, type RefObject } from 'react';

/**
 * Converts vertical mouse-wheel scrolling on a horizontal tab strip into
 * horizontal scroll offsets while passing through native horizontal touchpad gestures.
 */
export function useHorizontalWheelScroll(
  stripRef: RefObject<HTMLElement | null>,
  itemCount: number,
): void {
  useEffect(() => {
    const node = stripRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (node.scrollWidth <= node.clientWidth) return;

      let delta = event.deltaY;
      if (event.deltaMode === 1) {
        delta *= 18;
      } else if (event.deltaMode === 2) {
        delta *= node.clientWidth;
      } else {
        delta = Math.sign(delta) * Math.min(Math.abs(delta), 100);
      }

      if (delta === 0) return;

      if (delta < 0 && node.scrollLeft <= 0) return;
      if (delta > 0 && node.scrollLeft + node.clientWidth >= node.scrollWidth - 1) return;

      event.preventDefault();
      node.scrollLeft += delta;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [stripRef, itemCount]);
}
