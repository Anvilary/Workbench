/**
 * Modular Browser settings section component for SettingsDialog.
 *
 * Implements:
 * - Search Engine Management (default selection, add, edit, delete any including built-in, restore defaults)
 * - Browser Profiles Management (Main + custom profiles, create empty/clone with site auth clearing, rename, clear site auth, delete custom)
 * - Favorites Drag and Drop reordering using @dnd-kit/react and @dnd-kit/dom with keyboard accessibility
 */

import { useCallback, useMemo, useState } from 'react';
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable, useDroppable } from '@dnd-kit/react';
import { Accessibility, KeyboardSensor, PointerActivationConstraints } from '@dnd-kit/dom';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserFavorite,
  type BrowserProfile,
  type BrowserProfileId,
  type BrowserProfileSite,
} from '@agent-workbench/shared';
import { t, type MessageKey } from '../../i18n/index.js';
import type { UseBrowserSettingsResult } from './useBrowserSettings.js';
import { CollapsibleSubsection } from '../settings/CollapsibleSubsection.js';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.js';
import { SpellCheckSettingsSection } from './SpellCheckSettingsSection.js';

const sensors = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];

const SITE_AUTH_OPTIONS: readonly { site: BrowserProfileSite; labelKey: MessageKey }[] = [
  { site: 'chatgpt', labelKey: 'settings.browser.siteChatgpt' },
  { site: 'github', labelKey: 'settings.browser.siteGithub' },
  { site: 'perplexity', labelKey: 'settings.browser.sitePerplexity' },
  { site: 'browser', labelKey: 'settings.browser.siteOther' },
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
          title={t('settings.browser.deleteFavorite')}
          aria-label={t('settings.browser.deleteFavorite')}
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
  expandSignal?: number;
  browserProfiles?: readonly BrowserProfile[];
  onCreateBrowserProfile?: (input: {
    name: string;
    sourceProfileId?: BrowserProfileId;
    clearSites?: readonly BrowserProfileSite[];
  }) => void | Promise<unknown>;
  onRenameBrowserProfile?: (profileId: BrowserProfileId, name: string) => void | Promise<unknown>;
  onDeleteBrowserProfile?: (profileId: BrowserProfileId) => void | Promise<unknown>;
  onClearBrowserProfileSiteAuth?: (
    profileId: BrowserProfileId,
    sites: readonly BrowserProfileSite[],
  ) => void | Promise<unknown>;
}

export function BrowserSettingsSection({
  browserSettings,
  highlightedCardId,
  expandSignal,
  browserProfiles,
  onCreateBrowserProfile,
  onRenameBrowserProfile,
  onDeleteBrowserProfile,
  onClearBrowserProfileSiteAuth,
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

  // Browser Profiles Form State
  const [isAddingProfile, setIsAddingProfile] = useState(false);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileMode, setProfileMode] = useState<'empty' | 'clone'>('empty');
  const [cloneSourceId, setCloneSourceId] = useState<BrowserProfileId>(DEFAULT_BROWSER_PROFILE_ID);
  const [cloneClearSites, setCloneClearSites] = useState<BrowserProfileSite[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  // Rename / Clear Site Auth / Delete Confirmation State
  const [renamingProfileId, setRenamingProfileId] = useState<BrowserProfileId | null>(null);
  const [renameProfileInput, setRenameProfileInput] = useState('');
  const [clearingProfileId, setClearingProfileId] = useState<BrowserProfileId | null>(null);
  const [clearSelectedSites, setClearSelectedSites] = useState<BrowserProfileSite[]>([]);
  const [deletingProfile, setDeletingProfile] = useState<BrowserProfile | null>(null);
  const [sectionExpandSignal, setSectionExpandSignal] = useState(0);

  // Drag & drop active state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const activeFav = useMemo(() => {
    return activeDragId ? browserSettings.favorites.find((f) => f.id === activeDragId) : null;
  }, [activeDragId, browserSettings.favorites]);

  const effectiveProfiles = useMemo<readonly BrowserProfile[]>(() => {
    const baseMain: BrowserProfile = {
      id: DEFAULT_BROWSER_PROFILE_ID,
      name: t('settings.browser.mainProfile'),
      createdAt: '',
      updatedAt: '',
      isDefault: true,
    };
    if (!browserProfiles || browserProfiles.length === 0) {
      return [baseMain];
    }
    const hasMain = browserProfiles.some((p) => p.id === DEFAULT_BROWSER_PROFILE_ID || p.isDefault);
    return hasMain ? browserProfiles : [baseMain, ...browserProfiles];
  }, [browserProfiles]);

  const accessibility = useMemo(
    () =>
      Accessibility.configure({
        screenReaderInstructions: {
          draggable: t('settings.browser.reorderInstructions'),
        },
        announcements: {
          dragstart: () => t('settings.browser.reorderInstructions'),
          dragend: () => t('settings.browser.favorites'),
        },
      }),
    [],
  );

  const toggleSiteSelection = (
    current: readonly BrowserProfileSite[],
    site: BrowserProfileSite,
  ): BrowserProfileSite[] => {
    return current.includes(site) ? current.filter((s) => s !== site) : [...current, site];
  };

  const handleCreateProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = profileNameInput.trim();
    if (!trimmed) {
      setProfileError(t('settings.browser.profileNameRequired'));
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    try {
      await Promise.resolve(
        onCreateBrowserProfile?.({
          name: trimmed,
          ...(profileMode === 'clone' ? { sourceProfileId: cloneSourceId } : {}),
          ...(profileMode === 'clone' && cloneClearSites.length > 0 ? { clearSites: cloneClearSites } : {}),
        }),
      );
      setIsAddingProfile(false);
      setProfileNameInput('');
      setProfileMode('empty');
      setCloneClearSites([]);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent, profileId: BrowserProfileId) => {
    e.preventDefault();
    const trimmed = renameProfileInput.trim();
    if (!trimmed) {
      setProfileError(t('settings.browser.profileNameRequired'));
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    try {
      await Promise.resolve(onRenameBrowserProfile?.(profileId, trimmed));
      setRenamingProfileId(null);
      setRenameProfileInput('');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleClearSitesSubmit = async (profileId: BrowserProfileId) => {
    if (clearSelectedSites.length === 0) {
      setProfileError(t('settings.browser.clearSiteAuthSelectOne'));
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    try {
      await Promise.resolve(onClearBrowserProfileSiteAuth?.(profileId, clearSelectedSites));
      setClearingProfileId(null);
      setClearSelectedSites([]);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleDeleteProfile = async (profileId: BrowserProfileId) => {
    if (profileId === DEFAULT_BROWSER_PROFILE_ID) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      await Promise.resolve(onDeleteBrowserProfile?.(profileId));
      if (renamingProfileId === profileId) setRenamingProfileId(null);
      if (clearingProfileId === profileId) setClearingProfileId(null);
      setDeletingProfile(null);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div className="maw-settings-groups">
      {/* Search Engine Selection Card */}
      <CollapsibleSubsection
        id="setting-card-search-engine"
        title={t('settings.browser.searchEngine')}
        highlighted={highlightedCardId === 'setting-card-search-engine'}
        forceExpanded={highlightedCardId === 'setting-card-search-engine' || isAddingEngine || Boolean(editingEngineId)}
        expandSignal={(expandSignal ?? 0) + sectionExpandSignal}
        headerActions={
          !isAddingEngine && !editingEngineId ? (
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
                  setSectionExpandSignal((prev) => prev + 1);
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
          ) : undefined
        }
      >
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
                  setEngineError(res.error ?? t('agency.web.invalidUrl'));
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
                  setEngineError(res.error ?? t('agency.web.invalidUrl'));
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
                  placeholder={t('settings.browser.engineNamePlaceholder')}
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
                  placeholder={t('settings.browser.homeUrlPlaceholder')}
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
                  placeholder={t('settings.browser.searchUrlPlaceholder')}
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
        {browserSettings.searchEngines.length === 0 ? (
          <div className="maw-settings-empty-favorites">
            <p className="maw-settings-hint">{t('settings.browser.noSearchEngines')}</p>
          </div>
        ) : (
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
                  <button
                    type="button"
                    className="icon-button maw-settings-fav-btn maw-settings-fav-delete maw-settings-engine-delete-btn"
                    title={t('settings.browser.deleteEngine')}
                    aria-label={`${t('settings.browser.deleteEngine')}: ${engine.name}`}
                    disabled={browserSettings.searchEngines.length <= 1}
                    onClick={() => {
                      const res = browserSettings.removeSearchEngine(engine.id);
                      if (!res.success && res.error) setEngineError(res.error);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSubsection>

      {/* Browser Profiles Management Card */}
      <CollapsibleSubsection
        id="setting-card-browser-profiles"
        title={t('settings.browser.profiles')}
        highlighted={highlightedCardId === 'setting-card-browser-profiles'}
        forceExpanded={highlightedCardId === 'setting-card-browser-profiles' || isAddingProfile}
        expandSignal={(expandSignal ?? 0) + sectionExpandSignal}
        headerActions={
          !isAddingProfile ? (
            <button
              type="button"
              className="maw-settings-engine-action-btn maw-settings-add-browser-profile-btn"
              onClick={() => {
                setIsAddingProfile(true);
                setProfileNameInput('');
                setProfileMode('empty');
                setCloneSourceId(effectiveProfiles[0]?.id ?? DEFAULT_BROWSER_PROFILE_ID);
                setCloneClearSites([]);
                setProfileError(null);
                setSectionExpandSignal((prev) => prev + 1);
              }}
            >
              + {t('settings.browser.addProfile')}
            </button>
          ) : undefined
        }
      >
        <p className="maw-settings-hint">{t('settings.browser.profilesDesc')}</p>

        {isAddingProfile && (
          <form className="maw-settings-favorite-form maw-settings-profile-form" onSubmit={handleCreateProfileSubmit} noValidate>
            <div className="maw-settings-form-row">
              <label className="maw-settings-form-field">
                <span>{t('settings.browser.profileName')}</span>
                <input
                  autoFocus
                  type="text"
                  required
                  maxLength={80}
                  value={profileNameInput}
                  onChange={(e) => {
                    setProfileNameInput(e.target.value);
                    setProfileError(null);
                  }}
                  placeholder={t('settings.browser.profileNamePlaceholder')}
                />
              </label>
              <label className="maw-settings-form-field">
                <span>{t('settings.browser.profileMode')}</span>
                <select
                  value={profileMode}
                  onChange={(e) => {
                    setProfileMode(e.target.value as 'empty' | 'clone');
                    setProfileError(null);
                  }}
                >
                  <option value="empty">{t('settings.browser.profileEmpty')}</option>
                  {onClearBrowserProfileSiteAuth && <option value="clone">{t('settings.browser.profileClone')}</option>}
                </select>
              </label>
            </div>

            {profileMode === 'clone' && (
              <>
                <div className="maw-settings-form-row">
                  <label className="maw-settings-form-field maw-settings-form-field-full">
                    <span>{t('settings.browser.sourceProfile')}</span>
                    <select
                      value={cloneSourceId}
                      onChange={(e) => setCloneSourceId(e.target.value)}
                    >
                      {effectiveProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="maw-settings-form-row">
                  <div className="maw-settings-form-field maw-settings-form-field-full">
                    <span>{t('settings.browser.clearAuthOnClone')}</span>
                    <div className="maw-settings-profile-sites">
                      {SITE_AUTH_OPTIONS.map((opt) => (
                        <label key={opt.site} className="maw-settings-profile-site-check">
                          <input
                            type="checkbox"
                            checked={cloneClearSites.includes(opt.site)}
                            onChange={() => setCloneClearSites((prev) => toggleSiteSelection(prev, opt.site))}
                          />
                          <span>{t(opt.labelKey)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            <div className="maw-settings-form-actions">
              <button type="submit" className="agency-button-primary" disabled={profileBusy}>
                {t('common.save')}
              </button>
              <button
                type="button"
                className="agency-button-secondary"
                disabled={profileBusy}
                onClick={() => {
                  setIsAddingProfile(false);
                  setProfileError(null);
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}

        {profileError && (
          <p role="alert" className="agency-error maw-settings-fav-error">
            {profileError}
          </p>
        )}

        <ul className="maw-settings-profiles-list">
          {effectiveProfiles.map((profile) => {
            const isMain = profile.id === DEFAULT_BROWSER_PROFILE_ID || Boolean(profile.isDefault);
            const isRenaming = renamingProfileId === profile.id;
            const isClearing = clearingProfileId === profile.id;

            return (
              <li key={profile.id} className="maw-settings-profile-row" data-profile-id={profile.id}>
                <div className="maw-settings-profile-top">
                  {isRenaming ? (
                    <form
                      className="maw-settings-profile-rename-form"
                      onSubmit={(e) => handleRenameSubmit(e, profile.id)}
                      noValidate
                    >
                      <input
                        autoFocus
                        type="text"
                        maxLength={80}
                        className="maw-settings-profile-rename-input"
                        aria-label={t('settings.browser.profileName')}
                        value={renameProfileInput}
                        onChange={(e) => {
                          setRenameProfileInput(e.target.value);
                          setProfileError(null);
                        }}
                      />
                      <button type="submit" className="agency-button-primary" disabled={profileBusy}>
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="agency-button-secondary"
                        disabled={profileBusy}
                        onClick={() => {
                          setRenamingProfileId(null);
                          setProfileError(null);
                        }}
                      >
                        {t('common.cancel')}
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="maw-settings-profile-info">
                        <span className="maw-settings-profile-name">{profile.name}</span>
                        {isMain && (
                          <span className="maw-settings-profile-default-badge">
                            {t('settings.browser.defaultBadge')}
                          </span>
                        )}
                      </div>
                      <div className="maw-settings-profile-actions">
                        {onClearBrowserProfileSiteAuth && <button
                          type="button"
                          className="maw-settings-link-btn maw-settings-profile-clear-btn"
                          disabled={profileBusy}
                          onClick={() => {
                            if (isClearing) {
                              setClearingProfileId(null);
                              setClearSelectedSites([]);
                            } else {
                              setClearingProfileId(profile.id);
                              setClearSelectedSites([]);
                              setProfileError(null);
                            }
                          }}
                        >
                          {t('settings.browser.clearSiteAuth')}
                        </button>}
                        {!isMain && (
                          <>
                            <button
                              type="button"
                              className="icon-button maw-settings-fav-btn maw-settings-profile-rename-btn"
                              title={t('settings.browser.renameProfile')}
                              aria-label={`${t('settings.browser.renameProfile')}: ${profile.name}`}
                              disabled={profileBusy}
                              onClick={() => {
                                setRenamingProfileId(profile.id);
                                setRenameProfileInput(profile.name);
                                setProfileError(null);
                              }}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="icon-button maw-settings-fav-btn maw-settings-fav-delete maw-settings-profile-delete-btn"
                              title={t('settings.browser.deleteProfile')}
                              aria-label={`${t('settings.browser.deleteProfile')}: ${profile.name}`}
                              disabled={profileBusy}
                              onClick={() => {
                                setProfileError(null);
                                setDeletingProfile(profile);
                              }}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {isClearing && (
                  <div className="maw-settings-profile-clear-panel">
                    <span className="maw-settings-hint">
                      {t('settings.browser.clearSiteAuthDesc', { name: profile.name })}
                    </span>
                    <div className="maw-settings-profile-sites">
                      {SITE_AUTH_OPTIONS.map((opt) => (
                        <label key={opt.site} className="maw-settings-profile-site-check">
                          <input
                            type="checkbox"
                            checked={clearSelectedSites.includes(opt.site)}
                            onChange={() => setClearSelectedSites((prev) => toggleSiteSelection(prev, opt.site))}
                          />
                          <span>{t(opt.labelKey)}</span>
                        </label>
                      ))}
                    </div>
                    <div className="maw-settings-form-actions">
                      <button
                        type="button"
                        className="agency-button-primary"
                        disabled={profileBusy}
                        onClick={() => handleClearSitesSubmit(profile.id)}
                      >
                        {t('settings.browser.clearSelected')}
                      </button>
                      <button
                        type="button"
                        className="agency-button-secondary"
                        disabled={profileBusy}
                        onClick={() => {
                          setClearingProfileId(null);
                          setClearSelectedSites([]);
                          setProfileError(null);
                        }}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CollapsibleSubsection>

      {/* Favorites Management Card */}
      <CollapsibleSubsection
        id="setting-card-favorites"
        title={t('settings.browser.favorites')}
        highlighted={highlightedCardId === 'setting-card-favorites'}
        forceExpanded={highlightedCardId === 'setting-card-favorites' || isAddingFavorite || Boolean(editingFavoriteId)}
        expandSignal={(expandSignal ?? 0) + sectionExpandSignal}
        headerActions={
          !isAddingFavorite && !editingFavoriteId ? (
            <button
              type="button"
              className="maw-settings-action-btn"
              onClick={() => {
                setIsAddingFavorite(true);
                setEditingFavoriteId(null);
                setFavTitleInput('');
                setFavUrlInput('');
                setFavError(null);
                setSectionExpandSignal((prev) => prev + 1);
              }}
            >
              + {t('settings.browser.addFavorite')}
            </button>
          ) : undefined
        }
      >
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
                  setFavError(res.error ?? t('agency.web.invalidUrl'));
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
                  setFavError(res.error ?? t('agency.web.invalidUrl'));
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
                  placeholder={t('settings.browser.favoriteNamePlaceholder')}
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
                  placeholder={t('settings.browser.favoriteUrlPlaceholder')}
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
            onClick={() => browserSettings.resetFavoritesToDefaults()}
          >
            {t('settings.browser.resetDefaults')}
          </button>
        </div>
      </CollapsibleSubsection>

      <SpellCheckSettingsSection
        browserSettings={browserSettings}
        highlighted={highlightedCardId === 'setting-card-spellcheck'}
        expandSignal={(expandSignal ?? 0) + sectionExpandSignal}
      />

      {deletingProfile && (
        <ConfirmDialog
          title={t('settings.browser.deleteProfile')}
          message={t('settings.browser.deleteProfileConfirm', { name: deletingProfile.name })}
          error={profileError}
          confirmLabel={t('settings.browser.deleteProfile')}
          cancelLabel={t('common.cancel')}
          danger
          busy={profileBusy}
          onConfirm={() => void handleDeleteProfile(deletingProfile.id)}
          onClose={() => {
            if (!profileBusy) {
              setDeletingProfile(null);
              setProfileError(null);
            }
          }}
        />
      )}
    </div>
  );
}
