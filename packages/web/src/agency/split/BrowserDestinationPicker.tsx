/**
 * Browser Destination Picker.
 *
 * Displays user's configured browser favorites followed by a thin divider and "Other".
 * Used across:
 * - Pane Add Tab dropdown
 * - Empty pane chooser
 * - Split pane creation menus
 */

import type { BrowserFavorite, SearchEngine } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';

export interface BrowserDestinationPickerProps {
  favorites: readonly BrowserFavorite[];
  searchEngine: SearchEngine;
  onSelectFavorite: (favorite: BrowserFavorite) => void;
  onSelectOther: () => void;
  onBack?: () => void;
}

export function BrowserDestinationPicker({
  favorites,
  searchEngine,
  onSelectFavorite,
  onSelectOther,
  onBack,
}: BrowserDestinationPickerProps): JSX.Element {
  return (
    <div className="maw-browser-dest-picker" role="menu" aria-label={t('settings.category.browser')}>
      {onBack && (
        <div className="maw-browser-dest-header">
          <button type="button" role="menuitem" className="maw-browser-dest-back" onClick={onBack}>
            ‹ {t('common.back')}
          </button>
        </div>
      )}

      {favorites.length > 0 ? (
        favorites.map((fav) => (
          <button
            key={fav.id}
            type="button"
            role="menuitem"
            className="agency-dropdown-item maw-browser-dest-item"
            onClick={() => onSelectFavorite(fav)}
          >
            <span className="maw-browser-dest-name">{fav.title}</span>
            <span className="maw-browser-dest-url" title={fav.url}>
              {fav.url}
            </span>
          </button>
        ))
      ) : (
        <div className="maw-browser-dest-empty">{t('settings.browser.noFavorites')}</div>
      )}

      <div className="maw-browser-dest-divider" role="separator" />

      <button
        type="button"
        role="menuitem"
        className="agency-dropdown-item maw-browser-dest-item"
        onClick={onSelectOther}
      >
        <span className="maw-browser-dest-name">{t('agency.tabs.other')}</span>
        <span className="maw-browser-dest-url">{searchEngine.name}</span>
      </button>
    </div>
  );
}
