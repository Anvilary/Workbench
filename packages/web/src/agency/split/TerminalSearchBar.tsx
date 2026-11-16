import React, { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { t } from '../../i18n/index.js';

interface TerminalSearchBarProps {
  terminal: Terminal | null;
  searchAddon: SearchAddon | null;
  initialQuery?: string;
  onClose: () => void;
}

export function centerCurrentMatch(term: Terminal): void {
  const sel = term.getSelectionPosition();
  if (sel) {
    const line = sel.start.y;
    const target = Math.max(0, line - Math.floor(term.rows / 2));
    term.scrollToLine(target);
  }
}

export function TerminalSearchBar({
  terminal,
  searchAddon,
  initialQuery = '',
  onClose,
}: TerminalSearchBarProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [resultInfo, setResultInfo] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select input on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Subscribe to search addon result changes
  useEffect(() => {
    if (!searchAddon) return;
    const disposable = searchAddon.onDidChangeResults?.((results) => {
      if (results) {
        setResultInfo({ index: results.resultIndex, count: results.resultCount });
      } else {
        setResultInfo(null);
      }
    });

    return () => {
      disposable?.dispose();
    };
  }, [searchAddon]);

  // Initial search if query provided
  useEffect(() => {
    if (searchAddon && initialQuery) {
      const found = searchAddon.findNext(initialQuery, { incremental: false });
      if (found && terminal) {
        centerCurrentMatch(terminal);
      }
    }
  }, [searchAddon, initialQuery, terminal]);

  const findNext = () => {
    if (!query || !searchAddon) return;
    const found = searchAddon.findNext(query, { incremental: false });
    if (found && terminal) {
      centerCurrentMatch(terminal);
    }
  };

  const findPrevious = () => {
    if (!query || !searchAddon) return;
    const found = searchAddon.findPrevious(query, { incremental: false });
    if (found && terminal) {
      centerCurrentMatch(terminal);
    }
  };

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setQuery(newQuery);
    if (!searchAddon) return;
    if (!newQuery) {
      searchAddon.clearDecorations?.();
      setResultInfo(null);
      return;
    }
    const found = searchAddon.findNext(newQuery, { incremental: true });
    if (found && terminal) {
      centerCurrentMatch(terminal);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        // Accept match, close search bar, keep scroll position, return focus to terminal
        onClose();
        terminal?.focus();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      terminal?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      findPrevious();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      findNext();
    }
  };

  const handleClose = () => {
    searchAddon?.clearDecorations?.();
    onClose();
    terminal?.focus();
  };

  return (
    <div className="maw-terminal-search-bar" role="search" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        className="maw-terminal-search-input"
        placeholder={t('agency.terminal.searchPlaceholder')}
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        aria-label={t('agency.terminal.searchPlaceholder')}
      />
      {query && resultInfo !== null && (
        <span className="maw-terminal-search-counter">
          {resultInfo.count > 0 ? `${resultInfo.index + 1}/${resultInfo.count}` : t('agency.terminal.noMatches')}
        </span>
      )}
      <button
        type="button"
        className="maw-terminal-search-btn"
        onClick={findPrevious}
        title={t('agency.terminal.searchPrevious')}
        aria-label={t('agency.terminal.searchPrevious')}
        disabled={!query}
      >
        ↑
      </button>
      <button
        type="button"
        className="maw-terminal-search-btn"
        onClick={findNext}
        title={t('agency.terminal.searchNext')}
        aria-label={t('agency.terminal.searchNext')}
        disabled={!query}
      >
        ↓
      </button>
      <button
        type="button"
        className="maw-terminal-search-btn maw-terminal-search-close"
        onClick={handleClose}
        title={t('agency.terminal.searchClose')}
        aria-label={t('agency.terminal.searchClose')}
      >
        ×
      </button>
    </div>
  );
}
