/**
 * What a message handler is allowed to touch.
 *
 * `FullContext` is everything the transport can offer for one connection:
 * the application services, the socket hub, terminal commands, error reporters,
 * history access and the state that belongs to this socket. A handler never
 * receives all of it. It declares the keys it uses with
 * `HandlerContext<'registry' | 'send'>`, so the compiler rejects a handler that
 * reaches for a service it did not declare.
 */

import type { ServerText, TerminalId } from '@agent-workbench/shared';
import type { WebSocket } from 'ws';
import type { CliFolders } from '../../features/files/cli-folders.js';
import type { DirectoryPickers } from '../../features/files/directory-picker.js';
import type { GlobalSearchSlot } from '../../features/history/global-search.js';
import type { ErrorReporters } from './error-reporters.js';
import type { OutputBackpressure } from './output-backpressure.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalCommands } from './terminal-commands.js';
import type { TerminalHistoryAccess } from './terminal-history-access.js';
import type { TerminalStream } from './terminal-stream.js';

/** State that belongs to one socket and dies with it. */
export interface ConnectionScope {
  readonly socket: WebSocket;
  /** The paired device this window entered as, or null for a window of the host. */
  readonly deviceId: string | null;
  readonly attachedTerminals: TerminalStream['attachedTerminals'];
  readonly historyReads: TerminalStream['historyReads'];
  readonly backpressure: OutputBackpressure;
  revokeTerminalAttachment: TerminalStream['revokeTerminalAttachment'];
  replayTerminal: TerminalStream['replayTerminal'];
  /** Conversations, repositories and memories this socket follows. They are released when it closes. */
  readonly subscriptions: Set<TerminalId>;
  readonly gitSubscriptions: Set<TerminalId>;
  readonly memorySubscriptions: Set<TerminalId>;
  /**
    Los selectores de carpeta son **de este socket** y mueren con el. No hay
    nada que sobreviva a la conexion que los pidio.
  */
  readonly pickers: DirectoryPickers;
  readonly folders: Promise<CliFolders>;
  /** La busqueda global en curso de este socket: una nueva o el cierre la cancelan. */
  readonly globalSearch: GlobalSearchSlot;
  cwdOf(terminalId: TerminalId): string | null;
  sendPathError(error: unknown, fallback: ServerText, requestId?: string): void;
  sendNotesError(error: unknown): void;
  sendMemoryError(error: unknown, requestId: string | undefined): void;
}

export type HistoryAccessApi = Pick<
  TerminalHistoryAccess,
  'closingTerminals' | 'historyAccessReason' | 'getHistoryStore' | 'retireHistoryStore'
>;

export type FullContext = WorkbenchServices &
  SocketHub &
  TerminalCommands &
  ErrorReporters &
  HistoryAccessApi &
  ConnectionScope;

export type HandlerContext<K extends keyof FullContext> = Pick<FullContext, K>;
