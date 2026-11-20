export interface TabRect {
  left: number;
  width: number;
}

export function insertionIndex(clientX: number, rects: readonly TabRect[]): number;

export function tabShift(
  index: number,
  sourceIndex: number,
  overIndex: number | null | undefined,
  width: number,
  samePane: boolean,
): number;
