import { useEffect, useState } from 'react';

export interface TabDragSplitTarget {
  paneId: string;
  direction: 'row' | 'column';
}

export interface TabDragPreview {
  tabId: string;
  sourcePaneId: string;
  sourceIndex: number;
  width: number;
  overPaneId: string | null;
  overIndex: number | null;
  splitTarget?: TabDragSplitTarget | null;
}

type Listener = (preview: TabDragPreview | null) => void;

let current: TabDragPreview | null = null;
const listeners = new Set<Listener>();

export function setTabDragPreview(preview: TabDragPreview | null): void {
  if (
    current === preview ||
    (current !== null &&
      preview !== null &&
      current.tabId === preview.tabId &&
      current.sourcePaneId === preview.sourcePaneId &&
      current.sourceIndex === preview.sourceIndex &&
      current.width === preview.width &&
      current.overPaneId === preview.overPaneId &&
      current.overIndex === preview.overIndex &&
      current.splitTarget?.paneId === preview.splitTarget?.paneId &&
      current.splitTarget?.direction === preview.splitTarget?.direction)
  ) {
    return;
  }
  current = preview;
  for (const listener of listeners) listener(preview);
}

export function useTabDragPreview(): TabDragPreview | null {
  const [preview, setPreview] = useState<TabDragPreview | null>(current);
  useEffect(() => {
    listeners.add(setPreview);
    setPreview(current);
    return () => {
      listeners.delete(setPreview);
    };
  }, []);
  return preview;
}
