/**
 * Hook for fetching and monitoring coding agents usage telemetry via WebSocket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentsUsageSnapshot, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection/connection.js';

export interface AgentsUsageState {
  snapshot: AgentsUsageSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
}

export function useAgentsUsage(
  connection: AgentConnection | undefined,
  enabled: boolean,
): AgentsUsageState {
  const [snapshot, setSnapshot] = useState<AgentsUsageSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequestRef = useRef<string | null>(null);

  const refresh = useCallback(
    (force = false) => {
      if (!connection) return;
      const reqId = `agents-usage-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pendingRequestRef.current = reqId;
      if (snapshot) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      connection.send({
        type: 'agents.usage.get',
        requestId: reqId,
        forceRefresh: force,
      });
    },
    [connection, snapshot],
  );

  useEffect(() => {
    if (!enabled || !connection) return;
    refresh(false);
  }, [enabled, connection, refresh]);

  useEffect(() => {
    if (!connection) return;

    return connection.onMessage((message: ServerMessage) => {
      if (message.type === 'agents.usage.snapshot') {
        if (!pendingRequestRef.current || pendingRequestRef.current === message.requestId) {
          setSnapshot(message.usage);
          setLoading(false);
          setRefreshing(false);
          setError(null);
          pendingRequestRef.current = null;
        }
      } else if (message.type === 'agents.usage.failed') {
        if (!pendingRequestRef.current || pendingRequestRef.current === message.requestId) {
          setError(message.error);
          setLoading(false);
          setRefreshing(false);
          pendingRequestRef.current = null;
        }
      }
    });
  }, [connection]);

  return { snapshot, loading, refreshing, error, refresh };
}
