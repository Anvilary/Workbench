import { useEffect, useState } from 'react';

export interface TabDragPreview {
  tabId: string;
  sourcePaneId: string;
  sourceIndex: number;
  width: number;
  overPaneId: string | null;
  overIndex: number | null;
}

type Listener = (preview: TabDragPreview | null) => void;

let current: TabDragPreview | null = null;
const listeners = new Set<Listener>();

export function setTabDragPreview(preview: TabDragPreview | null): void {
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
