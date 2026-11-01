export interface TerminalPathSuccess {
  ok: true;
  relative: string;
  absolute: string;
}

export interface TerminalPathFailure {
  ok: false;
  error: 'invalid' | 'outside' | 'directory';
}

export type TerminalPathResult = TerminalPathSuccess | TerminalPathFailure;

export function terminalPathCandidate(
  selection: unknown,
  cwd: unknown,
): TerminalPathResult;
