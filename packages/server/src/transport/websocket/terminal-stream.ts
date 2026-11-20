/**
 * One socket's view of terminal output.
 *
 * A stream owns, for a single connection: which terminals the socket is
 * attached to (an attachment is a lease identified by a symbol, so a stale
 * completion cannot revive a revoked grant), the replay in flight, output
 * batching and backpressure. Nothing here survives the socket: closing the
 * connection revokes every lease and the terminals keep running.
 */

import type { TerminalId } from '@agent-workbench/shared';
import type { WebSocket } from 'ws';
import type { OutputListener, TerminalRegistry } from '../../features/terminals/terminal-registry.js';
import { OutputBackpressure } from './output-backpressure.js';
import type { SocketHub } from './socket-hub.js';
import type { HistoryBinding, TerminalHistoryAccess } from './terminal-history-access.js';
import { TerminalOutputBatcher } from './terminal-output-batcher.js';

export interface TerminalStreamDeps {
  socket: WebSocket;
  registry: TerminalRegistry;
  send: SocketHub['send'];
  historyAccessReason: TerminalHistoryAccess['historyAccessReason'];
}

export interface TerminalStream {
  /** A lease is established in command order, independently of graphical replay. Its identity protects pending history reads and stale replay completions. */
  readonly attachedTerminals: Map<TerminalId, symbol>;
  readonly historyReads: Set<TerminalId>;
  readonly backpressure: OutputBackpressure;
  revokeTerminalAttachment(terminalId: TerminalId): void;
  replayTerminal(
    terminalId: TerminalId,
    sinceOffset: number | undefined,
    canDeliver: () => boolean,
  ): Promise<boolean | null>;
  /** The history binding this socket registers so state changes can revoke its leases. */
  readonly historyBinding: HistoryBinding;
  /** Revoke every lease and cancel every replay in flight. */
  revokeAll(): void;
  /** Release batching and backpressure state. */
  disposeOutput(): void;
  /** Detach the output listener from every terminal and forget the leases. */
  finish(): void;
}

export function createTerminalStream(deps: TerminalStreamDeps): TerminalStream {
  const { socket, registry, send, historyAccessReason } = deps;

  // A lease is established in command order, independently of graphical replay.
  // Its identity protects pending history reads and stale replay completions.
  const attachedTerminals = new Map<TerminalId, symbol>();

  const historyReads = new Set<TerminalId>();

  // Un oyente por socket. Se engancha y desengancha de terminales concretas
  // sin que ninguna se entere de que hubo una reconexion.
  // A client that stops reading must not make the server buffer PTY output without bound (audit N-3):
  // over the high-water mark output is skipped, and once the socket drains the client gets the replay.
  const sentOffsets = new Map<TerminalId, number>();

  const replaying = new Map<TerminalId, {
    frames: { data: string; offset?: number }[]; bytes: number; abort: AbortController;
  }>();

  const cancelReplay = (terminalId: TerminalId): void => {
    const pending = replaying.get(terminalId);
    if (!pending) return;
    replaying.delete(terminalId);
    pending.frames.length = 0;
    pending.abort.abort();
  };

  const backpressure = new OutputBackpressure(socket, (terminalIds) => {
    for (const terminalId of terminalIds) {
      const grant = attachedTerminals.get(terminalId);
      if (!grant) continue;

      const canDeliver = (): boolean =>
        socket.readyState === socket.OPEN &&
        attachedTerminals.get(terminalId) === grant &&
        historyAccessReason(terminalId) === null;

      if (!canDeliver()) continue;
      void replayTerminal(
        terminalId,
        sentOffsets.get(terminalId),
        canDeliver,
      ).catch(error => {
        console.error('[terminal] Backpressure recovery failed:', String(error));
      });
    }
  });

  const sendOutput = (terminalId: TerminalId, data: string, offset?: number): void => {
    send(socket, { type: 'terminal.output', terminalId, data,
      ...(offset !== undefined ? { offset } : {}) });
    if (offset !== undefined) sentOffsets.set(terminalId, offset);
  };

  const outputBatcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 64 * 1024,
    onFlush: (terminalId, data, offset) => {
      if (!attachedTerminals.has(terminalId) || socket.readyState !== socket.OPEN) return;
      if (historyAccessReason(terminalId) !== null) {
        revokeTerminalAttachment(terminalId);
        return;
      }
      const pending = replaying.get(terminalId);
      if (pending) {
        pending.bytes += Buffer.byteLength(data);
        if (pending.bytes > 8 * 1024 * 1024) {
          // Bound recovery buffering. A new attachment gets a fresh checkpoint.
          socket.close(1013, 'Terminal recovery backlog exceeded');
          return;
        }
        pending.frames.push({ data, offset });
      } else sendOutput(terminalId, data, offset);
    },
  });

  const listener: OutputListener = (terminalId, chunk, offset) => {
    if (!attachedTerminals.has(terminalId) || socket.readyState !== socket.OPEN) return;
    if (historyAccessReason(terminalId) !== null) {
      revokeTerminalAttachment(terminalId);
      return;
    }
    if (replaying.has(terminalId) || backpressure.shouldSend(terminalId)) {
      outputBatcher.push(terminalId, chunk, offset);
      if (process.env.MAW_OUTPUT_BATCHING === '0') outputBatcher.flush(terminalId);
    }
  };

  const replayTerminal = async (
    terminalId: TerminalId,
    sinceOffset: number | undefined,
    canDeliver: () => boolean,
  ): Promise<boolean | null> => {
    outputBatcher.flush(terminalId);
    cancelReplay(terminalId);
    const pending = { frames: [] as { data: string; offset?: number }[], bytes: 0, abort: new AbortController() };
    // Cancellation settles the socket operation even if a checkpoint provider
    // ignores AbortSignal. The real renderer also cancels its snapshot waiter.
    const cancelled = new Promise<null>(resolve => {
      pending.abort.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    replaying.set(terminalId, pending);
    try {
      const attached = await Promise.race([
        registry.renderingReplay(terminalId, listener, sinceOffset, pending.abort.signal),
        cancelled,
      ]);
      if (replaying.get(terminalId) !== pending) return null;
      if (!canDeliver()) {
        revokeTerminalAttachment(terminalId);
        return null;
      }
      if (!attached) return false;
      send(socket, {
        type: 'terminal.replay', terminalId, data: attached.replay,
        truncated: attached.truncated, reset: attached.reset,
        startOffset: attached.startOffset, endOffset: attached.endOffset,
        offset: attached.endOffset, cols: attached.cols, rows: attached.rows,
      });
      sentOffsets.set(terminalId, attached.endOffset);
      outputBatcher.flush(terminalId);
      for (const frame of pending.frames) {
        if (!canDeliver()) { revokeTerminalAttachment(terminalId); return null; }
        if (frame.offset !== undefined && frame.offset <= attached.endOffset) continue;
        sendOutput(terminalId, frame.data, frame.offset);
      }
      return true;
    } catch (error) {
      if (pending.abort.signal.aborted || replaying.get(terminalId) !== pending) return null;
      if (socket.readyState === socket.OPEN) console.warn('[terminal] Recovery failed:', String(error));
      return false;
    } finally {
      if (replaying.get(terminalId) === pending) replaying.delete(terminalId);
      pending.abort.abort();
    }
  };

  const revokeTerminalAttachment = (terminalId: TerminalId): void => {
    attachedTerminals.delete(terminalId);
    cancelReplay(terminalId);
    outputBatcher.clear(terminalId);
    sentOffsets.delete(terminalId);
    registry.detach(terminalId, listener);
    backpressure.forget(terminalId);
  };

  const historyBinding: HistoryBinding = {
    refresh: () => {
      for (const terminalId of attachedTerminals.keys()) {
        if (historyAccessReason(terminalId) !== null) {
          revokeTerminalAttachment(terminalId);
        }
      }
    },
    clear: () => {
      for (const terminalId of attachedTerminals.keys()) {
        revokeTerminalAttachment(terminalId);
      }
    },
  };

  return {
    attachedTerminals,
    historyReads,
    backpressure,
    revokeTerminalAttachment,
    replayTerminal,
    historyBinding,
    revokeAll: () => {
      for (const terminalId of attachedTerminals.keys()) revokeTerminalAttachment(terminalId);
      for (const terminalId of replaying.keys()) cancelReplay(terminalId);
    },
    disposeOutput: () => {
      outputBatcher.dispose();
      sentOffsets.clear();
      backpressure.dispose();
    },
    finish: () => {
      registry.detachAll(listener);
      attachedTerminals.clear();
    },
  };
}
