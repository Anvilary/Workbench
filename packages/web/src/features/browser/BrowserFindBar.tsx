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
      void window.mawChatGpt?.command({
        type: 'stop-find-in-page',
        id,
        action: 'clearSelection',
      });
    };
  }, [id]);

  const runFind = (text: string, forward = true, findNext = false) => {
    if (!text.trim()) {
      setMatchCount(0);
      setActiveOrdinal(0);
      void window.mawChatGpt?.command({
        type: 'stop-find-in-page',
        id,
        action: 'clearSelection',
      });
      return;
    }
    void window.mawChatGpt?.command({
      type: 'find-in-page',
      id,
      text,
      forward,
      findNext,
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    runFind(val, true, false);
  };

  const handleNext = () => {
    if (query) runFind(query, true, true);
  };

  const handlePrevious = () => {
    if (query) runFind(query, false, true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    }
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
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
