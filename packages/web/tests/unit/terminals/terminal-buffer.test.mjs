import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBufferText, extractLastOutput, isPromptLine } from '../../../src/features/terminals/terminal-buffer.ts';

test('isPromptLine accurately identifies shell prompts', () => {
  assert.equal(isPromptLine('user@host:~/project$ '), true);
  assert.equal(isPromptLine('bash-5.2$ '), true);
  assert.equal(isPromptLine('➜ my-repo git:(main) '), true);
  assert.equal(isPromptLine('❯ git status'), true);
  assert.equal(isPromptLine('root@server:# '), true);
  assert.equal(isPromptLine('alexandre@ubuntu:~$ ls -la'), true);
  assert.equal(isPromptLine('(my-venv) [user@fedora dir]$ '), true);

  assert.equal(isPromptLine(''), false);
  assert.equal(isPromptLine('   '), false);
  assert.equal(isPromptLine('Total cost: $45.00'), false);
  assert.equal(isPromptLine('100% completed'), false);
  assert.equal(isPromptLine('# Documentation header'), false);
});

test('extractBufferText preserves wrapped lines as continuous logical lines', () => {
  const lines = [
    { text: 'https://github.com/example/workbench/blob/main/', isWrapped: false },
    { text: 'packages/desktop/main.mjs#L123-L456', isWrapped: true },
    { text: 'Second logical line', isWrapped: false },
  ];

  const mockBuffer = {
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const extracted = extractBufferText(mockBuffer);
  const expected = 'https://github.com/example/workbench/blob/main/packages/desktop/main.mjs#L123-L456\nSecond logical line';
  assert.equal(extracted, expected);
});

test('extractBufferText handles multi-byte Unicode and emojis correctly', () => {
  const lines = [
    { text: 'Build status: ✅ Success · 🚀 Deployed', isWrapped: false },
    { text: 'Unicode test: 日本語, Español, Русский, 한국어, 🌟', isWrapped: false },
  ];

  const mockBuffer = {
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const extracted = extractBufferText(mockBuffer);
  assert.equal(extracted, 'Build status: ✅ Success · 🚀 Deployed\nUnicode test: 日本語, Español, Русский, 한국어, 🌟');
});

test('extractBufferText trims trailing empty lines but preserves internal empty lines', () => {
  const lines = [
    { text: 'Header', isWrapped: false },
    { text: '', isWrapped: false },
    { text: 'Body text', isWrapped: false },
    { text: '', isWrapped: false },
    { text: '   ', isWrapped: false },
  ];

  const mockBuffer = {
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const extracted = extractBufferText(mockBuffer);
  assert.equal(extracted, 'Header\n\nBody text');
});

test('extractLastOutput with OSC 133 command start marker', () => {
  const lines = [
    { text: 'previous output from earlier command', isWrapped: false },
    { text: 'user@box:~$ pnpm test', isWrapped: false },
    { text: 'Test Suite running...', isWrapped: false },
    { text: '✔ all 45 tests passed', isWrapped: false },
    { text: 'user@box:~$ ', isWrapped: false },
  ];

  const mockBuffer = {
    type: 'normal',
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const mockTerminal = {
    rows: 24,
    buffer: { active: mockBuffer },
  };

  // Marker at line 2 (start of pnpm test output)
  const mockMarker = { line: 2, isDisposed: false };
  const output = extractLastOutput(mockTerminal, mockMarker);
  assert.equal(output, 'Test Suite running...\n✔ all 45 tests passed');
});

test('extractLastOutput with prompt boundary detection fallback', () => {
  const lines = [
    { text: 'old output 1', isWrapped: false },
    { text: 'user@box:~$ git status', isWrapped: false },
    { text: 'On branch fix/maw-terminal-clipboard', isWrapped: false },
    { text: 'nothing to commit, working tree clean', isWrapped: false },
    { text: 'user@box:~$ ', isWrapped: false },
  ];

  const mockBuffer = {
    type: 'normal',
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const mockTerminal = {
    rows: 24,
    buffer: { active: mockBuffer },
  };

  const output = extractLastOutput(mockTerminal, null);
  assert.equal(output, 'On branch fix/maw-terminal-clipboard\nnothing to commit, working tree clean');
});

test('extractLastOutput in alternate-screen buffer mode copies active screen', () => {
  const lines = [
    { text: '┌─ Codex CLI v0.8.1 ──────────────────────┐', isWrapped: false },
    { text: '│ Interactive mode active                 │', isWrapped: false },
    { text: '│ > Reviewing diff                        │', isWrapped: false },
    { text: '└─────────────────────────────────────────┘', isWrapped: false },
  ];

  const mockBuffer = {
    type: 'alternate',
    length: lines.length,
    getLine: (i) => lines[i] ? {
      isWrapped: lines[i].isWrapped,
      translateToString: () => lines[i].text,
    } : undefined,
  };

  const mockTerminal = {
    rows: 4,
    buffer: { active: mockBuffer },
  };

  const output = extractLastOutput(mockTerminal, null);
  assert.equal(output, '┌─ Codex CLI v0.8.1 ──────────────────────┐\n│ Interactive mode active                 │\n│ > Reviewing diff                        │\n└─────────────────────────────────────────┘');
});
