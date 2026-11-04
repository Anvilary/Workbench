import { useCallback, useEffect, useRef, useState } from 'react';
import type { SplitDirection } from '@agent-workbench/shared';

interface Props {
  splitId: string;
  direction: SplitDirection;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onDragStateChange?: (dragging: boolean) => void;
}

const SNAP_RATIOS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
const SNAP_TOLERANCE_PX = 14;
const MIN_PANE_PX = 120;

export function SplitDivider({
  splitId,
  direction,
  ratio,
  onRatioChange,
  onDragStateChange,
}: Props): JSX.Element {
  const dividerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [snapGuide, setSnapGuide] = useState<{ x?: number; y?: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    parentRect: DOMRect;
    parallelTargets: number[];
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const initialRatioRef = useRef(ratio);
  const latestRatioRef = useRef(ratio);
  if (!dragRef.current) {
    latestRatioRef.current = ratio;
  }

  const stopDrag = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const finalRatio = latestRatioRef.current;
    const parent = dividerRef.current?.parentElement;
    if (parent) {
      parent.style.removeProperty('--split-ratio-first');
      parent.style.removeProperty('--split-ratio-second');
      const firstChild = parent.firstElementChild as HTMLElement | null;
      const lastChild = parent.lastElementChild as HTMLElement | null;
      if (firstChild && lastChild) {
        firstChild.style.flex = `var(--split-ratio-first, ${finalRatio}) 1 0px`;
        lastChild.style.flex = `var(--split-ratio-second, ${1 - finalRatio}) 1 0px`;
      }
    }
    dragRef.current = null;
    setIsDragging(false);
    setSnapGuide(null);
    onDragStateChange?.(false);
    onRatioChange(finalRatio);
  }, [onDragStateChange, onRatioChange]);

  useEffect(() => {
    const handleBlur = () => {
      if (dragRef.current) stopDrag();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        latestRatioRef.current = initialRatioRef.current;
        stopDrag();
      }
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('keydown', handleKeyDown);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (dragRef.current) {
        stopDrag();
      }
    };
  }, [stopDrag]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const divider = dividerRef.current;
    const parent = divider?.parentElement;
    if (!divider || !parent) return;

    divider.setPointerCapture(e.pointerId);

    // Find other parallel dividers in the workspace to allow collinear snapping (e.g. 2x2 grid alignment)
    const otherDividers = Array.from(document.querySelectorAll<HTMLElement>('.maw-split-divider'));
    const parallelTargets: number[] = [];
    for (const el of otherDividers) {
      if (el === divider) continue;
      const elDir = el.getAttribute('data-direction');
      if (elDir === direction) {
        const rect = el.getBoundingClientRect();
        parallelTargets.push(direction === 'row' ? rect.left + rect.width / 2 : rect.top + rect.height / 2);
      }
    }

    initialRatioRef.current = ratio;
    latestRatioRef.current = ratio;
    dragRef.current = {
      pointerId: e.pointerId,
      parentRect: parent.getBoundingClientRect(),
      parallelTargets,
    };

    setIsDragging(true);
    onDragStateChange?.(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const isRow = direction === 'row';
    const parentRect = drag.parentRect;
    const totalPx = isRow ? parentRect.width : parentRect.height;
    if (totalPx <= 0) return;

    const pointerCoord = isRow ? e.clientX : e.clientY;
    const parentStart = isRow ? parentRect.left : parentRect.top;
    let rawPx = pointerCoord - parentStart;
    let guideCoord: number | null = null;

    // 1. Check collinear alignment with adjacent parallel dividers
    let snapped = false;
    for (const target of drag.parallelTargets) {
      if (Math.abs(pointerCoord - target) <= SNAP_TOLERANCE_PX) {
        rawPx = target - parentStart;
        guideCoord = target;
        snapped = true;
        break;
      }
    }

    // 2. Check standard magnetic snap ratios (50/50, 25/75, 33/67, etc.)
    if (!snapped) {
      for (const snapRatio of SNAP_RATIOS) {
        const targetPx = snapRatio * totalPx;
        if (Math.abs(rawPx - targetPx) <= SNAP_TOLERANCE_PX) {
          rawPx = targetPx;
          guideCoord = parentStart + targetPx;
          snapped = true;
          break;
        }
      }
    }

    // 3. Enforce minimum pane dimensions so panes cannot become unworkably tiny
    const minPx = Math.min(MIN_PANE_PX, totalPx * 0.15);
    const maxPx = totalPx - minPx;
    const clampedPx = Math.max(minPx, Math.min(maxPx, rawPx));
    const nextRatio = Math.round((clampedPx / totalPx) * 1000) / 1000;
    latestRatioRef.current = nextRatio;

    // Fast path: set CSS custom variables on split container and mutate sibling flex styles directly
    const parent = dividerRef.current?.parentElement;
    if (parent) {
      parent.style.setProperty('--split-ratio-first', `${nextRatio}`);
      parent.style.setProperty('--split-ratio-second', `${1 - nextRatio}`);
      const firstChild = parent.firstElementChild as HTMLElement | null;
      const lastChild = parent.lastElementChild as HTMLElement | null;
      if (firstChild && lastChild) {
        firstChild.style.flex = `var(--split-ratio-first, ${nextRatio}) 1 0px`;
        lastChild.style.flex = `var(--split-ratio-second, ${1 - nextRatio}) 1 0px`;
      }
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (snapped && guideCoord !== null) {
        setSnapGuide(isRow ? { x: guideCoord } : { y: guideCoord });
      } else {
        setSnapGuide(null);
      }
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      if (dividerRef.current?.hasPointerCapture(e.pointerId)) {
        dividerRef.current.releasePointerCapture(e.pointerId);
      }
      stopDrag();
    }
  };

  const isRow = direction === 'row';

  return (
    <>
      <div
        ref={dividerRef}
        className={`maw-split-divider maw-split-divider-${direction}${isDragging ? ' is-dragging' : ''}`}
        data-split-id={splitId}
        data-direction={direction}
        role="separator"
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="maw-split-divider-handle" />
      </div>
      {snapGuide && (
        <div
          className={`maw-snap-guide maw-snap-guide-${direction}`}
          style={
            isRow
              ? { left: `${snapGuide.x}px` }
              : { top: `${snapGuide.y}px` }
          }
        />
      )}
    </>
  );
}
