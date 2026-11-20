import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm';

const ALL_NON_BREAKING_SPACE_REGEX = /\u00a0/g;
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

/**
 * Extracts clean text from an xterm buffer within the given line range.
 * Correctly joins wrapped lines without inserting spurious newlines,
 * normalizes non-breaking spaces, and strips trailing empty lines.
 */
export function extractBufferText(
  buffer: Pick<IBuffer, 'length' | 'getLine'>,
  startLine = 0,
  endLine = buffer.length - 1,
): string {
  if (buffer.length === 0) return '';
  const start = Math.max(0, startLine);
  const end = Math.min(buffer.length - 1, endLine);
  if (start > end) return '';

  const logicalLines: string[] = [];
  let currentLogicalLine = '';
  let started = false;

  for (let y = start; y <= end; y++) {
    const bufferLine: IBufferLine | undefined = buffer.getLine(y);
    if (!bufferLine) continue;

    const lineText = bufferLine.translateToString(true);
    const isWrapped = !!bufferLine.isWrapped;

    if (!started) {
      currentLogicalLine = lineText;
      started = true;
    } else if (isWrapped) {
      currentLogicalLine += lineText;
    } else {
      logicalLines.push(currentLogicalLine);
      currentLogicalLine = lineText;
    }
  }

  if (started) {
    logicalLines.push(currentLogicalLine);
  }

  // Normalize non-breaking spaces and remove trailing empty lines
  const normalized = logicalLines.map((l) =>
    l.replace(ALL_NON_BREAKING_SPACE_REGEX, ' ').replace(ANSI_REGEX, ''),
  );

  while (normalized.length > 0 && normalized[normalized.length - 1]?.trim() === '') {
    normalized.pop();
  }

  return normalized.join('\n');
}

/**
 * Checks if a string resembles a common shell prompt line.
 * Matches standard bash, zsh, sh, venv, and powerline style prompts:
 * - Ends with '$ ', '% ', '# ', '> ', '❯ ', '➜ ', '» '
 * - User@host patterns like 'user@hostname:path$ '
 */
export function isPromptLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Standalone shell prompt: "$ ", "% ", "> ", "❯ ", "➜ ", "» "
  if (/^[$%❯➜»>](?:\s+|$)/.test(trimmed)) return true;

  // Prompts with user@host: e.g. "alexandre@ubuntu:~$ ls", "root@server:# "
  if (/^[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[:\s].*[$%#](?:\s+|$)/.test(trimmed)) return true;

  // Prompts with brackets: e.g. "[user@fedora dir]$ ", "(my-venv) [user@fedora dir]$ "
  if (/^(?:\([^)]+\)\s*)?\[.+@[^\]]+\]\s*[$%#](?:\s+|$)/.test(trimmed)) return true;

  // Starship / zsh / powerlevel prompt symbols: "➜ my-repo git:(main) ", "❯ git status"
  if (/^[❯➜»]\s+/.test(trimmed)) return true;

  // Shell default: "bash-5.2$ ", "sh-4.4$ "
  if (/^(?:bash|zsh|sh|csh|tcsh)[a-zA-Z0-9.\-]*\s*[$%#](?:\s+|$)/.test(trimmed)) return true;

  return false;
}

/**
 * Extracts the latest command output deterministically from the terminal buffer.
 *
 * In alternate-screen mode (e.g. full-screen Codex or TUIs), copies the active
 * screen buffer without inventing non-existent scrollback.
 *
 * In normal-screen mode, relies on:
 * 1. An OSC 133 command start marker if available.
 * 2. Shell prompt boundary detection scanning backwards from the end of output.
 * 3. Safe fallback to the recent bounded output window.
 */
export function extractLastOutput(
  terminal: Terminal,
  lastCommandMarker?: { line: number } | null,
): string {
  const buffer = terminal.buffer.active;
  if (!buffer || buffer.length === 0) return '';

  // 1. Alternate screen buffer (Codex, htop, vi, less)
  if (buffer.type === 'alternate') {
    return extractBufferText(buffer, 0, buffer.length - 1);
  }

  // 2. Normal screen buffer with valid OSC 133 command start marker
  if (lastCommandMarker && lastCommandMarker.line >= 0 && lastCommandMarker.line < buffer.length) {
    const startLine = lastCommandMarker.line;
    // Find last non-empty line
    let endLine = buffer.length - 1;
    while (endLine > startLine && !(buffer.getLine(endLine)?.translateToString(true).trim())) {
      endLine--;
    }
    // If the last non-empty line is a fresh prompt, the output ends right before it
    const lastLineText = buffer.getLine(endLine)?.translateToString(true) ?? '';
    if (endLine > startLine && isPromptLine(lastLineText)) {
      endLine--;
    }
    return extractBufferText(buffer, startLine, endLine);
  }

  // 3. Fallback: prompt boundary heuristic on retained normal buffer
  let lastNonEmpty = buffer.length - 1;
  while (lastNonEmpty >= 0 && !(buffer.getLine(lastNonEmpty)?.translateToString(true).trim())) {
    lastNonEmpty--;
  }

  if (lastNonEmpty < 0) return '';

  const lastLineText = buffer.getLine(lastNonEmpty)?.translateToString(true) ?? '';
  const isTrailingPrompt = isPromptLine(lastLineText);

  // Search backwards for the prompt line where the command was initiated
  const searchLimit = Math.max(0, lastNonEmpty - 500);
  let promptLine = -1;

  const startSearch = isTrailingPrompt ? lastNonEmpty - 1 : lastNonEmpty;
  for (let y = startSearch; y >= searchLimit; y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // Only check non-wrapped lines as candidate prompts
    if (line.isWrapped) continue;
    const str = line.translateToString(true);
    if (isPromptLine(str)) {
      promptLine = y;
      break;
    }
  }

  if (promptLine >= 0) {
    const outputStart = promptLine + 1;
    const outputEnd = isTrailingPrompt ? lastNonEmpty - 1 : lastNonEmpty;
    if (outputStart <= outputEnd) {
      return extractBufferText(buffer, outputStart, outputEnd);
    }
  }

  // 4. Safe bounded window fallback: recent block (up to 60 lines or terminal rows)
  const windowSize = Math.max(terminal.rows, 60);
  const fallbackStart = Math.max(0, lastNonEmpty - windowSize + 1);
  return extractBufferText(buffer, fallbackStart, lastNonEmpty);
}
