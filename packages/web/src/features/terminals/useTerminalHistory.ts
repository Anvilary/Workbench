/**
 * Hook para paginar el historial persistente de una terminal.
 *
 * Carga paginas hacia atras cuando el usuario sube hasta el limite del
 * scrollback de xterm. Mantiene un cache acotado de paginas para evitar
 * que la memoria del navegador crezca sin limite.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConnection } from '../../connection/connection.js';
import type { TerminalId } from '@anvilary/workbench-shared';

export const HISTORY_PAGE_SIZE = 1_000;
export const MAX_CACHED_PAGES = 20;

export interface HistoryPageEntry {
  page: number;
  lines: string[];
  totalLines: number;
  totalPages: number;
}

export interface UseTerminalHistoryResult {
  /** Paginas ya cargadas, ordenadas de mas antigua a mas reciente. */
  pages: HistoryPageEntry[];
  /** true si hay mas historial hacia atras. */
  hasMore: boolean;
  /** true si una peticion esta en vuelo. */
  loading: boolean;
  /** true si el servidor reporto un error en la ultima peticion. */
  error: string | null;
  /** Total de lineas registradas en el servidor. */
  totalLines: number;
  /** Total de lineas podadas por politica de retencion. */
  prunedLines: number;
  droppedBytes: number;
  incomplete: boolean;
  /** Pide la siguiente pagina mas antigua. No hace nada si ya hay una en vuelo. */
  loadOlder(): void;
  /** Limpia el cache local (p. ej. al desmontar o cambiar de terminal). */
  reset(): void;
}

export interface HistoryDataPayload {
  requestId: string;
  terminalId?: TerminalId;
  page: number;
  pageSize: number;
  totalLines: number;
  totalPages: number;
  lines: string[];
  hasMore: boolean;
  prunedLines?: number;
  droppedBytes?: number;
  incomplete?: boolean;
  direction?: 'backward' | 'forward';
}

export interface HistoryErrorPayload {
  requestId: string;
  terminalId?: TerminalId;
  reason: string;
}

export interface UseTerminalHistoryReturn extends UseTerminalHistoryResult {
  /** Manejador de respuesta de datos para TerminalView o el consumidor de la conexion. */
  _handleHistoryData(message: HistoryDataPayload): void;
  /** Manejador de error para TerminalView o el consumidor de la conexion. */
  _handleHistoryError(message: HistoryErrorPayload): void;
}

export type UseTerminalHistoryHandle = UseTerminalHistoryReturn;

export function useTerminalHistory(
  terminalId: TerminalId,
  connection: AgentConnection,
  enabled: boolean,
): UseTerminalHistoryReturn {
  // State
  const [pages, setPages] = useState<HistoryPageEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalLines, setTotalLines] = useState(0);
  const [prunedLines, setPrunedLines] = useState(0);
  const [droppedBytes, setDroppedBytes] = useState(0);
  const [incomplete, setIncomplete] = useState(false);

  // Track the oldest page number loaded (pages go backwards: highest page index = oldest)
  const oldestPageRef = useRef<number | null>(null);
  const inflight = useRef<string | null>(null); // requestId of inflight request

  const loadOlder = useCallback(() => {
    if (!enabled || inflight.current !== null || loading || !hasMore) return;

    // Determine which page to fetch
    const nextPage = oldestPageRef.current === null ? 0 : oldestPageRef.current + 1;

    const requestId = `hist-${terminalId}-${nextPage}-${crypto.randomUUID()}`;
    inflight.current = requestId;
    setLoading(true);
    setError(null);

    connection.send({
      type: 'terminal.history.page',
      terminalId,
      page: nextPage,
      pageSize: HISTORY_PAGE_SIZE,
      direction: 'backward',
      requestId,
    });
  }, [enabled, loading, hasMore, terminalId, connection]);

  // This function is called by TerminalView when it receives a history message
  const handleHistoryData = useCallback((message: HistoryDataPayload) => {
    if (message.requestId !== inflight.current) return; // stale response
    inflight.current = null;
    setLoading(false);
    setTotalLines(message.totalLines);
    setPrunedLines(message.prunedLines ?? 0);
    setDroppedBytes(message.droppedBytes ?? 0);
    setIncomplete(message.incomplete ?? false);

    setPages((prev) => {
      // Avoid duplicates
      if (prev.some((p) => p.page === message.page)) return prev;

      const next = [
        ...prev,
        {
          page: message.page,
          lines: message.lines,
          totalLines: message.totalLines,
          totalPages: message.totalPages,
        },
      ];

      // LRU eviction: drop oldest if we exceed MAX_CACHED_PAGES
      if (next.length > MAX_CACHED_PAGES) {
        return next.slice(next.length - MAX_CACHED_PAGES);
      }
      return next;
    });

    oldestPageRef.current = message.page;
    setHasMore(message.hasMore);
  }, []);

  const handleHistoryError = useCallback((message: HistoryErrorPayload) => {
    if (message.requestId !== inflight.current) return;
    inflight.current = null;
    setLoading(false);
    setError(message.reason);
  }, []);

  const reset = useCallback(() => {
    setPages([]);
    setHasMore(true);
    setLoading(false);
    setError(null);
    setTotalLines(0);
    setPrunedLines(0);
    setDroppedBytes(0);
    setIncomplete(false);
    oldestPageRef.current = null;
    inflight.current = null;
  }, []);

  // Limpia el estado local al cambiar de terminalId
  const prevTerminalIdRef = useRef(terminalId);
  useEffect(() => {
    if (prevTerminalIdRef.current !== terminalId) {
      prevTerminalIdRef.current = terminalId;
      reset();
    }
  }, [terminalId, reset]);

  return {
    pages,
    hasMore,
    loading,
    error,
    totalLines,
    prunedLines,
    droppedBytes,
    incomplete,
    loadOlder,
    reset,
    // expose handlers for TerminalView
    _handleHistoryData: handleHistoryData,
    _handleHistoryError: handleHistoryError,
  };
}
