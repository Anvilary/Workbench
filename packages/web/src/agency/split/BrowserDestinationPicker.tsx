/**
 * Browser Destination Picker.
 *
 * One cohesive, centered, pane-scoped browser destination picker.
 * Displays user's configured browser favorites by name only with safe favicons,
 * followed by a subtle divider and "Other" (showing the default search engine).
 * Selecting a favorite reveals an inline preview with editable one-off destination URL.
 * Selecting "Other" reveals a clean URL or search query input.
 */

import { useState, useEffect } from 'react';
import type { BrowserFavorite, SearchEngine, WebTabProvider } from '@agent-workbench/shared';
import { validateFaviconUrl, resolveAddressBarInput } from '@agent-workbench/shared';
import { GlobeIcon } from '../GlobeIcon.js';
import { t } from '../../i18n/index.js';

export interface BrowserDestinationPickerProps {
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

export function BrowserDestinationPicker({
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

  const handleOtherClick = () => {
    if (onSelectOther && !onConfirm) {
      onSelectOther();
      return;
    }
    setQueryInput('');
    setError(null);
    setMode('other');
  };

  const handleConfirmPreview = () => {
    if (!selectedFavorite) return;
    const raw = destinationUrl.trim() || selectedFavorite.url;
    let finalUrl = raw;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl;
    }
    try {
      const parsed = new URL(finalUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError(t('agency.web.invalidUrl') || 'Invalid URL scheme');
        return;
      }
    } catch {
      setError(t('agency.web.invalidUrl') || 'Invalid URL');
      return;
    }

    if (onConfirm) {
      onConfirm({ url: finalUrl, title: selectedFavorite.title });
    } else if (onSelectFavorite) {
      onSelectFavorite({ ...selectedFavorite, url: finalUrl });
    }
  };

  const handleConfirmOther = () => {
    const raw = queryInput.trim();
    if (!raw) {
      if (onConfirm) {
        onConfirm({ url: searchEngine.homeUrl, title: searchEngine.name, provider: 'other' });
      } else if (onSelectOther) {
        onSelectOther();
      }
      return;
    }
    const resolved = resolveAddressBarInput(raw, searchEngine, 'other');
    if (resolved.error) {
      setError(resolved.error);
      return;
    }
    const title = resolved.isSearch ? `${raw} - ${searchEngine.name}` : raw;
    if (onConfirm) {
      onConfirm({ url: resolved.url, title, provider: 'other' });
    } else if (onSelectOther) {
      onSelectOther();
    }
  };

  const getFavicon = (fav: BrowserFavorite | null): string | null => {
    if (!fav) return null;
    const candidate = favicons?.[fav.id] || favicons?.[fav.url];
    if (!candidate) return null;
    return validateFaviconUrl(candidate);
  };

  // Preview Mode
  if (mode === 'preview' && selectedFavorite) {
    const favIconUrl = getFavicon(selectedFavorite);
    return (
      <div
        className="maw-browser-dest-picker maw-browser-dest-preview"
        role="region"
        aria-label={t('agency.browser.previewTitle') || 'Preview Destination'}
      >
        <div className="maw-browser-dest-header">
          <button
            type="button"
            className="maw-browser-dest-back"
            onClick={() => {
              setMode('list');
              setError(null);
            }}
          >
            ‹ {t('agency.browser.chooseDifferent') || t('common.back') || 'Back'}
          </button>
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel') || 'Cancel'}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="maw-browser-preview-header">
          <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
            {favIconUrl ? (
              <img className="maw-browser-dest-favicon" src={favIconUrl} alt="" />
            ) : (
              <GlobeIcon size={16} className="maw-browser-dest-icon" />
            )}
          </span>
          <h4 className="maw-browser-preview-title">{selectedFavorite.title}</h4>
        </div>

        <div className="maw-browser-preview-row">
          <span className="maw-browser-preview-label">
            {t('agency.browser.configuredUrl') || 'Configured URL'}
          </span>
          <span className="maw-browser-preview-configured-url" title={selectedFavorite.url}>
            {selectedFavorite.url}
          </span>
        </div>

        <div className="maw-browser-preview-field">
          <label htmlFor="maw-preview-dest-input" className="maw-browser-preview-label">
            {t('agency.browser.destinationUrl') || 'Destination URL'}
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
            {t('agency.browser.oneOffHint') ||
              'One-off navigation. Editing this does not alter your saved favorite.'}
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
            onClick={() => {
              setMode('list');
              setError(null);
            }}
          >
            {t('agency.browser.chooseDifferent') || t('common.back') || 'Back'}
          </button>
          <button
            type="submit"
            className="maw-browser-dest-btn-primary"
            onClick={handleConfirmPreview}
          >
            {t('agency.browser.open') || 'Open'}
          </button>
        </div>
      </div>
    );
  }

  // Other Mode
  if (mode === 'other') {
    return (
      <div
        className="maw-browser-dest-picker maw-browser-dest-other"
        role="region"
        aria-label={t('agency.tabs.other') || 'Other Destination'}
      >
        <div className="maw-browser-dest-header">
          <button
            type="button"
            className="maw-browser-dest-back"
            onClick={() => {
              setMode('list');
              setError(null);
            }}
          >
            ‹ {t('common.back') || 'Back'}
          </button>
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel') || 'Cancel'}
              onClick={onCancel}
            >
              ✕
            </button>
          )}
        </div>

        <div className="maw-browser-preview-header">
          <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5l3.5 3.5" />
            </svg>
          </span>
          <h4 className="maw-browser-preview-title">{t('agency.tabs.other') || 'Other Destination'}</h4>
        </div>

        <div className="maw-browser-preview-field">
          <label htmlFor="maw-other-query-input" className="maw-browser-preview-label">
            {t('agency.browser.urlOrSearch') || 'URL or Search Query'}
          </label>
          <input
            id="maw-other-query-input"
            type="text"
            className="maw-browser-dest-input"
            placeholder={
              t('agency.browser.searchPlaceholder', { engine: searchEngine.name }) ||
              `Search with ${searchEngine.name} or enter URL...`
            }
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
            {t('agency.browser.searchEngineHint', { engine: searchEngine.name }) ||
              `Searches with ${searchEngine.name}`}
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
            onClick={() => {
              setMode('list');
              setError(null);
            }}
          >
            {t('common.back') || 'Back'}
          </button>
          <button
            type="submit"
            className="maw-browser-dest-btn-primary"
            onClick={handleConfirmOther}
          >
            {t('agency.browser.open') || 'Open'}
          </button>
        </div>
      </div>
    );
  }

  // List Mode (Default)
  return (
    <div
      className="maw-browser-dest-picker"
      role="menu"
      aria-label={t('settings.category.browser') || 'Browser'}
    >
      {(onBack || onCancel) && (
        <div className="maw-browser-dest-header">
          {onBack ? (
            <button type="button" role="menuitem" className="maw-browser-dest-back" onClick={onBack}>
              ‹ {t('common.back') || 'Back'}
            </button>
          ) : (
            <span className="maw-browser-dest-header-title">
              {t('agency.browser.pickerTitle') || t('agency.web.newTab') || 'New Browser Tab'}
            </span>
          )}
          {onCancel && (
            <button
              type="button"
              className="maw-browser-dest-close"
              aria-label={t('common.cancel') || 'Cancel'}
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

      <button
        type="button"
        role="menuitem"
        className="agency-dropdown-item maw-browser-dest-item maw-browser-dest-item-other"
        onClick={handleOtherClick}
      >
        <span className="maw-browser-dest-icon-wrap" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5l3.5 3.5" />
          </svg>
        </span>
        <span className="maw-browser-dest-name">{t('agency.tabs.other')}</span>
        <span className="maw-browser-dest-url maw-browser-dest-engine">{searchEngine.name}</span>
      </button>
    </div>
  );
}
