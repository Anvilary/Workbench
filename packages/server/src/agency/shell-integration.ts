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
import type { MawActivityState } from '@agent-workbench/shared';

export interface ShellCommandStartEvent {
  timestamp: number;
}

export interface ShellCommandExitEvent {
  exitCode: number;
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
    // Bounded buffer length to prevent memory leakage on massive binaries without escape codes
    if (this.buffer.length > 65536) {
      this.buffer = this.buffer.slice(-16384);
    }

    this.processBuffer();
  }

  private processBuffer(): void {
    // OSC 133 syntax: ESC ] 133 ; <command> [; <params>] (BEL | ESC \)
    // or 8-bit OSC \x9d 133 ; ...
    const oscPattern = /(?:\x1b\]|\x9d)133;([A-D])(?:;([^\x07\x1b]+))?(?:\x07|\x1b\\)/g;

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
          if (this.currentState !== 'finished') {
            this.currentState = 'idle';
            this.emit('state', 'idle', 'prompt-start');
          }
          break;

        case 'B': // Prompt end / command input ready
          if (this.currentState !== 'finished') {
            this.currentState = 'idle';
            this.emit('state', 'idle', 'prompt-end');
          }
          break;

        case 'C': // Command executed / output start
          this.currentState = 'working';
          this.lastCommandStartedAt = now;
          this.emit('commandStart', { timestamp: now });
          this.emit('state', 'working', 'command-started');
          break;

        case 'D': { // Command finished / command exited
          let exitCode = 0;
          if (params !== undefined && params.length > 0) {
            const parsed = parseInt(params.trim(), 10);
            if (!Number.isNaN(parsed)) {
              exitCode = parsed;
            }
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
