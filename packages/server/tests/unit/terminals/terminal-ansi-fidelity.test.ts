import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TerminalHistoryStore } from '../../../src/features/terminals/terminal-history-store.js';

function cleanAnsiForDisplay(text: string): string {
  // Emulate frontend line display cleaner with carriage return resolution
  const stripped = text.replace(/\x1b\[[0-9;?<=>]*[a-zA-Z~]/g, '').replace(/\x1b\].*?(\x07|\x1b\\)/g, '');
  if (stripped.includes('\r')) {
    const parts = stripped.split('\r');
    return parts[parts.length - 1] ?? '';
  }
  return stripped;
}

function containsTuiMarkers(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      line.includes('\x1b[?1049h') ||
      line.includes('\x1b[?1049l') ||
      line.includes('\x1b[2J') ||
      line.includes('\x1b[3J') ||
      line.includes('\x1b[H') ||
      /\x1b\[[0-9]+;[0-9]+H/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

test('ANSI and TUI Fidelity: Cursor movement, screen clearing, line rewriting, wrapped lines, Unicode, alternate-screen, and Codex output', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-ansi-fidelity-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir, maxSegmentLines: 100 });
  t.after(async () => {
    await store.dispose();
  });

  // 1. Cursor Movement Test
  // Applications like top, curses or status tickers use absolute coordinate cursor placement.
  const cursorInput = 'Header Line\n\x1b[10;20HCoordinate Placed Text\n\x1b[2AUp Two Lines\n';
  store.push(cursorInput);

  // 2. Screen Clearing Test
  // User or script executes `clear` (ESC[2J + ESC[H)
  const clearInput = 'Text Before Clear\n\x1b[2J\x1b[HText After Clear\n';
  store.push(clearInput);

  // 3. Line Rewriting Test (Carriage Return without Line Feed)
  // Progress spinners, download progress meters (curl, npm, docker)
  const rewritingInput = 'Task starting...\rTask in progress: 45%\rTask in progress: 100% [DONE]\n';
  store.push(rewritingInput);

  // 4. Wrapped Lines Test
  // Long compiler error or minified bundle traceback exceeding terminal columns
  const longLine = 'ERROR: Module build failed: ' + 'x'.repeat(450) + ' [end of error]\n';
  store.push(longLine);

  // 5. Unicode Test
  // Multi-byte UTF-8, box drawing characters, Asian scripts, emoji glyphs
  const unicodeInput = 'Box: ┌──────────┐ │ Unicode:  │ └──────────┘\n' +
    'International: こんにちは世界 · 你好世界 · مرحبا بالعالم\n' +
    'Emojis: 🚀 Rocket, ⚡ Lightning, 💻 Terminal, 🛠 Tools\n';
  store.push(unicodeInput);

  // 6. Alternate Screen Transitions Test
  // Full-screen TUI apps (vim, less, htop, Codex full screen) enter alternate buffer
  const altScreenInput = '\x1b[?1049h\x1b[2J\x1b[1;1H[Codex TUI Active Screen]\x1b[?1049l\nExited Codex\n';
  store.push(altScreenInput);

  // 7. Codex-like Interactive Output Test
  // Mix of status markers, thinking tokens, tool execution cards, streaming text
  const codexInput = '\x1b[38;5;33m● Codex Task Planning\x1b[0m\n' +
    'Analyzing requirements for Lane F...\n' +
    '┌─ Tool Execution: run_command ────────────────────────┐\n' +
    '│ $ pnpm test                                          │\n' +
    '│ All 232 tests passed                                 │\n' +
    '└──────────────────────────────────────────────────────┘\n' +
    'Done with verification.\n';
  store.push(codexInput);

  await store.flush();

  // Retrieve complete history from store
  const page = await store.getPage(0, 100, 'forward');
  assert.ok(page.totalLines >= 14, `Expected at least 14 lines, got ${page.totalLines}`);

  // Test 1: Verify cursor movement sequences are preserved verbatim on disk and cleaned for transcript
  const cursorLine = page.lines.find((l) => l.includes('Coordinate Placed Text'));
  assert.ok(cursorLine, 'Cursor line must exist in stored history');
  assert.ok(cursorLine.includes('\x1b[10;20H'), 'Raw ANSI cursor coordinates preserved in persistent storage');
  const cleanedCursor = cleanAnsiForDisplay(cursorLine);
  assert.equal(cleanedCursor, 'Coordinate Placed Text', 'Cleaned display strips cursor codes');

  // Test 2: Verify screen clearing is preserved in history
  const beforeClear = page.lines.find((l) => l.includes('Text Before Clear'));
  const afterClear = page.lines.find((l) => l.includes('Text After Clear'));
  assert.ok(beforeClear, 'History retains text emitted BEFORE screen clear');
  assert.ok(afterClear, 'History retains text emitted AFTER screen clear');
  assert.ok(afterClear.includes('\x1b[2J'), 'Clear sequence preserved in storage');

  // Test 3: Line rewriting resolution
  const rewriteLine = page.lines.find((l) => l.includes('Task in progress'));
  assert.ok(rewriteLine, 'Line rewriting progress line exists');
  const cleanedRewrite = cleanAnsiForDisplay(rewriteLine);
  assert.equal(cleanedRewrite, 'Task in progress: 100% [DONE]', 'Resolved carriage return accurately shows final state');

  // Test 4: Wrapped long line fidelity
  const foundLongLine = page.lines.find((l) => l.startsWith('ERROR: Module build failed:'));
  assert.ok(foundLongLine, 'Long wrapped line found');
  assert.equal(foundLongLine.length, longLine.trimEnd().length, 'Long line length matches exactly without truncating');

  // Test 5: Unicode and multi-byte fidelity
  const boxLine = page.lines.find((l) => l.includes('┌──────────┐'));
  assert.ok(boxLine, 'Box drawing characters preserved intact');
  const intlLine = page.lines.find((l) => l.includes('こんにちは世界'));
  assert.ok(intlLine, 'Multi-byte Asian script preserved intact');
  const emojiLine = page.lines.find((l) => l.includes('🚀 Rocket'));
  assert.ok(emojiLine, 'Multi-byte 4-byte UTF-8 emojis preserved intact');

  // Test 6: Alternate screen detection
  assert.equal(containsTuiMarkers(page.lines), true, 'TUI markers detected in stored history');
  const altScreenLine = page.lines.find((l) => l.includes('\x1b[?1049h'));
  assert.ok(altScreenLine, 'Alternate screen entry sequence preserved');

  // Test 7: Codex-like output preservation
  const codexToolCard = page.lines.find((l) => l.includes('Tool Execution: run_command'));
  assert.ok(codexToolCard, 'Codex tool execution card header preserved');
  const passLine = page.lines.find((l) => l.includes('All 232 tests passed'));
  assert.ok(passLine, 'Codex nested test output preserved');
});
