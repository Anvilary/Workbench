/**
 * Who may read a terminal's persistent history, and the stores that hold it.
 *
 * This module is the single owner of the per-terminal `TerminalHistoryStore`
 * instances and of the rule that decides whether a socket may still read or
 * receive output of a terminal (`historyAccessReason`). Sockets register a
 * binding so that a change of workspace, session or terminal state revokes
 * their attachments immediately.
 */

import type { TerminalId } from '@agent-workbench/shared';
import type { WebSocket } from 'ws';
import { AgencySessionRuntime } from '../../features/sessions/session-runtime.js';
import { TerminalHistoryStore } from '../../features/terminals/terminal-history-store.js';
import type { TerminalRegistry } from '../../features/terminals/terminal-registry.js';
import { AgencyWorkspaceStore } from '../../features/workspaces/workspace-store.js';

export interface HistoryBinding {
  /** Revoke every attachment that is no longer authorized. */
  refresh(): void;
  /** Revoke every attachment. */
  clear(): void;
}

export interface TerminalHistoryAccessDeps {
  registry: TerminalRegistry;
  agencyRuntime: AgencySessionRuntime;
  agencyWorkspaceStore: AgencyWorkspaceStore;
  /** Injectable persistence factory for isolated history tests. */
  historyStoreFactory?: (terminalId: TerminalId) => TerminalHistoryStore;
}

export interface TerminalHistoryAccess {
  readonly closingTerminals: Set<TerminalId>;
  /** One binding per socket, owned by the connection. */
  readonly historyBindings: Map<WebSocket, HistoryBinding>;
  refreshHistoryBindings(): void;
  retireHistoryStore(terminalId: TerminalId): void;
  /** Retire the stores of terminals the registry no longer knows. */
  retireMissingStores(): void;
  historyAccessReason(terminalId: TerminalId): string | null;
  getHistoryStore(terminalId: TerminalId): TerminalHistoryStore | null;
  /** Stop handing out stores, retire all of them and wait for pending flushes. */
  shutdown(): Promise<void>;
}

export function createTerminalHistoryAccess(deps: TerminalHistoryAccessDeps): TerminalHistoryAccess {
  const { registry, agencyRuntime, agencyWorkspaceStore } = deps;
  const options = { historyStoreFactory: deps.historyStoreFactory };

  /*
    Almacen de historial persistente por terminal (Lane F).
  */
  const historyStores = new Map<TerminalId, TerminalHistoryStore>();

  const historyDisposals = new Set<Promise<void>>();

  const closingTerminals = new Set<TerminalId>();

  const historyBindings = new Map<WebSocket, HistoryBinding>();

  const refreshHistoryBindings = (): void => {
    for (const binding of historyBindings.values()) binding.refresh();
  };

  let historyStopped = false;

  const retireHistoryStore = (terminalId: TerminalId): void => {
    const store = historyStores.get(terminalId);
    if (!store) return;
    historyStores.delete(terminalId);
    const pending = store.dispose().catch(() => {
      console.warn('[terminal-history] Failed to flush a retired store');
    });
    historyDisposals.add(pending);
    void pending.finally(() => historyDisposals.delete(pending));
  };

  // MAW has one authenticated owner, including explicitly paired devices. An
  // attachment is a socket binding, not a separate user or workspace credential.
  const historyAccessReason = (terminalId: TerminalId): string | null => {
    if (historyStopped || closingTerminals.has(terminalId) || !registry.has(terminalId)) return 'Terminal not found';
    const session = agencyRuntime.list().find(item => item.terminalId === terminalId);
    if (!session && registry.nativeIdentityOf(terminalId) !== undefined) return 'Unauthorized workspace session access';
    if (session) {
      const workspace = agencyWorkspaceStore.getWorkspace(session.workspaceId);
      if (!workspace || workspace.status !== 'active' || session.lifecycle === 'stopping' || session.tab?.closedAt || session.tab?.current === false) {
        return 'Unauthorized workspace session access';
      }
    }
    return null;
  };

  /**
   * Obtiene o instancia el almacen de historial persistente para una terminal activa.
   */
  const getHistoryStore = (terminalId: TerminalId): TerminalHistoryStore | null => {
    if (historyStopped) return null;
    let store = historyStores.get(terminalId);
    if (!store && registry.has(terminalId)) {
      try {
        store = options.historyStoreFactory?.(terminalId) ?? new TerminalHistoryStore(terminalId);
        historyStores.set(terminalId, store);
      } catch {
        return null;
      }
    }
    return store ?? null;
  };

  const retireMissingStores = (): void => {
    for (const terminalId of historyStores.keys()) {
      if (!registry.has(terminalId)) retireHistoryStore(terminalId);
    }
  };

  const shutdown = (): Promise<void> => {
    historyStopped = true;
    for (const terminalId of historyStores.keys()) retireHistoryStore(terminalId);
    return Promise.allSettled([...historyDisposals]).then(() => undefined);
  };

  return {
    closingTerminals,
    historyBindings,
    refreshHistoryBindings,
    retireHistoryStore,
    retireMissingStores,
    historyAccessReason,
    getHistoryStore,
    shutdown,
  };
}
