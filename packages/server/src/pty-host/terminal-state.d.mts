export interface TerminalCheckpoint {
  data: string;
  cols: number;
  rows: number;
}
export class TerminalState {
  constructor(cols?: number, rows?: number);
  push(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<TerminalCheckpoint>;
  dispose(): void;
}
