/**
 * Git messages: repository status and diffs addressed by terminal.
 */

import { parseGitDiff, parseGitStatus, type GitDiff, type GitStatus } from '../git/git.js';
import type { TerminalId } from '../sessions/models.js';
import { asNonEmptyString, type UnknownRecord } from '../validation/narrowing.js';

/**
 * Empieza a mirar el estado de git del `cwd` de esta pestana.
 *
 * Igual que la conversacion: refcount en el servidor, y el watcher del repo se
 * apaga cuando no queda nadie mirando. Un `git status` por pestana abierta,
 * corriendo para nadie, es exactamente lo que no queremos.
 */
export interface ClientSubscribeGitMessage {
  type: 'git.subscribe';
  terminalId: TerminalId;
}

export interface ClientUnsubscribeGitMessage {
  type: 'git.unsubscribe';
  terminalId: TerminalId;
}

/** Relee el estado ahora, sin esperar al watcher. */
export interface ClientRefreshGitMessage {
  type: 'git.refresh';
  terminalId: TerminalId;
}

/** Diff de un archivo. `path` es relativo a la raiz del repo. */
export interface ClientGitDiffMessage {
  type: 'git.diff';
  terminalId: TerminalId;
  path: string;
  /** true para el diff del area de staging. */
  staged: boolean;
}

/** Estado de git de una pestana. Llega al suscribirse y en cada cambio. */
export interface ServerGitStatusMessage {
  type: 'git.status';
  terminalId: TerminalId;
  status: GitStatus;
}

export interface ServerGitDiffMessage {
  type: 'git.diff';
  terminalId: TerminalId;
  diff: GitDiff;
}

/** Every client message of this family. */
export type ClientGitMessage =
  | ClientSubscribeGitMessage
  | ClientUnsubscribeGitMessage
  | ClientRefreshGitMessage
  | ClientGitDiffMessage;

/** Every server message of this family. */
export type ServerGitMessage =
  | ServerGitStatusMessage
  | ServerGitDiffMessage;

/** Parses the client messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseClientGitMessage(record: UnknownRecord): ClientGitMessage | null | undefined {
  switch (record['type']) {
    case 'git.subscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.subscribe', terminalId };
    }
    case 'git.unsubscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.unsubscribe', terminalId };
    }
    case 'git.refresh': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.refresh', terminalId };
    }
    case 'git.diff': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const diffPath = asNonEmptyString(record['path']);
      return terminalId === null || diffPath === null
        ? null
        : { type: 'git.diff', terminalId, path: diffPath, staged: record['staged'] === true };
    }
    default:
      return undefined;
  }
}

/** Parses the server messages of this family. `undefined` means the type belongs to another family; `null` means an invalid message. */
export function parseServerGitMessage(record: UnknownRecord): ServerGitMessage | null | undefined {
  switch (record['type']) {
    case 'git.status': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const status = parseGitStatus(record['status']);
      return terminalId === null || status === null
        ? null
        : { type: 'git.status', terminalId, status };
    }
    case 'git.diff': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const diff = parseGitDiff(record['diff']);
      return terminalId === null || diff === null
        ? null
        : { type: 'git.diff', terminalId, diff };
    }
    default:
      return undefined;
  }
}
