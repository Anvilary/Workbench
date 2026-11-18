/**
 * Modular Browser settings section component for SettingsDialog.
 *
 * Implements:
 * - TASK 4: Custom Search Engine Management (default selection, add, edit, remove, restore built-ins, validation)
 * - TASK 5: Favorites Drag and Drop reordering using @dnd-kit/react and @dnd-kit/dom with keyboard accessibility
 */

import { useCallback, useMemo, useState } from 'react';
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from '@dnd-kit/react';
import { Accessibility, KeyboardSensor, PointerActivationConstraints } from '@dnd-kit/dom';
import type { BrowserFavorite } from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import type { UseBrowserSettingsResult } from './agency/useBrowserSettings.js';

const sensors = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];

interface FavoriteRowItemProps {
  fav: BrowserFavorite;
  index: number;
  total: number;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (direction: 'up' | 'down') => void;
}

function FavoriteRowItem({
  fav,
  index,
  total,
  onEdit,
  onRemove,
  onMove,
}: FavoriteRowItemProps): JSX.Element {
  const drag = useDraggable({
    id: fav.id,
    type: 'favorite',
    data: { type: 'favorite', id: fav.id, index },
  });

  const drop = useDroppable({
    id: fav.id,
    type: 'favorite',
    accept: 'favorite',
    data: { type: 'favorite', id: fav.id, index },
  });

  const rowRef = useCallback(
    (el: HTMLLIElement | null) => {
      drop.ref(el);
    },
    [drop.ref],
  );

  const gripRef = useCallback(
    (el: HTMLButtonElement | null) => {
      drag.ref(el);
    },
    [drag.ref],
  );

  return (
    <li
      ref={rowRef}
      className={`maw-settings-favorite-row${drop.isDropTarget ? ' is-drop-target' : ''}${
        drag.isDragging ? ' is-dragging' : ''
      }`}
      data-id={fav.id}
    >
      <button
        ref={gripRef}
        type="button"
        className={`icon-button maw-fav-grip${drag.isDragging ? ' is-dragging' : ''}`}
        title={t('settings.browser.reorderFavorite', { name: fav.title })}
        aria-label={t('settings.browser.reorderFavorite', { name: fav.title })}
        aria-roledescription="sortable"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (index > 0) onMove('up');
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (index < total - 1) onMove('down');
          }
        }}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="2.5" r="1.2" />
          <circle cx="7" cy="2.5" r="1.2" />
          <circle cx="3" cy="7" r="1.2" />
          <circle cx="7" cy="7" r="1.2" />
          <circle cx="3" cy="11.5" r="1.2" />
          <circle cx="7" cy="11.5" r="1.2" />
        </svg>
      </button>

      <div className="maw-settings-fav-info">
        <span className="maw-settings-fav-title">{fav.title}</span>
        <span className="maw-settings-fav-url" title={fav.url}>
          {fav.url}
        </span>
      </div>

      <div className="maw-settings-fav-actions">
        <button
          type="button"
          className="icon-button maw-settings-fav-btn"
          title={t('settings.browser.editFavorite')}
          aria-label={t('settings.browser.editFavorite')}
          onClick={onEdit}
        >
          ✎
        </button>
        <button
          type="button"
          className="icon-button maw-settings-fav-btn maw-settings-fav-delete"
          title="Delete"
          aria-label="Delete"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </li>
  );
}

export interface BrowserSettingsSectionProps {
  browserSettings: UseBrowserSettingsResult;
  highlightedCardId?: string | null;
}

export function BrowserSettingsSection({
  browserSettings,
  highlightedCardId,
}: BrowserSettingsSectionProps): JSX.Element {
  // Favorites Form State
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [isAddingFavorite, setIsAddingFavorite] = useState(false);
  const [favTitleInput, setFavTitleInput] = useState('');
  const [favUrlInput, setFavUrlInput] = useState('');
  const [favError, setFavError] = useState<string | null>(null);

  // Search Engine Form State
  const [editingEngineId, setEditingEngineId] = useState<string | null>(null);
  const [isAddingEngine, setIsAddingEngine] = useState(false);
  const [engineNameInput, setEngineNameInput] = useState('');
  const [engineHomeUrlInput, setEngineHomeUrlInput] = useState('');
  const [engineSearchUrlInput, setEngineSearchUrlInput] = useState('');
  const [engineError, setEngineError] = useState<string | null>(null);

  // Drag & drop active state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const activeFav = useMemo(() => {
    return activeDragId ? browserSettings.favorites.find((f) => f.id === activeDragId) : null;
  }, [activeDragId, browserSettings.favorites]);

  const accessibility = useMemo(
    () =>
      Accessibility.configure({
        screenReaderInstructions: {
          draggable: t('settings.browser.reorderFavorite'),
        },
        announcements: {
          dragstart: () => t('settings.browser.reorderFavorite'),
          dragend: () => t('settings.browser.favorites'),
        },
      }),
    [],
  );

  return (
    <div className="maw-settings-groups">
      {/* Search Engine Selection Card */}
      <div
        id="setting-card-search-engine"
        className={`maw-settings-card ${
          highlightedCardId === 'setting-card-search-engine' ? 'maw-settings-card-highlighted' : ''
        }`}
      >
        <div className="maw-settings-card-header maw-settings-card-header-flex">
          <span className="maw-settings-card-title">{t('settings.browser.searchEngine')}</span>
          <div className="maw-settings-card-header-actions">
            {!isAddingEngine && !editingEngineId && (
              <>
                <button
                  type="button"
                  className="maw-settings-engine-action-btn"
                  onClick={() => {
                    setIsAddingEngine(true);
                    setEditingEngineId(null);
                    setEngineNameInput('');
                    setEngineHomeUrlInput('');
                    setEngineSearchUrlInput('');
                    setEngineError(null);
                  }}
                >
                  + {t('settings.browser.addEngine')}
                </button>
                <button
                  type="button"
                  className="maw-settings-link-btn"
                  onClick={() => browserSettings.restoreBuiltinSearchEngines()}
                  title={t('settings.browser.restoreEngines')}
                >
                  {t('settings.browser.restoreEngines')}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="maw-settings-card-body">
          <p className="maw-settings-hint">{t('settings.browser.searchEngineDesc')}</p>

          {/* Form for Adding / Editing Search Engine */}
          {(isAddingEngine || editingEngineId) && (
            <form
              className="maw-settings-favorite-form maw-settings-engine-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddingEngine) {
                  const res = browserSettings.addSearchEngine({
                    name: engineNameInput,
                    homeUrl: engineHomeUrlInput,
                    searchUrl: engineSearchUrlInput,
                  });
                  if (!res.success) {
                    setEngineError(res.error ?? 'Invalid search engine');
                  } else {
                    setIsAddingEngine(false);
                    setEngineNameInput('');
                    setEngineHomeUrlInput('');
                    setEngineSearchUrlInput('');
                    setEngineError(null);
                  }
                } else if (editingEngineId) {
                  const res = browserSettings.editSearchEngine(editingEngineId, {
                    name: engineNameInput,
                    homeUrl: engineHomeUrlInput,
                    searchUrl: engineSearchUrlInput,
                  });
                  if (!res.success) {
                    setEngineError(res.error ?? 'Invalid search engine');
                  } else {
                    setEditingEngineId(null);
                    setEngineNameInput('');
                    setEngineHomeUrlInput('');
                    setEngineSearchUrlInput('');
                    setEngineError(null);
                  }
                }
              }}
            >
              <div className="maw-settings-form-row">
                <label className="maw-settings-form-field">
                  <span>{t('settings.browser.engineName')}</span>
                  <input
                    autoFocus
                    type="text"
                    required
                    maxLength={120}
                    value={engineNameInput}
                    onChange={(e) => {
                      setEngineNameInput(e.target.value);
                      setEngineError(null);
                    }}
                    placeholder="e.g. Kagi"
                  />
                </label>
                <label className="maw-settings-form-field">
                  <span>{t('settings.browser.homeUrl')}</span>
                  <input
                    type="url"
                    required
                    maxLength={2048}
                    value={engineHomeUrlInput}
                    onChange={(e) => {
                      setEngineHomeUrlInput(e.target.value);
                      setEngineError(null);
                    }}
                    placeholder="https://kagi.com"
                  />
                </label>
              </div>
              <div className="maw-settings-form-row">
                <label className="maw-settings-form-field maw-settings-form-field-full">
                  <span>{t('settings.browser.searchUrl')}</span>
                  <input
                    type="text"
                    required
                    maxLength={2048}
                    value={engineSearchUrlInput}
                    onChange={(e) => {
                      setEngineSearchUrlInput(e.target.value);
                      setEngineError(null);
                    }}
                    placeholder="https://kagi.com/search?q=%s"
                  />
                  <span className="maw-settings-form-hint">{t('settings.browser.searchUrlHint')}</span>
                </label>
              </div>
              {engineError && (
                <p role="alert" className="agency-error maw-settings-fav-error">
                  {engineError}
                </p>
              )}
              <div className="maw-settings-form-actions">
                <button type="submit" className="agency-button-primary">
                  {t('common.save')}
                </button>
                <button
                  type="button"
                  className="agency-button-secondary"
                  onClick={() => {
                    setIsAddingEngine(false);
                    setEditingEngineId(null);
                    setEngineError(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}

          {/* Search Engines List */}
          <div
            className="maw-settings-choices maw-settings-engines-list"
            role="radiogroup"
            aria-label={t('settings.browser.searchEngine')}
          >
            {browserSettings.searchEngines.map((engine) => (
              <div key={engine.id} className="maw-settings-engine-row">
                <label className="maw-settings-choice maw-settings-engine-choice">
                  <input
                    type="radio"
                    name="default-search-engine"
                    checked={browserSettings.defaultSearchEngine === engine.id}
                    onChange={() => browserSettings.setDefaultSearchEngine(engine.id)}
                  />
                  <div className="maw-settings-engine-labels">
                    <div className="maw-settings-engine-title-line">
                      <span className="maw-settings-choice-label">{engine.name}</span>
                      <span className={`maw-settings-engine-badge ${engine.isBuiltin ? 'builtin' : 'custom'}`}>
                        {engine.isBuiltin ? t('settings.browser.builtinBadge') : t('settings.browser.customBadge')}
                      </span>
                    </div>
                    <span className="maw-settings-choice-meta">{engine.searchUrl}</span>
                  </div>
                </label>
                <div className="maw-settings-engine-actions">
                  <button
                    type="button"
                    className="icon-button maw-settings-fav-btn maw-settings-engine-edit-btn"
                    title={t('settings.browser.editEngine')}
                    aria-label={`${t('settings.browser.editEngine')}: ${engine.name}`}
                    onClick={() => {
                      setEditingEngineId(engine.id);
                      setIsAddingEngine(false);
                      setEngineNameInput(engine.name);
                      setEngineHomeUrlInput(engine.homeUrl);
                      setEngineSearchUrlInput(engine.searchUrl);
                      setEngineError(null);
                    }}
                  >
                    ✎
                  </button>
                  {!engine.isBuiltin && (
                    <button
                      type="button"
                      className="icon-button maw-settings-fav-btn maw-settings-fav-delete maw-settings-engine-delete-btn"
                      title={t('settings.browser.deleteEngine')}
                      aria-label={`${t('settings.browser.deleteEngine')}: ${engine.name}`}
                      onClick={() => browserSettings.removeSearchEngine(engine.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Favorites Management Card */}
      <div
        id="setting-card-favorites"
        className={`maw-settings-card ${
          highlightedCardId === 'setting-card-favorites' ? 'maw-settings-card-highlighted' : ''
        }`}
      >
        <div className="maw-settings-card-header maw-settings-card-header-flex">
          <span className="maw-settings-card-title">{t('settings.browser.favorites')}</span>
          {!isAddingFavorite && !editingFavoriteId && (
            <button
              type="button"
              className="maw-settings-action-btn"
              onClick={() => {
                setIsAddingFavorite(true);
                setEditingFavoriteId(null);
                setFavTitleInput('');
                setFavUrlInput('');
                setFavError(null);
              }}
            >
              + {t('settings.browser.addFavorite')}
            </button>
          )}
        </div>
        <div className="maw-settings-card-body">
          <p className="maw-settings-hint">{t('settings.browser.favoritesDesc')}</p>

          {/* Form for Adding / Editing Favorite */}
          {(isAddingFavorite || editingFavoriteId) && (
            <form
              className="maw-settings-favorite-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddingFavorite) {
                  const res = browserSettings.addFavorite({
                    title: favTitleInput,
                    url: favUrlInput,
                  });
                  if (!res.success) {
                    setFavError(res.error ?? 'Invalid input');
                  } else {
                    setIsAddingFavorite(false);
                    setFavTitleInput('');
                    setFavUrlInput('');
                    setFavError(null);
                  }
                } else if (editingFavoriteId) {
                  const res = browserSettings.editFavorite(editingFavoriteId, {
                    title: favTitleInput,
                    url: favUrlInput,
                  });
                  if (!res.success) {
                    setFavError(res.error ?? 'Invalid input');
                  } else {
                    setEditingFavoriteId(null);
                    setFavTitleInput('');
                    setFavUrlInput('');
                    setFavError(null);
                  }
                }
              }}
            >
              <div className="maw-settings-form-row">
                <label className="maw-settings-form-field">
                  <span>{t('settings.browser.name')}</span>
                  <input
                    autoFocus
                    type="text"
                    required
                    maxLength={120}
                    value={favTitleInput}
                    onChange={(e) => {
                      setFavTitleInput(e.target.value);
                      setFavError(null);
                    }}
                    placeholder="e.g. Documentation"
                  />
                </label>
                <label className="maw-settings-form-field">
                  <span>{t('settings.browser.url')}</span>
                  <input
                    type="url"
                    required
                    maxLength={2048}
                    value={favUrlInput}
                    onChange={(e) => {
                      setFavUrlInput(e.target.value);
                      setFavError(null);
                    }}
                    placeholder="https://..."
                  />
                </label>
              </div>
              {favError && (
                <p role="alert" className="agency-error maw-settings-fav-error">
                  {favError}
                </p>
              )}
              <div className="maw-settings-form-actions">
                <button type="submit" className="agency-button-primary">
                  {t('common.save')}
                </button>
                <button
                  type="button"
                  className="agency-button-secondary"
                  onClick={() => {
                    setIsAddingFavorite(false);
                    setEditingFavoriteId(null);
                    setFavError(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}

          {browserSettings.favorites.length === 0 ? (
            <div className="maw-settings-empty-favorites">
              <p className="maw-settings-hint">{t('settings.browser.noFavorites')}</p>
            </div>
          ) : (
            <DragDropProvider
              sensors={sensors}
              plugins={(defaults) => [...defaults, accessibility]}
              onDragStart={(event) => {
                const sourceId = event.operation.source?.id;
                if (sourceId) setActiveDragId(String(sourceId));
              }}
              onDragEnd={(event) => {
                setActiveDragId(null);
                const { source, target } = event.operation;
                if (event.canceled || !source || !target || source.id === target.id) return;
                const sourceId = String(source.id);
                const targetId = String(target.id);
                const ids = browserSettings.favorites.map((f) => f.id);
                const sourceIndex = ids.indexOf(sourceId);
                const targetIndex = ids.indexOf(targetId);
                if (sourceIndex === -1 || targetIndex === -1) return;
                const newOrder = [...ids];
                newOrder.splice(sourceIndex, 1);
                newOrder.splice(targetIndex, 0, sourceId);
                browserSettings.reorderFavorites(newOrder);
              }}
            >
              <ul className="maw-settings-favorites-list">
                {browserSettings.favorites.map((fav, index) => (
                  <FavoriteRowItem
                    key={fav.id}
                    fav={fav}
                    index={index}
                    total={browserSettings.favorites.length}
                    onEdit={() => {
                      setEditingFavoriteId(fav.id);
                      setIsAddingFavorite(false);
                      setFavTitleInput(fav.title);
                      setFavUrlInput(fav.url);
                      setFavError(null);
                    }}
                    onRemove={() => browserSettings.removeFavorite(fav.id)}
                    onMove={(dir) => browserSettings.moveFavorite(fav.id, dir)}
                  />
                ))}
              </ul>

              <DragOverlay>
                {activeFav ? (
                  <div className="maw-settings-favorite-row maw-fav-drag-overlay">
                    <span className="icon-button maw-fav-grip is-dragging" aria-hidden="true">
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                        <circle cx="3" cy="2.5" r="1.2" />
                        <circle cx="7" cy="2.5" r="1.2" />
                        <circle cx="3" cy="7" r="1.2" />
                        <circle cx="7" cy="7" r="1.2" />
                        <circle cx="3" cy="11.5" r="1.2" />
                        <circle cx="7" cy="11.5" r="1.2" />
                      </svg>
                    </span>
                    <div className="maw-settings-fav-info">
                      <span className="maw-settings-fav-title">{activeFav.title}</span>
                      <span className="maw-settings-fav-url">{activeFav.url}</span>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DragDropProvider>
          )}

          <div className="maw-settings-favorites-footer">
            <button
              type="button"
              className="maw-settings-link-btn"
              onClick={() => browserSettings.resetToDefaults()}
            >
              {t('settings.browser.resetDefaults')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
