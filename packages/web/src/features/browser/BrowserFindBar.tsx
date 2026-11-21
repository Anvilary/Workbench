import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n/index.js';
import { createFindCorrelationController, type FindCorrelationState } from './find-correlation.js';

export interface BrowserFindBarProps {
  id: string;
  onClose: () => void;
}

export function BrowserFindBar({ id, onClose }: BrowserFindBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [findState, setFindState] = useState<FindCorrelationState>({
    matchCount: 0,
    activeOrdinal: 0,
    counterText: '',
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const controller = useMemo(() => {
    return createFindCorrelationController({
      tabId: id,
      dispatchCommand: (cmd) => {
        const bridge = window.mawChatGpt;
        if (!bridge) return Promise.resolve();
        return bridge.command(cmd as any);
      },
      onStateChange: (newState) => {
        setFindState(newState);
      },
      debounceMs: 120,
      formatNoMatches: () => t('agency.browser.noMatches'),
    });
  }, [id]);

  // Clean up controller on tabId change or unmount
  useEffect(() => {
    return () => {
      controller.destroy();
    };
  }, [controller]);

  // Focus and select all on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Subscribe to bridge events
  useEffect(() => {
    const bridge = window.mawChatGpt;
    if (!bridge) return;
    const unsubscribe = bridge.subscribe((state) => {
      controller.handleEvent(state);
    });
    return () => {
      unsubscribe();
    };
  }, [controller]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    controller.setQuery(val);
  };

  const handleNext = () => {
    controller.findNext(true);
  };

  const handlePrevious = () => {
    controller.findNext(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      controller.close();
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
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      handlePrevious();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      handleNext();
    }
  };

  const handleClose = () => {
    controller.close();
    onClose();
  };

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
      {findState.counterText && (
        <span className="maw-browser-find-counter" role="status" aria-live="polite">
          {findState.counterText}
        </span>
      )}
      <button
        type="button"
        className="maw-browser-find-btn"
        aria-label={t('agency.browser.previousMatch')}
        title={t('agency.browser.previousMatch')}
        onClick={handlePrevious}
        disabled={findState.matchCount === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="maw-browser-find-btn"
        aria-label={t('agency.browser.nextMatch')}
        title={t('agency.browser.nextMatch')}
        onClick={handleNext}
        disabled={findState.matchCount === 0}
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
