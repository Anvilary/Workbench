/**
 * Hook for fetching and monitoring coding agents usage telemetry via WebSocket.
 *
 * Implements a deterministic request lifecycle:
 * - One initial fetch when active (never loops when snapshots arrive).
 * - Automatic periodic refresh every USAGE_REFRESH_INTERVAL_MS (5 minutes).
 * - Pauses automatic refreshes while the document is hidden and catches up once
 *   on return only if the existing snapshot is stale.
 * - Deduplicates concurrent requests, correlates responses by requestId, ignores
 *   stale responses, and releases loading/refreshing state on timeout or disconnect.
 * - Preserves the last successful snapshot across refreshes and errors.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentsUsageSnapshot, ClientMessage, ServerMessage } from '@anvilary/workbench-shared';
import type { ConnectionStatus } from '../../connection/connection.js';
import { t } from '../../i18n/index.js';

export const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const USAGE_REQUEST_TIMEOUT_MS = 15_000;

export interface UsageConnectionLike {
  send(message: ClientMessage): boolean | void;
  onMessage(handler: (message: ServerMessage) => void): () => void;
  getStatus?: () => ConnectionStatus;
  onStatus?: (handler: (status: ConnectionStatus) => void) => () => void;
  onReopen?: (handler: () => void) => () => void;
}

export interface UseAgentsUsageOptions {
  readonly refreshIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface AgentsUsageState {
  snapshot: AgentsUsageSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  refresh: (force?: boolean) => void;
}

export function useAgentsUsage(
  connection: UsageConnectionLike | undefined,
  enabled: boolean,
  options: UseAgentsUsageOptions = {},
): AgentsUsageState {
  const refreshIntervalMs = options.refreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? USAGE_REQUEST_TIMEOUT_MS;

  const [snapshot, setSnapshot] = useState<AgentsUsageSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const snapshotRef = useRef<AgentsUsageSnapshot | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUpdatedAtRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const enabledRef = useRef<boolean>(enabled);
  const requestSeqRef = useRef<number>(0);

  enabledRef.current = enabled;

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const clearInFlight = useCallback(() => {
    clearPendingTimeout();
    pendingRequestIdRef.current = null;
  }, [clearPendingTimeout]);

  const sendUsageRequest = useCallback(
    (forceRefresh: boolean) => {
      if (!mountedRef.current || !enabledRef.current || !connection) return;

      // Prevent duplicate concurrent requests while one is already active.
      if (pendingRequestIdRef.current !== null) return;

      const status = connection.getStatus?.();
      if (status === 'reconnecting' || status === 'failed' || status === 'revoked') {
        setLoading(false);
        setRefreshing(false);
        setError(t('usage.errorDisconnected'));
        return;
      }

      requestSeqRef.current += 1;
      const reqId = `agents-usage-${requestSeqRef.current}-${Date.now()}`;
      pendingRequestIdRef.current = reqId;

      if (snapshotRef.current !== null) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      clearPendingTimeout();
      timeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (pendingRequestIdRef.current !== reqId) return;
        pendingRequestIdRef.current = null;
        timeoutRef.current = null;
        setLoading(false);
        setRefreshing(false);
        setError(t('usage.errorTimeout'));
      }, requestTimeoutMs);

      try {
        connection.send({
          type: 'agents.usage.get',
          requestId: reqId,
          forceRefresh,
        });
      } catch (err) {
        clearInFlight();
        setLoading(false);
        setRefreshing(false);
        setError(err instanceof Error ? err.message : t('usage.errorFailed'));
      }
    },
    [connection, clearPendingTimeout, clearInFlight, requestTimeoutMs],
  );

  // Public manual refresh callback: stable across snapshot updates.
  const refresh = useCallback(
    (force = true) => {
      sendUsageRequest(force);
    },
    [sendUsageRequest],
  );

  // Track unmount lifecycle cleanly.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInFlight();
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [clearInFlight]);

  // Subscribe to WebSocket responses with strict requestId correlation.
  useEffect(() => {
    if (!connection) return;

    return connection.onMessage((message: ServerMessage) => {
      if (!mountedRef.current) return;

      if (message.type === 'agents.usage.snapshot') {
        if (pendingRequestIdRef.current === null || message.requestId !== pendingRequestIdRef.current) {
          return;
        }
        clearInFlight();
        const refreshedAt =
          typeof message.usage.aggregated?.lastRefresh === 'number' &&
          Number.isFinite(message.usage.aggregated.lastRefresh)
            ? message.usage.aggregated.lastRefresh
            : Date.now();
        snapshotRef.current = message.usage;
        lastUpdatedAtRef.current = refreshedAt;
        setSnapshot(message.usage);
        setLastUpdatedAt(refreshedAt);
        setLoading(false);
        setRefreshing(false);
        setError(null);
      } else if (message.type === 'agents.usage.failed') {
        if (pendingRequestIdRef.current === null || message.requestId !== pendingRequestIdRef.current) {
          return;
        }
        clearInFlight();
        setError(message.error || t('usage.errorFailed'));
        setLoading(false);
        setRefreshing(false);
      }
    });
  }, [connection, clearInFlight]);

  // Handle connection drops and reconnection recovery.
  useEffect(() => {
    if (!connection) return;

    const unsubStatus = connection.onStatus?.((status) => {
      if (!mountedRef.current) return;
      if (status === 'reconnecting' || status === 'failed' || status === 'revoked') {
        if (pendingRequestIdRef.current !== null) {
          clearInFlight();
          setLoading(false);
          setRefreshing(false);
          setError(t('usage.errorConnectionLost'));
        }
      }
    });

    const unsubReopen = connection.onReopen?.(() => {
      if (!mountedRef.current || !enabledRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      sendUsageRequest(false);
    });

    return () => {
      unsubStatus?.();
      unsubReopen?.();
    };
  }, [connection, clearInFlight, sendUsageRequest]);

  // Initial fetch, 5-minute automatic refresh, and visibility pause/resume.
  useEffect(() => {
    if (!enabled || !connection) {
      clearInFlight();
      setLoading(false);
      setRefreshing(false);
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    sendUsageRequest(false);

    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    intervalRef.current = setInterval(() => {
      if (!mountedRef.current || !enabledRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      sendUsageRequest(false);
    }, refreshIntervalMs);

    const handleVisibilityChange = () => {
      if (!mountedRef.current || !enabledRef.current) return;
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      const lastAt = lastUpdatedAtRef.current;
      const isStale = lastAt === null || Date.now() - lastAt >= refreshIntervalMs;
      if (isStale) {
        sendUsageRequest(false);
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      clearInFlight();
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [enabled, connection, refreshIntervalMs, sendUsageRequest, clearInFlight]);

  return { snapshot, loading, refreshing, error, lastUpdatedAt, refresh };
}
