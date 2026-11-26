/**
 * Lo que Ajustes lee y cambia del servidor (Hito 41, §6.32): con que consola
 * abre una nueva, y que CLIs no se usan.
 *
 * El estado es uno solo y lo manda el servidor al conectar y en cada cambio
 * (`settings.status`). Las escrituras con `updateBrowserSettings` usan
 * confirmacion explicita por `requestId` contra la conexion inmediata.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentId,
  AppSettingsStatus,
  BrowserSettingsPatch,
  ConsoleShellId,
  CustomDictionaryMutation,
  ServerMessage,
} from '@anvilary/workbench-shared';
import type { AgentConnection, ConnectionStatus } from '../../connection/connection.js';
import { serverTextMessage } from '../../i18n/server-text.js';

export type BrowserSettingsUpdateChange = {
  browser?: BrowserSettingsPatch;
  customDictionary?: CustomDictionaryMutation;
};

export type SettingsUpdateResult =
  | { ok: true; settings: AppSettingsStatus }
  | { ok: false; code: 'disconnected' | 'connection-lost' | 'rejected' | 'timeout'; error: string };

export interface AppSettingsApi {
  /** null hasta el primer `settings.status`: un servidor anterior al Hito 41. */
  status: AppSettingsStatus | null;
  problem: string | null;
  setConsoleShell: (shell: ConsoleShellId) => void;
  setDisabledAgents: (agents: AgentId[]) => void;
  setBrowserSettings: (browser: BrowserSettingsPatch) => void;
  updateBrowserSettings?: (change: BrowserSettingsUpdateChange) => Promise<SettingsUpdateResult>;
  dismissProblem: () => void;
}

export type AppSettingsConnectionLike = Pick<AgentConnection, 'onMessage' | 'send'> &
  Partial<Pick<AgentConnection, 'sendImmediate' | 'onStatus'>>;

const SETTINGS_ACK_TIMEOUT_MS = 15_000;

interface PendingSettingsRequest {
  resolve: (result: SettingsUpdateResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Framework-free coordinator for request-acknowledged settings updates over `AgentConnection`.
 */
export function createAppSettingsCoordinator(
  connection: AppSettingsConnectionLike,
  options: { timeoutMs?: number } = {},
) {
  let status: AppSettingsStatus | null = null;
  let problem: string | null = null;
  let seq = 0;
  const timeoutMs = options.timeoutMs ?? SETTINGS_ACK_TIMEOUT_MS;
  const pending = new Map<string, PendingSettingsRequest>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const settleRequest = (requestId: string, result: SettingsUpdateResult): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  };

  const settleAllPending = (result: Extract<SettingsUpdateResult, { ok: false }>): void => {
    for (const [requestId, entry] of [...pending.entries()]) {
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(result);
    }
  };

  const unsubMessage = connection.onMessage((message: ServerMessage) => {
    switch (message.type) {
      case 'settings.status':
        status = message.settings;
        problem = null;
        if (message.requestId) {
          settleRequest(message.requestId, { ok: true, settings: message.settings });
        }
        notify();
        break;
      case 'error':
        if (message.code === 'settings-failed') {
          problem = serverTextMessage(message.text);
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          if (message.requestId) {
            settleRequest(message.requestId, { ok: false, code: 'rejected', error: problem });
          }
          notify();
        } else if (message.code === 'remote-refused' && message.requestId) {
          settleRequest(message.requestId, {
            ok: false,
            code: 'rejected',
            error: serverTextMessage(message.text),
          });
        }
        break;
      default:
        break;
    }
  });

  const unsubStatus = connection.onStatus?.((nextStatus: ConnectionStatus) => {
    if (nextStatus !== 'open') {
      settleAllPending({
        ok: false,
        code: 'connection-lost',
        error: 'Connection lost before settings change was confirmed',
      });
    }
  });

  const nextRequestId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `settings-${crypto.randomUUID()}`;
    }
    seq += 1;
    return `settings-${Date.now()}-${seq}`;
  };

  const updateBrowserSettings = (change: BrowserSettingsUpdateChange): Promise<SettingsUpdateResult> => {
    const requestId = nextRequestId();
    const payload = { type: 'settings.update' as const, requestId, ...change };
    const sent = typeof connection.sendImmediate === 'function'
      ? connection.sendImmediate(payload)
      : connection.send(payload);
    if (!sent) {
      return Promise.resolve({
        ok: false,
        code: 'disconnected',
        error: 'Not connected to the backend server',
      });
    }
    return new Promise<SettingsUpdateResult>((resolve) => {
      const timer = setTimeout(() => {
        settleRequest(requestId, {
          ok: false,
          code: 'timeout',
          error: 'Timed out waiting for settings confirmation',
        });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
    });
  };

  const dispose = (): void => {
    unsubMessage();
    unsubStatus?.();
    settleAllPending({
      ok: false,
      code: 'connection-lost',
      error: 'Settings session closed before change was confirmed',
    });
    listeners.clear();
  };

  return {
    getSnapshot: () => ({ status, problem }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setConsoleShell: (shell: ConsoleShellId) => connection.send({ type: 'settings.update', consoleShell: shell }),
    setDisabledAgents: (agents: AgentId[]) => connection.send({ type: 'settings.update', disabledAgents: agents }),
    setBrowserSettings: (browser: BrowserSettingsPatch) => connection.send({ type: 'settings.update', browser }),
    updateBrowserSettings,
    dismissProblem: () => {
      problem = null;
      notify();
    },
    dispose,
  };
}

export function useAppSettings(connection: AgentConnection): AppSettingsApi {
  const coordinator = useMemo(() => createAppSettingsCoordinator(connection), [connection]);
  const [snapshot, setSnapshot] = useState(() => coordinator.getSnapshot());

  useEffect(() => {
    setSnapshot(coordinator.getSnapshot());
    const unsub = coordinator.subscribe(() => setSnapshot(coordinator.getSnapshot()));
    return () => {
      unsub();
      coordinator.dispose();
    };
  }, [coordinator]);

  const setConsoleShell = useCallback(
    (shell: ConsoleShellId) => coordinator.setConsoleShell(shell),
    [coordinator],
  );
  const setDisabledAgents = useCallback(
    (agents: AgentId[]) => coordinator.setDisabledAgents(agents),
    [coordinator],
  );
  const setBrowserSettings = useCallback(
    (browser: BrowserSettingsPatch) => coordinator.setBrowserSettings(browser),
    [coordinator],
  );
  const updateBrowserSettings = useCallback(
    (change: BrowserSettingsUpdateChange) => coordinator.updateBrowserSettings(change),
    [coordinator],
  );
  const dismissProblem = useCallback(() => coordinator.dismissProblem(), [coordinator]);

  return {
    status: snapshot.status,
    problem: snapshot.problem,
    setConsoleShell,
    setDisabledAgents,
    setBrowserSettings,
    updateBrowserSettings,
    dismissProblem,
  };
}
