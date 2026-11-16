import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareTerminalCommandHistory } from './terminal-command-history.js';
import { terminalCommandHistoryPath } from './paths.js';
import { spawn } from 'node-pty';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-term-hist-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('terminalCommandHistoryPath rejects invalid or path traversal historyId', () => {
  assert.throws(() => terminalCommandHistoryPath('../escape'), /Invalid historyId/);
  assert.throws(() => terminalCommandHistoryPath('sub/dir/id'), /Invalid historyId/);
  assert.throws(() => terminalCommandHistoryPath(''), /Invalid historyId/);
  assert.throws(() => terminalCommandHistoryPath('id with spaces'), /Invalid historyId/);

  const valid = terminalCommandHistoryPath('a1b2-c3d4_e5f6');
  assert.ok(valid.endsWith('a1b2-c3d4_e5f6.history'));
});

test('prepareTerminalCommandHistory creates isolated file with 0600 permissions', async () => {
  await withTempDir(async (dir) => {
    const historyId = 'term-tab-001';
    const histPath = await prepareTerminalCommandHistory(historyId, 'bash', {
      baseDir: dir,
      maxSeedLines: 0,
    });

    assert.equal(histPath, path.join(dir, `${historyId}.history`));
    assert.ok(existsSync(histPath), 'History file must be created on disk');

    const fileStat = await stat(histPath);
    // On POSIX systems, verify 0600 permissions
    if (process.platform !== 'win32') {
      const mode = fileStat.mode & 0o777;
      assert.equal(mode, 0o600, 'History file must have 0600 permissions');
    }
  });
});

test('prepareTerminalCommandHistory seeds from source history up to maxSeedLines on first launch', async () => {
  await withTempDir(async (dir) => {
    const sourceHistory = path.join(dir, 'source_bash_history');
    const sourceLines = [
      'git status',
      'npm test',
      'git commit -m "initial"',
      'agy --profile default',
      'codex --model sonnet',
    ];
    await writeFile(sourceHistory, sourceLines.join('\n') + '\n', { mode: 0o600 });

    const historyId = 'term-tab-seed-test';
    const histPath = await prepareTerminalCommandHistory(historyId, 'bash', {
      baseDir: dir,
      sourceHistoryPath: sourceHistory,
      maxSeedLines: 3,
    });

    const content = await readFile(histPath, 'utf-8');
    const lines = content.trim().split('\n');

    assert.equal(lines.length, 3, 'Must seed only the last 3 lines');
    assert.deepEqual(lines, [
      'git commit -m "initial"',
      'agy --profile default',
      'codex --model sonnet',
    ]);
  });
});

test('prepareTerminalCommandHistory preserves existing history on restart and never overwrites', async () => {
  await withTempDir(async (dir) => {
    const historyId = 'term-tab-persistence';

    // 1. First launch prepares history
    const histPath = await prepareTerminalCommandHistory(historyId, 'bash', {
      baseDir: dir,
      maxSeedLines: 0,
    });

    // 2. User executes commands in the terminal
    await writeFile(histPath, 'pnpm build\nclaude --resume session-123\n', { mode: 0o600 });

    // 3. Simulated reboot: prepareTerminalCommandHistory runs again with the same historyId
    const resumedPath = await prepareTerminalCommandHistory(historyId, 'bash', {
      baseDir: dir,
      sourceHistoryPath: path.join(dir, 'dummy-source'),
      maxSeedLines: 100,
    });

    assert.equal(resumedPath, histPath);
    const content = await readFile(resumedPath, 'utf-8');
    assert.equal(
      content,
      'pnpm build\nclaude --resume session-123\n',
      'Existing commands must be preserved across restarts and reboots',
    );
  });
});

test('distinct terminals maintain completely isolated history files', async () => {
  await withTempDir(async (dir) => {
    const idA = 'term-tab-A';
    const idB = 'term-tab-B';

    const pathA = await prepareTerminalCommandHistory(idA, 'bash', { baseDir: dir, maxSeedLines: 0 });
    const pathB = await prepareTerminalCommandHistory(idB, 'bash', { baseDir: dir, maxSeedLines: 0 });

    assert.notEqual(pathA, pathB);

    // Terminal A runs coding CLI
    await writeFile(pathA, 'codex --model pro\n', { mode: 0o600 });
    // Terminal B runs git commands
    await writeFile(pathB, 'git log -n 5\n', { mode: 0o600 });

    const contentA = await readFile(pathA, 'utf-8');
    const contentB = await readFile(pathB, 'utf-8');

    assert.equal(contentA.trim(), 'codex --model pro');
    assert.equal(contentB.trim(), 'git log -n 5');
    assert.ok(!contentA.includes('git log'), 'Terminal A must not contain Terminal B history');
    assert.ok(!contentB.includes('codex'), 'Terminal B must not contain Terminal A history');
  });
});

test('real bash PTY writes command to HISTFILE immediately and recovers upon new session', async () => {
  await withTempDir(async (dir) => {
    const historyId = 'pty-real-bash-test';
    const histPath = await prepareTerminalCommandHistory(historyId, 'bash', {
      baseDir: dir,
      maxSeedLines: 0,
    });

    // Spawn an interactive bash PTY with PROMPT_COMMAND flushing to histPath
    const env = {
      ...process.env,
      HISTFILE: histPath,
      MAW_TERMINAL_HISTFILE: histPath,
      PROMPT_COMMAND: `history -a "${histPath}" 2>/dev/null || true`,
      TERM: 'xterm-256color',
    };

    const ptyProcess = spawn('bash', ['--norc', '-i'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env,
    });

    // Write a test command
    const testCommand = 'echo "MAW_PER_TERMINAL_CLI_READY"';
    ptyProcess.write(`${testCommand}\r`);

    // Wait for command execution and prompt command flush
    let output = '';
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          if (existsSync(histPath)) {
            const content = await readFile(histPath, 'utf-8');
            if (content.includes('MAW_PER_TERMINAL_CLI_READY')) {
              clearInterval(timer);
              resolve();
              return;
            }
          }
          if (Date.now() - started > 5000) {
            clearInterval(timer);
            reject(new Error(`Timeout waiting for history write. Current output: ${output}`));
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, 50);

      ptyProcess.onData((chunk) => {
        output += chunk;
      });
    });

    ptyProcess.kill();

    // Verify file content on disk
    const savedContent = await readFile(histPath, 'utf-8');
    assert.ok(
      savedContent.includes('MAW_PER_TERMINAL_CLI_READY'),
      'Command must be flushed to per-terminal history file before shell exit',
    );

    // Now simulate terminal recovery in a fresh PTY: read history from disk
    const recoverPty = spawn('bash', ['--norc', '-i'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env,
    });

    let recoverOutput = '';
    const recoverStarted = Date.now();
    recoverPty.onData((chunk) => {
      recoverOutput += chunk;
    });

    // Ask bash to display its loaded history
    recoverPty.write('history 2\r');

    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (recoverOutput.includes('MAW_PER_TERMINAL_CLI_READY')) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - recoverStarted > 5000) {
          clearInterval(timer);
          reject(new Error(`Timeout waiting for history recall. Output: ${recoverOutput}`));
        }
      }, 50);
    });

    recoverPty.kill();
    assert.ok(
      recoverOutput.includes('MAW_PER_TERMINAL_CLI_READY'),
      'Recovered terminal PTY must load previously executed commands from history',
    );
  });
});

test('TerminalRegistry assigns historyId to shell terminal descriptor and entry', async () => {
  await withTempDir(async (dir) => {
    const { TerminalRegistry } = await import('./terminal-registry.js');
    const { AgentRegistry } = await import('./agents/registry.js');
    const { WorkspaceStore } = await import('./workspace-store.js');

    class MemoryWorkspaceStore extends WorkspaceStore {
      override save(): void {}
      override async load() { return { tabs: [], foreignTabs: [] }; }
    }

    const registry = new TerminalRegistry(
      new AgentRegistry([]),
      { file: '/bin/sh', args: ['-i'], name: 'sh' },
      new MemoryWorkspaceStore(path.join(dir, 'workspace.json')),
      undefined,
      undefined,
      undefined,
      { persistentPty: false },
    );

    const explicitHistoryId = 'custom-term-history-uuid-999';
    const term = await registry.open({
      cwd: dir,
      kind: 'shell',
      historyId: explicitHistoryId,
    });

    assert.equal(term.historyId, explicitHistoryId, 'Descriptor must reflect provided historyId');
    const stored = registry.get(term.terminalId);
    assert.equal(stored?.historyId, explicitHistoryId, 'Stored terminal entry must retain historyId');

    // Without explicit historyId, defaults to terminalId
    const defaultTerm = await registry.open({
      cwd: dir,
      kind: 'shell',
    });
    assert.equal(
      defaultTerm.historyId,
      defaultTerm.terminalId,
      'When historyId is omitted, defaults to terminalId',
    );

    registry.disposeAll();
  });
});

