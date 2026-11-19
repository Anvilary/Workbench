/**
 * Browser Destination Picker.
 *
 * One cohesive, centered, pane-scoped browser destination picker.
 * Displays user's configured browser favorites by name only with safe favicons,
 * followed by a subtle divider and an inline "Other" section with an immediately
 * usable URL/search input and a separate Search Engine homepage button.
 * Selecting a favorite opens a streamlined preview with the title in the header,
 * an editable one-off destination URL input, and Back / Open actions.
 */

import { useState, useEffect, type FormEvent } from 'react';
import type { BrowserFavorite, SearchEngine, WebTabProvider } from '@agent-workbench/shared';
import {
  normalizeWebTabTitle,
  validateFaviconUrl,
  resolveAddressBarInput,
  validateBrowserFavoriteUrl,
} from '@agent-workbench/shared';
import { GlobeIcon } from '../GlobeIcon.js';
import { t } from '../../i18n/index.js';

export interface BrowserDestinationPickerProps {
  pickerTitle?: string;
  favorites: readonly BrowserFavorite[];
  searchEngine: SearchEngine;
  favicons?: Record<string, string>;
  onConfirm?: (destination: { url: string; title: string; provider?: WebTabProvider }) => void;
  onCancel?: () => void;
  onSelectFavorite?: (favorite: BrowserFavorite) => void;
  onSelectOther?: () => void;
  onBack?: () => void;
  initialMode?: 'list' | 'preview' | 'other';
  initialFavorite?: BrowserFavorite;
}

function SearchGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3.5 3.5" />
    </svg>
  );
}

export function BrowserDestinationPicker({
  pickerTitle,
  favorites,
  searchEngine,
  favicons,
  onConfirm,
  onCancel,
  onSelectFavorite,
  onSelectOther,
  onBack,
  initialMode = 'list',
  initialFavorite,
}: BrowserDestinationPickerProps): JSX.Element {
  const [mode, setMode] = useState<'list' | 'preview' | 'other'>(initialMode);
  const [selectedFavorite, setSelectedFavorite] = useState<BrowserFavorite | null>(initialFavorite ?? null);
  const [destinationUrl, setDestinationUrl] = useState<string>(initialFavorite?.url ?? '');
  const [queryInput, setQueryInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (mode !== 'list') {
          setMode('list');
          setError(null);
        } else if (onCancel) {
          onCancel();
        } else if (onBack) {
          onBack();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, onCancel, onBack]);

  const handleFavoriteClick = (fav: BrowserFavorite) => {
    if (onSelectFavorite && !onConfirm) {
      onSelectFavorite(fav);
      return;
    }
    setSelectedFavorite(fav);
    setDestinationUrl(fav.url);
    setError(null);
    setMode('preview');
  };

  const handleOpenSearchEngineHome = () => {
    if (onConfirm) {
      onConfirm({ url: searchEngine.homeUrl, title: searchEngine.name, provider: 'other' });
    } else if (onSelectOther) {
      onSelectOther();
    }
  };

  const handleConfirmPreview = () => {
    if (!selectedFavorite) return;
    const raw = destinationUrl.trim() || selectedFavorite.url;
    const validation = validateBrowserFavoriteUrl(raw);
    if (!validation.valid || !validation.normalizedUrl) {
      setError(t('agency.web.invalidUrl'));
      return;
    }

    if (onConfirm) {
      onConfirm({ url: validation.normalizedUrl, title: selectedFavorite.title });
    } else if (onSelectFavorite) {
      onSelectFavorite({ ...selectedFavorite, url: validation.normalizedUrl });
    }
  };

  const handleConfirmOther = () => {
    const raw = queryInput.trim();
    if (!raw) {
      handleOpenSearchEngineHome();
      return;
    }
    const resolved = resolveAddressBarInput(raw, searchEngine, 'other');
    if (resolved.error) {
      setError(resolved.error);
      return;
    }
    const rawTitle = resolved.isSearch ? `${raw} - ${searchEngine.name}` : raw;
    const title = normalizeWebTabTitle(rawTitle) || normalizeWebTabTitle(searchEngine.name) || 'Browser';
    if (onConfirm) {
      onConfirm({ url: resolved.url, title, provider: 'other' });
    } else if (onSelectOther) {
      onSelectOther();
    }
  };

  const handleOtherSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleConfirmOther();
  };

  const getFavicon = (fav: BrowserFavorite | null): string | null => {
    if (!fav) return null;
    const candidate = favicons?.[fav.id] || favicons?.[fav.url];
    if (!candidate) return null;
    return validateFaviconUrl(candidate);
  };

  const returnToList = () => {
    setMode('list');
    setError(null);
  };

  // Preview Mode
  if (mode === 'preview' && selectedFavorite) {
    const favIconUrl = getFavicon(selectedFavorite);
    return (
      <div
        className="maw-browser-dest-picker maw-browser-dest-preview"
        role="region"
        aria-label={t('agency.browser.previewTitle')}
      >
        <div className="maw-browser-dest-header">
          <div className="maw-browser-dest-other-label-group">
            <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
              {favIconUrl ? (
                <img className="maw-browser-dest-favicon" src={favIconUrl} alt="" />
              ) : (
                <GlobeIcon size={16} className="maw-browser-dest-icon" />
              )}
            </span>
            <h4 className="maw-browser-dest-header-title maw-browser-preview-title">
              {selectedFavorite.title}
            </h4>
          </div>
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel')}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="maw-browser-preview-field">
          <label htmlFor="maw-preview-dest-input" className="maw-browser-preview-label">
            {t('agency.browser.destinationUrl')}
          </label>
          <input
            id="maw-preview-dest-input"
            type="text"
            className="maw-browser-dest-input"
            value={destinationUrl}
            onChange={(e) => {
              setDestinationUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmPreview();
              }
            }}
            autoFocus
            spellCheck={false}
          />
          <p className="maw-browser-preview-hint">
            {t('agency.browser.oneOffHint')}
          </p>
          {error && (
            <div className="maw-browser-dest-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="maw-browser-preview-actions">
          <button
            type="button"
            className="maw-browser-dest-btn-secondary"
            onClick={returnToList}
          >
            {t('common.back')}
          </button>
          <button
            type="submit"
            className="maw-browser-dest-btn-primary"
            onClick={handleConfirmPreview}
          >
            {t('agency.browser.open')}
          </button>
        </div>
      </div>
    );
  }

  // Standalone Other Mode (if opened directly via initialMode="other")
  if (mode === 'other') {
    return (
      <div
        className="maw-browser-dest-picker maw-browser-dest-other"
        role="region"
        aria-label={t('agency.tabs.other')}
      >
        <div className="maw-browser-dest-header">
          <button
            type="button"
            className="maw-browser-dest-back"
            onClick={returnToList}
          >
            <span aria-hidden="true">‹</span>
            <span>{t('common.back')}</span>
          </button>
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel')}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="maw-browser-preview-header">
          <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
            <SearchGlyph />
          </span>
          <h4 className="maw-browser-preview-title">{t('agency.tabs.other')}</h4>
        </div>

        <div className="maw-browser-preview-field">
          <label htmlFor="maw-other-query-input" className="maw-browser-preview-label">
            {t('agency.browser.urlOrSearch')}
          </label>
          <input
            id="maw-other-query-input"
            type="text"
            className="maw-browser-dest-input"
            placeholder={t('agency.browser.searchPlaceholder', { engine: searchEngine.name })}
            value={queryInput}
            onChange={(e) => {
              setQueryInput(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmOther();
              }
            }}
            autoFocus
            spellCheck={false}
          />
          <p className="maw-browser-preview-hint">
            {t('agency.browser.searchEngineHint', { engine: searchEngine.name })}
          </p>
          {error && (
            <div className="maw-browser-dest-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="maw-browser-preview-actions">
          <button
            type="button"
            className="maw-browser-dest-btn-secondary"
            onClick={returnToList}
          >
            {t('common.back')}
          </button>
          <button
            type="submit"
            className="maw-browser-dest-btn-primary"
            onClick={handleConfirmOther}
          >
            {t('agency.browser.open')}
          </button>
        </div>
      </div>
    );
  }

  // List Mode (Default) with Inline Other URL/Search Input + Search Engine Button
  return (
    <div
      className="maw-browser-dest-picker"
      role="menu"
      aria-label={t('settings.category.browser')}
    >
      {(onBack || onCancel || pickerTitle) && (
        <div className="maw-browser-dest-header">
          {onBack ? (
            <button type="button" role="menuitem" className="maw-browser-dest-back" onClick={onBack}>
              <span aria-hidden="true">‹</span>
              <span>{t('common.back')}</span>
            </button>
          ) : (
            <span className="maw-browser-dest-header-title">
              {pickerTitle || t('agency.browser.pickerTitle')}
            </span>
          )}
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel')}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {favorites.length > 0 ? (
        favorites.map((fav) => {
          const faviconUrl = getFavicon(fav);
          return (
            <button
              key={fav.id}
              type="button"
              role="menuitem"
              className="agency-dropdown-item maw-browser-dest-item"
              onClick={() => handleFavoriteClick(fav)}
            >
              <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
                {faviconUrl ? (
                  <img className="maw-browser-dest-favicon" src={faviconUrl} alt="" />
                ) : (
                  <GlobeIcon size={14} className="maw-browser-dest-icon" />
                )}
              </span>
              <span className="maw-browser-dest-name">{fav.title}</span>
            </button>
          );
        })
      ) : (
        <div className="maw-browser-dest-empty">{t('settings.browser.noFavorites')}</div>
      )}

      <div className="maw-browser-dest-divider" role="separator" />

      <div className="maw-browser-dest-item maw-browser-dest-other-inline maw-browser-dest-item-other">
        <div className="maw-browser-dest-other-top">
          <div className="maw-browser-dest-other-label-group">
            <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
              <SearchGlyph />
            </span>
            <span className="maw-browser-dest-name">{t('agency.tabs.other')}</span>
          </div>
          <button
            type="button"
            className="maw-browser-dest-engine-btn maw-browser-dest-url"
            title={t('agency.browser.openHomePage', { engine: searchEngine.name })}
            aria-label={t('agency.browser.openHomePage', { engine: searchEngine.name })}
            onClick={handleOpenSearchEngineHome}
          >
            {searchEngine.name}
          </button>
        </div>

        <form className="maw-browser-dest-other-form" onSubmit={handleOtherSubmit} noValidate>
          <input
            id="maw-other-inline-input"
            type="text"
            className="maw-browser-dest-input maw-browser-dest-inline-input"
            placeholder={t('agency.browser.searchPlaceholder', { engine: searchEngine.name })}
            aria-label={t('agency.browser.urlOrSearch')}
            value={queryInput}
            onChange={(e) => {
              setQueryInput(e.target.value);
              setError(null);
            }}
            spellCheck={false}
          />
          <button type="submit" className="maw-browser-dest-btn-primary maw-browser-dest-go-btn">
            {t('agency.browser.go')}
          </button>
        </form>

        {error && (
          <div className="maw-browser-dest-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
