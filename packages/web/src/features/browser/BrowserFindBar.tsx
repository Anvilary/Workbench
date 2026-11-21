import React, { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/index.js';

export interface BrowserFindBarProps {
  id: string;
  onClose: () => void;
}

export function BrowserFindBar({ id, onClose }: BrowserFindBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeOrdinal, setActiveOrdinal] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<number | null>(null);
  const activeSearchQueryRef = useRef<string>('');
  const highestReceivedReqIdRef = useRef<number>(0);

  const clearPendingSearch = () => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  };

  // Focus and select all on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Subscribe to found-in-page events
  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge) return;
    const unsubscribe = bridge.subscribe((state) => {
      if (state.type === 'found-in-page' && state.id === id) {
        if (!activeSearchQueryRef.current) return;
        if (typeof state.requestId === 'number') {
          if (state.requestId < highestReceivedReqIdRef.current) {
            return;
          }
          highestReceivedReqIdRef.current = state.requestId;
        }
        setMatchCount(state.matches ?? 0);
        setActiveOrdinal(state.activeMatchOrdinal ?? 0);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [id]);

  // Clean up highlights when unmounted
  useEffect(() => {
    return () => {
      clearPendingSearch();
      void window.mawChatGpt?.command({
        type: 'stop-find-in-page',
        id,
        action: 'clearSelection',
      });
    };
  }, [id]);

  const executeFind = (text: string, forward = true, findNext = false) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearPendingSearch();
      activeSearchQueryRef.current = '';
      setMatchCount(0);
      setActiveOrdinal(0);
      void window.mawChatGpt?.command({
        type: 'stop-find-in-page',
        id,
        action: 'clearSelection',
      });
      return;
    }

    activeSearchQueryRef.current = trimmed;
    void window.mawChatGpt?.command({
      type: 'find-in-page',
      id,
      text: trimmed,
      forward,
      findNext,
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    clearPendingSearch();
    const trimmed = val.trim();
    if (!trimmed) {
      executeFind('');
      return;
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      executeFind(trimmed, true, false);
    }, 120);
  };

  const handleNext = () => {
    clearPendingSearch();
    const trimmed = query.trim();
    if (!trimmed) return;
    if (activeSearchQueryRef.current !== trimmed) {
      executeFind(trimmed, true, false);
    } else {
      executeFind(trimmed, true, true);
    }
  };

  const handlePrevious = () => {
    clearPendingSearch();
    const trimmed = query.trim();
    if (!trimmed) return;
    if (activeSearchQueryRef.current !== trimmed) {
      executeFind(trimmed, false, false);
    } else {
      executeFind(trimmed, false, true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      clearPendingSearch();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimerRef.current !== null) {
        clearPendingSearch();
        const trimmed = query.trim();
        if (trimmed) {
          executeFind(trimmed, !e.shiftKey, false);
        }
        return;
      }
      if (e.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      handlePrevious();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      handleNext();
    }
  };

  const handleClose = () => {
    clearPendingSearch();
    onClose();
  };

  let counterText = '';
  if (query.trim().length > 0) {
    if (matchCount === 0) {
      counterText = t('agency.browser.noMatches');
    } else {
      counterText = `${activeOrdinal}/${matchCount}`;
    }
  }

  return (
    <div className="maw-browser-find-bar" role="search" aria-label={t('agency.browser.findInPage')}>
      <input
        ref={inputRef}
        type="text"
        className="maw-browser-find-input"
        placeholder={t('agency.browser.findPlaceholder')}
        aria-label={t('agency.browser.findInPage')}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {counterText && (
        <span className="maw-browser-find-counter" role="status" aria-live="polite">
          {counterText}
        </span>
      )}
      <button
        type="button"
        className="maw-browser-find-btn"
        aria-label={t('agency.browser.previousMatch')}
        title={t('agency.browser.previousMatch')}
        onClick={handlePrevious}
        disabled={matchCount === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="maw-browser-find-btn"
        aria-label={t('agency.browser.nextMatch')}
        title={t('agency.browser.nextMatch')}
        onClick={handleNext}
        disabled={matchCount === 0}
      >
        ↓
      </button>
      <button
        type="button"
        className="maw-browser-find-btn maw-browser-find-close"
        aria-label={t('agency.browser.closeFind')}
        title={t('agency.browser.closeFind')}
        onClick={handleClose}
      >
        ×
      </button>
    </div>
  );
}
