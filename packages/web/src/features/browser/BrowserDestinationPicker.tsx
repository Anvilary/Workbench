/**
 * Browser Destination Picker.
 *
 * One cohesive, centered, pane-scoped browser destination picker.
 * Features:
 * 1. Title: "New Web Page" with close (X) button.
 * 2. Favorites section: User favorites by name with favicons or neutral GlobeIcon.
 * 3. Search Engine section: Dropdown listing user-configured search engines (defaults
 *    to current default, changes only affect this picker) with dark-orange Go (→) button.
 * 4. Other section: Independent URL input with dark-orange Go (→) button.
 */

import { useState, useEffect, type FormEvent } from 'react';
import type { BrowserFavorite, SearchEngine, WebTabProvider } from '@anvilary/workbench-shared';
import {
  DEFAULT_SEARCH_ENGINES,
  normalizeWebTabTitle,
  validateFaviconUrl,
  validateBrowserFavoriteUrl,
} from '@anvilary/workbench-shared';
import { GlobeIcon } from '../../shared/ui/GlobeIcon.js';
import { t } from '../../i18n/index.js';

export interface BrowserDestinationPickerProps {
  pickerTitle?: string;
  favorites: readonly BrowserFavorite[];
  searchEngine: SearchEngine;
  searchEngines?: readonly SearchEngine[];
  favicons?: Record<string, string>;
  onConfirm?: (destination: { url: string; title: string; provider?: WebTabProvider }) => void;
  onCancel?: () => void;
  onSelectFavorite?: (favorite: BrowserFavorite) => void;
  onSelectOther?: () => void;
  onBack?: () => void;
  initialMode?: 'list' | 'preview' | 'other';
  initialFavorite?: BrowserFavorite;
}

function ArrowRightGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
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
  searchEngines,
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
  const [urlInput, setUrlInput] = useState<string>('');
  const [selectedEngineId, setSelectedEngineId] = useState<string>(searchEngine.id);
  const [error, setError] = useState<string | null>(null);

  const availableEngines = (searchEngines && searchEngines.length > 0)
    ? searchEngines
    : (DEFAULT_SEARCH_ENGINES.some((e) => e.id === searchEngine.id)
      ? DEFAULT_SEARCH_ENGINES
      : [searchEngine, ...DEFAULT_SEARCH_ENGINES]);

  const activeEngine = availableEngines.find((e) => e.id === selectedEngineId) ?? searchEngine;

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
      onConfirm({ url: activeEngine.homeUrl, title: activeEngine.name, provider: 'other' });
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

  const handleConfirmUrl = () => {
    const raw = urlInput.trim();
    if (!raw) {
      setError(t('agency.web.invalidUrl'));
      return;
    }
    const validation = validateBrowserFavoriteUrl(raw);
    if (!validation.valid || !validation.normalizedUrl) {
      setError(validation.error ?? t('agency.web.invalidUrl'));
      return;
    }
    const title = normalizeWebTabTitle(raw) || 'Web Page';
    if (onConfirm) {
      onConfirm({ url: validation.normalizedUrl, title, provider: 'other' });
    } else if (onSelectOther) {
      onSelectOther();
    }
  };

  const handleOtherSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleConfirmUrl();
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
        className="wb-browser-dest-picker wb-browser-dest-preview"
        role="region"
        aria-label={t('agency.browser.previewTitle')}
      >
        <div className="wb-browser-dest-header">
          <div className="wb-browser-dest-other-label-group">
            <span className="wb-browser-dest-icon-wrap" aria-hidden="true">
              {favIconUrl ? (
                <img className="wb-browser-dest-favicon" src={favIconUrl} alt="" />
              ) : (
                <GlobeIcon size={16} className="wb-browser-dest-icon" />
              )}
            </span>
            <h4 className="wb-browser-dest-header-title wb-browser-preview-title">
              {selectedFavorite.title}
            </h4>
          </div>
          {onCancel && (
            <button
              type="button"
              className="wb-browser-dest-close"
              aria-label={t('common.close')}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="wb-browser-preview-field">
          <label htmlFor="maw-preview-dest-input" className="wb-browser-preview-label">
            {t('agency.browser.destinationUrl')}
          </label>
          <input
            id="maw-preview-dest-input"
            type="text"
            className="wb-browser-dest-input"
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
          <p className="wb-browser-preview-hint">
            {t('agency.browser.oneOffHint')}
          </p>
          {error && (
            <div className="wb-browser-dest-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="wb-browser-preview-actions">
          <button
            type="button"
            className="wb-browser-dest-btn-secondary"
            onClick={returnToList}
          >
            {t('common.back')}
          </button>
          <button
            type="submit"
            className="wb-browser-dest-btn-primary"
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
        className="wb-browser-dest-picker wb-browser-dest-other"
        role="region"
        aria-label={t('agency.tabs.other')}
      >
        <div className="wb-browser-dest-header">
          <button
            type="button"
            className="wb-browser-dest-back"
            onClick={returnToList}
          >
            <span aria-hidden="true">‹</span>
            <span>{t('common.back')}</span>
          </button>
          {onCancel && (
            <button
              type="button"
              className="wb-browser-dest-close"
              aria-label={t('common.close')}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="wb-browser-preview-header">
          <span className="wb-browser-dest-icon-wrap" aria-hidden="true">
            <SearchGlyph />
          </span>
          <h4 className="wb-browser-preview-title">{t('agency.tabs.other')}</h4>
        </div>

        <div className="wb-browser-preview-field">
          <label htmlFor="maw-other-query-input" className="wb-browser-preview-label">
            {t('agency.browser.urlOrSearch')}
          </label>
          <input
            id="maw-other-query-input"
            type="text"
            className="wb-browser-dest-input"
            placeholder={t('agency.browser.searchPlaceholder', { engine: activeEngine.name })}
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmUrl();
              }
            }}
            autoFocus
            spellCheck={false}
          />
          <p className="wb-browser-preview-hint">
            {t('agency.browser.searchEngineHint', { engine: activeEngine.name })}
          </p>
          {error && (
            <div className="wb-browser-dest-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="wb-browser-preview-actions">
          <button
            type="button"
            className="wb-browser-dest-btn-secondary"
            onClick={returnToList}
          >
            {t('common.back')}
          </button>
          <button
            type="submit"
            className="wb-browser-dest-btn-primary"
            onClick={handleConfirmUrl}
          >
            {t('agency.browser.open')}
          </button>
        </div>
      </div>
    );
  }

  // List Mode (Default): 1. Title + Close, 2. Favorites, 3. Search Engine, 4. Other
  return (
    <div
      className="wb-browser-dest-picker"
      role="menu"
      aria-label={t('agency.browser.pickerTitle')}
    >
      <div className="wb-browser-dest-header">
        {onBack ? (
          <button type="button" role="menuitem" className="wb-browser-dest-back" onClick={onBack}>
            <span aria-hidden="true">‹</span>
            <span>{t('common.back')}</span>
          </button>
        ) : (
          <span className="wb-browser-dest-header-title">
            {pickerTitle || t('agency.browser.pickerTitle')}
          </span>
        )}
        {onCancel && (
          <button
            type="button"
            className="wb-browser-dest-close"
            aria-label={t('common.close')}
            onClick={onCancel}
          >
            ✕
          </button>
        )}
      </div>

      {/* Section 1: Favorites */}
      <div className="wb-browser-dest-section wb-browser-dest-section-favorites">
        <div className="wb-browser-dest-section-title">
          {t('settings.browser.favorites')}
        </div>
        {favorites.length > 0 ? (
          <div className="wb-browser-dest-favorites-list">
            {favorites.map((fav) => {
              const faviconUrl = getFavicon(fav);
              return (
                <button
                  key={fav.id}
                  type="button"
                  role="menuitem"
                  className="agency-dropdown-item wb-browser-dest-item"
                  onClick={() => handleFavoriteClick(fav)}
                >
                  <span className="wb-browser-dest-icon-wrap" aria-hidden="true">
                    {faviconUrl ? (
                      <img className="wb-browser-dest-favicon" src={faviconUrl} alt="" />
                    ) : (
                      <GlobeIcon size={14} className="wb-browser-dest-icon" />
                    )}
                  </span>
                  <span className="wb-browser-dest-name">{fav.title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="wb-browser-dest-empty">{t('settings.browser.noFavorites')}</div>
        )}
      </div>

      <div className="wb-browser-dest-divider" role="separator" />

      {/* Section 2: Search Engine */}
      <div className="wb-browser-dest-section wb-browser-dest-section-engine">
        <div className="wb-browser-dest-section-title">
          {t('agency.browser.searchEngine')}
        </div>
        <div className="wb-browser-dest-engine-row">
          <select
            id="wb-browser-dest-engine-select"
            className="wb-browser-dest-engine-select"
            value={selectedEngineId}
            onChange={(e) => setSelectedEngineId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleOpenSearchEngineHome();
              }
            }}
            aria-label={t('agency.browser.searchEngine')}
          >
            {availableEngines.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wb-browser-dest-go-btn"
            title={t('agency.browser.openHomePage', { engine: activeEngine.name })}
            aria-label={t('agency.browser.openHomePage', { engine: activeEngine.name })}
            onClick={handleOpenSearchEngineHome}
          >
            <ArrowRightGlyph />
          </button>
        </div>
      </div>

      <div className="wb-browser-dest-divider" role="separator" />

      {/* Section 3: Other */}
      <div className="wb-browser-dest-section wb-browser-dest-section-other wb-browser-dest-item-other">
        <div className="wb-browser-dest-section-title">
          {t('agency.tabs.other')}
        </div>
        <form className="wb-browser-dest-other-form" onSubmit={handleOtherSubmit} noValidate>
          <input
            id="maw-other-inline-input"
            type="text"
            className="wb-browser-dest-input wb-browser-dest-inline-input"
            placeholder={t('agency.browser.enterWebsiteUrl')}
            aria-label={t('agency.tabs.other')}
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setError(null);
            }}
            spellCheck={false}
          />
          <button
            type="submit"
            className="wb-browser-dest-go-btn"
            title={t('agency.browser.go')}
            aria-label={t('agency.browser.go')}
          >
            <ArrowRightGlyph />
          </button>
        </form>

        {error && (
          <div className="wb-browser-dest-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
