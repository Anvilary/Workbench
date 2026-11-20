/**
 * Turns domain errors into protocol error messages.
 *
 * One place decides how a failure of a family of requests is reported to the
 * socket that made it, so the wording and the error codes stay consistent.
 */

import { ServerTextError, serverText } from '@agent-workbench/shared';
import type { WebSocket } from 'ws';
import { GitMissingError } from '../../features/git/git-repo.js';
import { TerminalOpenError } from '../../features/terminals/terminal-registry.js';
import { VaultError } from '../../features/vault/service.js';
import { WorktreeError } from '../../features/worktrees/service.js';
import type { SocketHub } from './socket-hub.js';

export interface ErrorReporters {
  sendWorktreeError(socket: WebSocket, error: unknown, requestId?: string): void;
  sendRemoteError(socket: WebSocket, error: unknown): void;
  sendVaultError(socket: WebSocket, error: unknown): void;
}

export function createErrorReporters(sendError: SocketHub['sendError']): ErrorReporters {
  /** Un pedido `worktree.*` que fallo: lo dice el dialogo que lo pidio (§6.38). */
  const sendWorktreeError = (socket: WebSocket, error: unknown, requestId?: string): void => {
    if (error instanceof TerminalOpenError) {
      sendError(socket, error.code, error.text, error.detail, requestId);
    } else if (error instanceof WorktreeError) {
      sendError(socket, 'worktree-failed', error.text, undefined, requestId);
    } else if (error instanceof GitMissingError) {
      sendError(socket, 'worktree-failed', serverText('gitMissing'), undefined, requestId);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn('[worktrees] a request failed:', detail);
      sendError(socket, 'worktree-failed', serverText('worktreeFailed'), detail, requestId);
    }
  };

  /** Un pedido `remote.*` que fallo: un `ServerTextError` trae el texto para el usuario. */
  const sendRemoteError = (socket: WebSocket, error: unknown): void => {
    if (error instanceof ServerTextError) {
      sendError(socket, 'remote-failed', error.text);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[remote] a request failed:', detail);
    sendError(socket, 'remote-failed', serverText('remoteFailed'), detail);
  };

  /**
   * Un pedido `vault.*` que fallo. Un `VaultError` trae el texto para el
   * usuario; cualquier otra cosa es un error de disco o de lectura, que va en
   * el detalle.
   */
  const sendVaultError = (socket: WebSocket, error: unknown): void => {
    if (error instanceof VaultError) {
      sendError(socket, 'vault-failed', error.text);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[vault] a request failed:', detail);
    sendError(socket, 'vault-failed', serverText('vaultFailed'), detail);
  };

  return { sendWorktreeError, sendRemoteError, sendVaultError };
}
