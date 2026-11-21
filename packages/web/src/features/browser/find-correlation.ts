import type { DesktopBridgeEvent } from '../../connection/desktop-bridge.js';

export interface FindCorrelationState {
  matchCount: number;
  activeOrdinal: number;
  counterText: string;
}

export interface FindCorrelationOptions {
  tabId: string;
  dispatchCommand: (cmd: unknown) => Promise<unknown>;
  onStateChange: (state: FindCorrelationState) => void;
  debounceMs?: number;
  formatNoMatches?: () => string;
}

export interface FindCorrelationController {
  setQuery: (text: string) => void;
  findNext: (forward?: boolean) => void;
  close: () => void;
  handleEvent: (event: DesktopBridgeEvent) => boolean;
  destroy: () => void;
  getState: () => FindCorrelationState;
  getActiveSearchSeq: () => number;
  getActiveQuery: () => string;
}

export function createFindCorrelationController(options: FindCorrelationOptions): FindCorrelationController {
  const {
    tabId,
    dispatchCommand,
    onStateChange,
    debounceMs = 120,
    formatNoMatches = () => 'No matches',
  } = options;

  let query = '';
  let searchSeq = 0;
  let activeSearchSeq = 0;
  let activeSearchQuery = '';
  let activeRequestId: number | null = null;
  let minAcceptedReqId = 0;
  let matchCount = 0;
  let activeOrdinal = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let isDestroyed = false;

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const getCounterText = (): string => {
    if (!query.trim() || activeSearchSeq === 0) return '';
    if (matchCount === 0) return formatNoMatches();
    return `${activeOrdinal}/${matchCount}`;
  };

  const notify = () => {
    if (isDestroyed) return;
    onStateChange({
      matchCount,
      activeOrdinal,
      counterText: getCounterText(),
    });
  };

  const executeFind = (text: string, forward = true, findNext = false) => {
    clearTimer();
    const trimmed = text.trim();
    if (!trimmed) {
      searchSeq += 1;
      activeSearchSeq = 0;
      activeSearchQuery = '';
      activeRequestId = null;
      matchCount = 0;
      activeOrdinal = 0;
      notify();
      void dispatchCommand({
        type: 'stop-find-in-page',
        id: tabId,
        action: 'clearSelection',
      }).catch(() => {});
      return;
    }

    if (!findNext) {
      searchSeq += 1;
      const seq = searchSeq;
      activeSearchSeq = seq;
      activeSearchQuery = trimmed;
      activeRequestId = null;
      void dispatchCommand({
        type: 'find-in-page',
        id: tabId,
        text: trimmed,
        forward,
        findNext: false,
        searchId: seq,
      }).then((res) => {
        if (isDestroyed || activeSearchSeq !== seq) return;
        const response = res as { ok?: boolean; requestId?: number } | undefined;
        if (response && typeof response.requestId === 'number') {
          activeRequestId = response.requestId;
          minAcceptedReqId = Math.max(minAcceptedReqId, response.requestId);
        }
      }).catch(() => {});
    } else {
      if (activeSearchSeq === 0 || !activeSearchQuery) {
        executeFind(trimmed, forward, false);
        return;
      }
      const seq = activeSearchSeq;
      void dispatchCommand({
        type: 'find-in-page',
        id: tabId,
        text: trimmed,
        forward,
        findNext: true,
        searchId: seq,
      }).then((res) => {
        if (isDestroyed || activeSearchSeq !== seq) return;
        const response = res as { ok?: boolean; requestId?: number } | undefined;
        if (response && typeof response.requestId === 'number') {
          activeRequestId = response.requestId;
          minAcceptedReqId = Math.max(minAcceptedReqId, response.requestId);
        }
      }).catch(() => {});
    }
  };

  const setQuery = (text: string) => {
    query = text;
    clearTimer();
    const trimmed = text.trim();
    // User is altering the search text: immediately invalidate active search results
    activeSearchSeq = 0;
    activeSearchQuery = '';
    activeRequestId = null;
    matchCount = 0;
    activeOrdinal = 0;
    notify();

    if (!trimmed) {
      executeFind('');
      return;
    }

    timerId = setTimeout(() => {
      timerId = null;
      executeFind(trimmed, true, false);
    }, debounceMs);
  };

  const findNext = (forward = true) => {
    clearTimer();
    const trimmed = query.trim();
    if (!trimmed) return;
    if (activeSearchQuery !== trimmed || activeSearchSeq === 0) {
      executeFind(trimmed, forward, false);
    } else {
      executeFind(trimmed, forward, true);
    }
  };

  const handleEvent = (event: DesktopBridgeEvent): boolean => {
    if (isDestroyed) return false;
    if (event.id !== tabId) return false;

    // Reset find state on page navigation or view reload/crash
    if (event.type === 'navigation' || event.type === 'committed' || event.type === 'suspended') {
      clearTimer();
      activeSearchSeq = 0;
      activeSearchQuery = '';
      activeRequestId = null;
      matchCount = 0;
      activeOrdinal = 0;
      notify();
      return true;
    }

    if (event.type !== 'found-in-page') return false;

    // 1. Must have an active search in flight
    if (activeSearchSeq === 0 || !activeSearchQuery) return false;

    // 2. Correlate searchId if provided
    if (typeof event.searchId === 'number' && event.searchId !== activeSearchSeq) {
      return false;
    }

    // 3. Correlate searchText if provided
    if (typeof event.searchText === 'string' && event.searchText !== activeSearchQuery) {
      return false;
    }

    // 4. Correlate requestId if provided
    if (typeof event.requestId === 'number') {
      if (activeRequestId !== null && event.requestId !== activeRequestId) {
        return false;
      }
      if (event.requestId < minAcceptedReqId) {
        return false;
      }
      minAcceptedReqId = Math.max(minAcceptedReqId, event.requestId);
    }

    matchCount = event.matches ?? 0;
    activeOrdinal = event.activeMatchOrdinal ?? 0;
    notify();
    return true;
  };

  const close = () => {
    clearTimer();
    searchSeq += 1;
    activeSearchSeq = 0;
    activeSearchQuery = '';
    activeRequestId = null;
    matchCount = 0;
    activeOrdinal = 0;
    notify();
    void dispatchCommand({
      type: 'stop-find-in-page',
      id: tabId,
      action: 'clearSelection',
    }).catch(() => {});
  };

  const destroy = () => {
    isDestroyed = true;
    clearTimer();
    void dispatchCommand({
      type: 'stop-find-in-page',
      id: tabId,
      action: 'clearSelection',
    }).catch(() => {});
  };

  return {
    setQuery,
    findNext,
    close,
    handleEvent,
    destroy,
    getState: () => ({ matchCount, activeOrdinal, counterText: getCounterText() }),
    getActiveSearchSeq: () => activeSearchSeq,
    getActiveQuery: () => activeSearchQuery,
  };
}
