/**
 * MAW Lane C - Shell Terminal Integration & Activity Detection.
 *
 * Implements OSC 133 semantic prompt/command sequences:
 *   - OSC 133 ; A ST : Prompt start
 *   - OSC 133 ; B ST : Prompt end / Command line input start
 *   - OSC 133 ; C ST : Command executed / command output start -> 'working'
 *   - OSC 133 ; D [; <exitCode>] ST : Command finished ->
 *       - exitCode 0: reliable completion -> 'finished'
 *       - exitCode != 0: command failed -> 'failed'
 *
 * CRITICAL SAFETY RULES:
 *   - Do NOT treat arbitrary PTY output or stream silence as proof that a command finished.
 *   - When shell integration hooks (OSC 133 or verified preexec/precmd) have not been established,
 *     the activity status MUST remain explicitly 'unknown'.
 */

import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MawActivityState } from '@agent-workbench/shared';

export interface ShellCommandStartEvent {
  timestamp: number;
}

export interface ShellCommandExitEvent {
  exitCode: number | null;
  timestamp: number;
  reliable: boolean;
}

export interface ShellIntegrationEvents {
  state: (state: MawActivityState, detail?: string) => void;
  commandStart: (event: ShellCommandStartEvent) => void;
  commandExit: (event: ShellCommandExitEvent) => void;
}

/**
 * Streaming parser for OSC 133 sequences across arbitrary PTY chunks.
 */
export class ShellIntegrationParser extends EventEmitter {
  private buffer = '';
  private integrationEstablished = false;
  private currentState: MawActivityState = 'unknown';
  private lastExitCode: number | null = null;
  private lastCommandStartedAt: number | null = null;
  private commandActive = false;

  constructor() {
    super();
  }

  /**
   * Current activity state according to shell integration signals.
   * Returns 'unknown' if shell integration has not been observed.
   */
  getState(): MawActivityState {
    if (!this.integrationEstablished) {
      return 'unknown';
    }
    return this.currentState;
  }

  isIntegrationEstablished(): boolean {
    return this.integrationEstablished;
  }

  hasIntegration(): boolean {
    return this.integrationEstablished;
  }

  getLastExitCode(): number | null {
    return this.lastExitCode;
  }

  getLastCommandStartedAt(): number | null {
    return this.lastCommandStartedAt;
  }

  /**
   * Resets activity state to 'idle' after the user has inspected/acknowledged
   * the finished command result.
   */
  acknowledge(): void {
    if (this.currentState === 'finished') {
      this.currentState = 'idle';
      this.emit('state', 'idle', 'acknowledged');
    }
  }

  /**
   * Feeds a raw chunk from the shell PTY stream into the parser.
   */
  feed(chunk: string): void {
    if (!chunk || chunk.length === 0) return;

    this.buffer += chunk;
    this.processBuffer();
    // Process complete sequences before trimming: a large output chunk can contain commands.
    if (this.buffer.length > 65536) this.buffer = this.buffer.slice(-16384);
  }

  private processBuffer(): void {
    // OSC 133 syntax: ESC ] 133 ; <command> [; <params>] (BEL | ESC \)
    // or 8-bit OSC \x9d 133 ; ...
    const oscPattern = /(?:\x1b\]|\x9d)133;([A-D])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

    let match: RegExpExecArray | null;
    let lastProcessedIndex = 0;

    while ((match = oscPattern.exec(this.buffer)) !== null) {
      this.integrationEstablished = true;
      const type = match[1];
      const params = match[2];
      lastProcessedIndex = oscPattern.lastIndex;

      const now = Date.now();

      switch (type) {
        case 'A': // Prompt start
          // If we were finished, we stay finished until inspected/acknowledged by user
          // If we were unknown or failed, prompt start indicates shell is ready
          if (!this.commandActive && this.currentState !== 'finished' && this.currentState !== 'failed' && (this.currentState !== 'unknown' || this.lastCommandStartedAt === null)) {
            this.currentState = 'idle';
            this.emit('state', 'idle', 'prompt-start');
          }
          break;

        case 'B': // Prompt end / command input ready
          if (!this.commandActive && this.currentState !== 'finished' && this.currentState !== 'failed' && (this.currentState !== 'unknown' || this.lastCommandStartedAt === null)) {
            this.currentState = 'idle';
            this.emit('state', 'idle', 'prompt-end');
          }
          break;

        case 'C': // Command executed / output start
          if (this.commandActive) break;
          this.commandActive = true;
          this.currentState = 'working';
          this.lastCommandStartedAt = now;
          this.emit('commandStart', { timestamp: now });
          this.emit('state', 'working', 'command-started');
          break;

        case 'D': { // Command finished / command exited
          // precmd also runs on startup and prompt redraw. Neither is a completed command.
          if (!this.commandActive) break;
          this.commandActive = false;
          // Requirement: never interpret missing, malformed or nonnumeric exit codes as successful exit code 0.
          // Preserve Unknown when completion cannot be established.
          const trimmed = params?.trim();
          if (!trimmed || !/^-?\d+$/.test(trimmed)) {
            // Missing, malformed or nonnumeric exit code
            this.lastExitCode = null;
            this.currentState = 'unknown';
            this.emit('commandExit', { exitCode: null, timestamp: now, reliable: false });
            this.emit('state', 'unknown', 'command-exit-unverified');
            break;
          }

          const exitCode = Number(trimmed);
          if (!Number.isSafeInteger(exitCode)) {
            this.lastExitCode = null;
            this.currentState = 'unknown';
            this.emit('state', 'unknown', 'command-exit-unverified');
            break;
          }
          this.lastExitCode = exitCode;

          if (exitCode === 0) {
            this.currentState = 'finished';
            this.emit('commandExit', { exitCode: 0, timestamp: now, reliable: true });
            this.emit('state', 'finished', 'command-succeeded');
          } else {
            this.currentState = 'failed';
            this.emit('commandExit', { exitCode, timestamp: now, reliable: true });
            this.emit('state', 'failed', `command-exited-with-code-${exitCode}`);
          }
          break;
        }
      }
    }

    if (lastProcessedIndex > 0) {
      this.buffer = this.buffer.slice(lastProcessedIndex);
    }
  }

  /**
   * Clean up listeners and reset buffer.
   */
  dispose(): void {
    this.buffer = '';
    this.removeAllListeners();
  }
}

/**
 * Shell integration sequences generator (e.g. for preexec/precmd scripts or test harness).
 */
export const ShellSequences = {
  promptStart: '\x1b]133;A\x07',
  promptEnd: '\x1b]133;B\x07',
  commandStart: '\x1b]133;C\x07',
  commandExit: (exitCode: number = 0) => `\x1b]133;D;${exitCode}\x07`,
} as const;

/**
 * Generates safe Bash shell integration script.
 * Safely hooks command-start via PS0 and prompt lifecycle via PROMPT_COMMAND/PS1;
 * never overwrites existing functions or user dotfiles.
 */
export function generateBashIntegrationScript(): string {
  return `#!/usr/bin/env bash
# MAW Safe Bash Shell Integration (OSC 133)
# Safely hooks command start and exit without overwriting user configuration.

if [[ -n "\${MAW_TERMINAL_HISTFILE:-}" ]]; then
  export HISTFILE="\$MAW_TERMINAL_HISTFILE"
fi

__maw_osc133_precmd() {
  local last_status="$?"
  if [[ -n "\${MAW_TERMINAL_HISTFILE:-}" ]]; then
    history -a "\$MAW_TERMINAL_HISTFILE" 2>/dev/null || history -a 2>/dev/null || true
  fi
  printf "\\033]133;D;%d\\007\\033]133;A\\007" "$last_status"
  return "$last_status"
}

# 1. Command exit and prompt start via PROMPT_COMMAND
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  if [[ " \${PROMPT_COMMAND[*]} " != *"__maw_osc133_precmd"* ]]; then
    PROMPT_COMMAND=(__maw_osc133_precmd "\${PROMPT_COMMAND[@]}")
  fi
elif [[ -z "\${PROMPT_COMMAND:-}" ]]; then
  PROMPT_COMMAND="__maw_osc133_precmd"
elif [[ "$PROMPT_COMMAND" != *"__maw_osc133_precmd"* ]]; then
  PROMPT_COMMAND="__maw_osc133_precmd; $PROMPT_COMMAND"
fi

# 2. Command start: PS0 is printed after command is entered, before execution starts
if [[ -z "\${PS0:-}" ]]; then
  PS0="\\033]133;C\\007"
elif [[ "$PS0" != *"133;C"* ]]; then
  PS0="\\033]133;C\\007$PS0"
fi

# 3. Prompt end: PS1 indicates command input line ready
if [[ -z "\${PS1:-}" ]]; then
  PS1="\\[\\033]133;B\\007\\]\\$ "
elif [[ "$PS1" != *"133;B"* ]]; then
  PS1="$PS1\\[\\033]133;B\\007\\]"
fi

# 4. Interactive CLI scrolling support: ensure Codex CLI runs inline with native scrollback
if command -v codex >/dev/null 2>&1 && ! type codex 2>/dev/null | grep -q "function\\|alias"; then
  alias codex='codex --no-alt-screen'
fi
`;
}

/**
 * Generates safe Zsh shell integration script.
 * Appends to precmd_functions and preexec_functions; never overwrites user configuration.
 */
export function generateZshIntegrationScript(): string {
  return `#!/usr/bin/env zsh
# MAW Safe Zsh Shell Integration (OSC 133)
# Safely hooks precmd and preexec without mutating user dotfiles.

if [[ -n "\${MAW_TERMINAL_HISTFILE:-}" ]]; then
  export HISTFILE="\$MAW_TERMINAL_HISTFILE"
  export HISTSIZE=10000
  export SAVEHIST=10000
  setopt INC_APPEND_HISTORY 2>/dev/null || true
fi

__maw_osc133_zsh_precmd() {
  local last_status="$?"
  if [[ -n "\${MAW_TERMINAL_HISTFILE:-}" ]]; then
    fc -W 2>/dev/null || true
  fi
  print -n "\\e]133;D;\${last_status}\\a"
  print -n "\\e]133;A\\a"
}

__maw_osc133_zsh_preexec() {
  print -n "\\e]133;C\\a"
}

autoload -Uz add-zsh-hook 2>/dev/null || true
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook precmd __maw_osc133_zsh_precmd
  add-zsh-hook preexec __maw_osc133_zsh_preexec
else
  typeset -ga precmd_functions
  precmd_functions+=(__maw_osc133_zsh_precmd)
  typeset -ga preexec_functions
  preexec_functions+=(__maw_osc133_zsh_preexec)
fi

if (( $+commands[codex] )) && [[ "$(which codex 2>/dev/null)" != *"alias"* && "$(which codex 2>/dev/null)" != *"function"* ]]; then
  alias codex='codex --no-alt-screen'
fi
`;
}

/**
 * Writes the standalone integration scripts safely into targetDir.
 * NEVER touches or alters user dotfiles (~/.bashrc, ~/.zshrc, etc.).
 */
export async function installShellIntegrationSafely(targetDir: string): Promise<{
  bashScriptPath: string;
  zshScriptPath: string;
}> {
  await mkdir(targetDir, { recursive: true });
  const bashScriptPath = path.join(targetDir, 'maw-bash-integration.sh');
  const zshScriptPath = path.join(targetDir, 'maw-zsh-integration.zsh');

  await writeFile(bashScriptPath, generateBashIntegrationScript(), { mode: 0o755 });
  await writeFile(zshScriptPath, generateZshIntegrationScript(), { mode: 0o755 });

  return { bashScriptPath, zshScriptPath };
}

/** Prepare only app-owned startup files; the user's files are sourced, never rewritten. */
export async function prepareIntegratedShell(
  launch: { file: string; args: readonly string[] },
  env: Record<string, string>,
  targetDir: string,
): Promise<{ launch: { file: string; args: readonly string[] }; env: Record<string, string> }> {
  const shell = path.basename(launch.file);
  if (process.platform === 'win32' || !['bash', 'zsh'].includes(shell) ||
      launch.args.some(arg => ['-c', '--command', '--norc', '--noprofile', '-f', '-l', '--login'].includes(arg))) {
    return { launch, env };
  }
  const scripts = await installShellIntegrationSafely(targetDir);
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  if (shell === 'bash') {
    const startup = path.join(targetDir, 'bashrc');
    await writeFile(startup, '[ ! -f "$HOME/.bashrc" ] || source "$HOME/.bashrc"\nsource ' + quote(scripts.bashScriptPath) + '\n', { mode: 0o600 });
    return { launch: { file: launch.file, args: ['--rcfile', startup, ...launch.args, '-i'] }, env };
  }
  const zdotdir = env['ZDOTDIR'] ?? env['HOME'] ?? '';
  // A private ZDOTDIR forwards startup to the original directory. Restore it before
  // user commands so nested shells retain their normal configuration.
  const restoreZdotdir = 'if [[ "$MAW_SHELL_ZDOTDIR_SET" = 1 ]]; then ZDOTDIR="$MAW_SHELL_ZDOTDIR"; else unset ZDOTDIR; fi\n';
  await writeFile(path.join(targetDir, '.zshenv'), restoreZdotdir +
    '[ ! -f "$MAW_SHELL_ZDOTDIR/.zshenv" ] || source "$MAW_SHELL_ZDOTDIR/.zshenv"\n' +
    'MAW_SHELL_ZDOTDIR_SET=${+ZDOTDIR}\nMAW_SHELL_ZDOTDIR="${ZDOTDIR:-$HOME}"\nZDOTDIR="$MAW_SHELL_INTEGRATION_DIR"\n', { mode: 0o600 });
  await writeFile(path.join(targetDir, '.zshrc'),
    restoreZdotdir + '[ ! -f "$MAW_SHELL_ZDOTDIR/.zshrc" ] || source "$MAW_SHELL_ZDOTDIR/.zshrc"\nsource ' + quote(scripts.zshScriptPath) + '\n' +
    'unset MAW_SHELL_ZDOTDIR MAW_SHELL_INTEGRATION_DIR MAW_SHELL_ZDOTDIR_SET\n', { mode: 0o600 });
  return { launch: { file: launch.file, args: [...launch.args, '-i'] },
    env: { ...env, ZDOTDIR: targetDir, MAW_SHELL_ZDOTDIR: zdotdir, MAW_SHELL_INTEGRATION_DIR: targetDir,
      MAW_SHELL_ZDOTDIR_SET: env['ZDOTDIR'] === undefined ? '0' : '1' } };
}
