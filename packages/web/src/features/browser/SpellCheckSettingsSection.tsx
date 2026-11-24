import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_BROWSER_PROFILE_ID, type BrowserProfile } from '@agent-workbench/shared';
import { getLocale, t } from '../../i18n/index.js';
import type { SpellCheckDictionaryStatusEntry } from '../../connection/desktop-bridge.js';
import type { UseBrowserSettingsResult } from './useBrowserSettings.js';
import { CollapsibleSubsection } from '../settings/CollapsibleSubsection.js';

const FALLBACK_AVAILABLE_LANGUAGES = [
  'en-US', 'en-GB', 'en-CA', 'en-AU',
  'pt-BR', 'pt-PT',
  'es', 'es-ES', 'es-419', 'es-AR',
  'fr', 'fr-FR',
  'de', 'de-DE',
  'it', 'it-IT',
  'ru',
  'ja',
  'ko',
  'zh-CN',
  'nl', 'pl', 'sv', 'da', 'nb', 'tr', 'el', 'uk', 'ro', 'cs', 'hu', 'id',
];

export function getLanguageDisplayName(code: string, displayLocale = 'en'): string {
  try {
    const dn = new Intl.DisplayNames([displayLocale, 'en'], { type: 'language' });
    const name = dn.of(code);
    return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : code;
  } catch {
    return code;
  }
}

export interface SpellCheckSettingsSectionProps {
  browserSettings: UseBrowserSettingsResult;
  browserProfiles?: readonly BrowserProfile[];
  remoteClient?: boolean;
  highlighted?: boolean;
  expandSignal?: number;
}

export function SpellCheckSettingsSection({
  browserSettings,
  browserProfiles,
  remoteClient = false,
  highlighted,
  expandSignal,
}: SpellCheckSettingsSectionProps): JSX.Element {
  const {
    spellCheck,
    nativeDictionarySync,
    retryNativeDictionarySync,
    setSpellCheckEnabled,
    toggleSpellCheckLanguage,
    addSpellCheckLanguage,
    removeSpellCheckLanguage,
    getCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
  } = browserSettings;

  const isEnabled = spellCheck.enabled !== false;
  const configuredLanguages = Array.isArray(spellCheck.configuredLanguages)
    ? spellCheck.configuredLanguages
    : (Array.isArray(spellCheck.languages) ? spellCheck.languages : []);
  const activeLanguages = Array.isArray(spellCheck.languages) ? spellCheck.languages : [];
  const currentLocale = getLocale();
  const canEditCustomDictionary = typeof window !== 'undefined' && Boolean(window.mawChatGpt) && !remoteClient;

  const availableProfiles = useMemo<readonly BrowserProfile[]>(() => {
    if (browserProfiles && browserProfiles.length > 0) return browserProfiles;
    return [
      {
        id: DEFAULT_BROWSER_PROFILE_ID,
        name: t('settings.browser.mainProfile'),
        createdAt: '',
        updatedAt: '',
        isDefault: true,
      },
    ];
  }, [browserProfiles]);

  const [selectedProfileId, setSelectedProfileId] = useState<string>(DEFAULT_BROWSER_PROFILE_ID);

  useEffect(() => {
    if (!availableProfiles.some((p) => p.id === selectedProfileId)) {
      setSelectedProfileId(DEFAULT_BROWSER_PROFILE_ID);
    }
  }, [availableProfiles, selectedProfileId]);

  const customWords = getCustomDictionaryWords(selectedProfileId);

  const [isAddingLanguage, setIsAddingLanguage] = useState(false);
  const [langSearchQuery, setLangSearchQuery] = useState('');
  const [availableLanguages, setAvailableLanguages] = useState<string[]>(FALLBACK_AVAILABLE_LANGUAGES);
  const [dictionaryStatuses, setDictionaryStatuses] = useState<Record<string, SpellCheckDictionaryStatusEntry>>({});

  const [newWordInput, setNewWordInput] = useState('');
  const [wordError, setWordError] = useState<string | null>(null);
  const [wordSearchQuery, setWordSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchAvailable = async () => {
      try {
        const res = await window.mawChatGpt?.command({ type: 'get-available-spellcheck-languages' }) as {
          ok?: boolean;
          languages?: string[];
        } | undefined;
        if (!cancelled && res?.ok && Array.isArray(res.languages) && res.languages.length > 0) {
          setAvailableLanguages(res.languages);
        }
      } catch {
        // Fall back to default list
      }
    };
    void fetchAvailable();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await window.mawChatGpt?.command({ type: 'get-spellcheck-status' }) as {
          ok?: boolean;
          statuses?: Record<string, SpellCheckDictionaryStatusEntry>;
        } | undefined;
        if (!cancelled && res?.ok && res.statuses && typeof res.statuses === 'object') {
          setDictionaryStatuses(res.statuses);
        }
      } catch {
        // Ignore bridge unavailability
      }
    };
    void fetchStatus();
    return () => {
      cancelled = true;
    };
  }, [isEnabled, activeLanguages.join(',')]);

  useEffect(() => {
    return window.mawChatGpt?.subscribe((state) => {
      if (state.type !== 'spellcheck-dictionary-status') return;
      if (state.statuses && typeof state.statuses === 'object') {
        setDictionaryStatuses(state.statuses);
      }
    });
  }, []);

  const unconfiguredLanguages = useMemo(() => {
    return availableLanguages.filter((code) => !configuredLanguages.includes(code));
  }, [availableLanguages, configuredLanguages]);

  const filteredCandidateLanguages = useMemo(() => {
    const q = langSearchQuery.trim().toLowerCase();
    if (!q) return unconfiguredLanguages;
    return unconfiguredLanguages.filter((code) => {
      const name = getLanguageDisplayName(code, currentLocale).toLowerCase();
      return code.toLowerCase().includes(q) || name.includes(q);
    });
  }, [unconfiguredLanguages, langSearchQuery, currentLocale]);

  const filteredCustomWords = useMemo(() => {
    const q = wordSearchQuery.trim().toLowerCase();
    if (!q) return customWords;
    return customWords.filter((w) => w.toLowerCase().includes(q));
  }, [customWords, wordSearchQuery]);

  const handleAddWordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newWordInput.trim();
    if (!clean) return;
    const res = await addCustomDictionaryWord(clean, selectedProfileId);
    if (res.success) {
      setNewWordInput('');
      setWordError(null);
    } else {
      setWordError(res.error || 'Failed to add word');
    }
  };

  const handleRemoveWord = async (word: string) => {
    const res = await removeCustomDictionaryWord(word, selectedProfileId);
    if (res.success) {
      setWordError(null);
    } else {
      setWordError(res.error || 'Failed to remove word');
    }
  };

  const failedActiveLanguages = isEnabled
    ? activeLanguages.filter((code) => dictionaryStatuses[code]?.status === 'failed')
    : [];
  const unsupportedActiveLanguages = isEnabled
    ? activeLanguages.filter((code) => dictionaryStatuses[code]?.status === 'unsupported')
    : [];
  const downloadingActiveLanguages = isEnabled
    ? activeLanguages.filter((code) => dictionaryStatuses[code]?.status === 'downloading')
    : [];

  return (
    <CollapsibleSubsection
      id="setting-card-spellcheck"
      title={t('settings.browser.spellCheckTitle')}
      highlighted={highlighted}
      forceExpanded={highlighted || isAddingLanguage}
      expandSignal={expandSignal}
      headerActions={
        <label className="maw-settings-toggle-label" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="maw-settings-checkbox"
            checked={isEnabled}
            onChange={(e) => setSpellCheckEnabled(e.target.checked)}
          />
          <span className="maw-settings-toggle-text">{t('settings.browser.enableSpellCheck')}</span>
        </label>
      }
    >
      <p className="maw-settings-hint">{t('settings.browser.spellCheckDescription')}</p>

      {/* Languages Group */}
      <div className="maw-settings-group">
        <div className="maw-settings-group-header">
          <div>
            <h4 className="maw-settings-group-title">{t('settings.browser.spellCheckLanguages')}</h4>
            <p className="maw-settings-group-hint">{t('settings.browser.spellCheckLanguagesDescription')}</p>
          </div>
          {!isAddingLanguage && (
            <button
              type="button"
              className="maw-settings-action-btn"
              onClick={() => {
                setIsAddingLanguage(true);
                setLangSearchQuery('');
              }}
            >
              + {t('settings.browser.addLanguage')}
            </button>
          )}
        </div>

        {/* Add Language Form */}
        {isAddingLanguage && (
          <div className="maw-settings-form-box">
            <div className="maw-settings-form-row">
              <input
                type="text"
                className="maw-settings-input maw-settings-filter-input"
                placeholder={t('settings.browser.searchLanguagesPlaceholder')}
                value={langSearchQuery}
                onChange={(e) => setLangSearchQuery(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="maw-settings-btn-secondary"
                onClick={() => setIsAddingLanguage(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
            <div className="maw-settings-lang-picker-list" role="list">
              {filteredCandidateLanguages.slice(0, 50).map((code) => (
                <div key={code} className="maw-settings-lang-picker-item">
                  <span className="maw-settings-lang-name">{getLanguageDisplayName(code, currentLocale)}</span>
                  <span className="maw-settings-lang-badge">{code}</span>
                  <button
                    type="button"
                    className="maw-settings-btn-primary maw-settings-btn-sm"
                    onClick={() => {
                      addSpellCheckLanguage(code);
                      setIsAddingLanguage(false);
                      setLangSearchQuery('');
                    }}
                  >
                    {t('settings.browser.addLanguage')}
                  </button>
                </div>
              ))}
              {filteredCandidateLanguages.length === 0 && (
                <div className="maw-settings-empty-hint">{t('agency.browser.noMatches')}</div>
              )}
            </div>
          </div>
        )}

        {/* Configured Languages List */}
        <div className="maw-settings-lang-list" role="list">
          {configuredLanguages.map((code) => {
            const isLangActive = activeLanguages.includes(code);
            const displayName = getLanguageDisplayName(code, currentLocale);

            return (
              <div key={code} className="maw-settings-lang-item" role="listitem">
                <label className="maw-settings-lang-toggle-label">
                  <input
                    type="checkbox"
                    className="maw-settings-checkbox"
                    checked={isLangActive}
                    disabled={!isEnabled}
                    onChange={() => toggleSpellCheckLanguage(code)}
                  />
                  <span className="maw-settings-lang-name">{displayName}</span>
                  <span className="maw-settings-lang-badge">{code}</span>
                </label>
                <button
                  type="button"
                  className="icon-button maw-settings-fav-btn maw-settings-fav-delete"
                  title={t('settings.browser.removeLanguage', { name: displayName })}
                  aria-label={t('settings.browser.removeLanguage', { name: displayName })}
                  onClick={() => removeSpellCheckLanguage(code)}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {configuredLanguages.length === 0 && (
            <div className="maw-settings-empty-hint">{t('settings.browser.noConfiguredLanguages')}</div>
          )}
        </div>
        {downloadingActiveLanguages.map((code) => (
          <div key={`dl-${code}`} className="maw-settings-empty-hint" role="status">
            {t('settings.browser.dictionaryDownloading', { name: getLanguageDisplayName(code, currentLocale) })}
          </div>
        ))}
        {failedActiveLanguages.map((code) => (
          <div key={`fail-${code}`} className="maw-settings-warning-text" role="status">
            {t('settings.browser.dictionaryDownloadFailed', { name: getLanguageDisplayName(code, currentLocale) })}
          </div>
        ))}
        {unsupportedActiveLanguages.map((code) => (
          <div key={`unsup-${code}`} className="maw-settings-warning-text" role="status">
            {t('settings.browser.dictionaryUnsupported', { name: getLanguageDisplayName(code, currentLocale) })}
          </div>
        ))}
      </div>

      {/* Custom Dictionary Group */}
      <div className="maw-settings-group">
        <div className="maw-settings-group-header">
          <div>
            <h4 className="maw-settings-group-title">{t('settings.browser.customDictionary')}</h4>
            <p className="maw-settings-group-hint">{t('settings.browser.customDictionaryDescription')}</p>
          </div>
          <label className="maw-settings-dict-profile-row">
            <span className="maw-settings-group-hint">{t('settings.browser.customDictionaryProfile')}</span>
            <select
              className="maw-settings-select"
              aria-label={t('settings.browser.customDictionaryProfile')}
              value={selectedProfileId}
              onChange={(e) => {
                setSelectedProfileId(e.target.value);
                setWordError(null);
              }}
            >
              {availableProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!canEditCustomDictionary && (
          <div className="maw-settings-empty-hint" role="status">
            {t('settings.browser.customDictionaryDesktopOnly')}
          </div>
        )}

        {/* Add Word Form */}
        <form onSubmit={handleAddWordSubmit} className="maw-settings-dict-add-form">
          <input
            type="text"
            className="maw-settings-input"
            placeholder={t('settings.browser.wordPlaceholder')}
            value={newWordInput}
            disabled={!canEditCustomDictionary}
            onChange={(e) => {
              setNewWordInput(e.target.value);
              if (wordError) setWordError(null);
            }}
          />
          <button
            type="submit"
            className="maw-settings-btn-primary"
            disabled={!canEditCustomDictionary || !newWordInput.trim()}
          >
            + {t('settings.browser.addWord')}
          </button>
        </form>
        {wordError && <div className="maw-settings-error-text">{wordError}</div>}
        {nativeDictionarySync.status === 'failed' && canEditCustomDictionary && (
          <div className="maw-settings-warning-text" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{t('settings.browser.customDictionarySyncPending')}</span>
            <button
              type="button"
              className="maw-settings-btn-secondary maw-settings-btn-sm"
              onClick={() => void retryNativeDictionarySync()}
            >
              {t('settings.browser.retrySync')}
            </button>
          </div>
        )}

        {/* Search Custom Words */}
        {customWords.length > 5 && (
          <div className="maw-settings-filter-row">
            <input
              type="text"
              className="maw-settings-input maw-settings-filter-input"
              placeholder={t('settings.browser.searchWordsPlaceholder')}
              value={wordSearchQuery}
              onChange={(e) => setWordSearchQuery(e.target.value)}
            />
          </div>
        )}

        {/* Words List */}
        <div className="maw-settings-dict-list" role="list">
          {filteredCustomWords.map((word) => (
            <div key={word} className="maw-settings-dict-item" role="listitem">
              <span className="maw-settings-dict-word">{word}</span>
              <button
                type="button"
                className="icon-button maw-settings-fav-btn maw-settings-fav-delete"
                title={t('settings.browser.removeWord', { word })}
                aria-label={t('settings.browser.removeWord', { word })}
                disabled={!canEditCustomDictionary}
                onClick={() => void handleRemoveWord(word)}
              >
                ✕
              </button>
            </div>
          ))}
          {customWords.length === 0 && (
            <div className="maw-settings-empty-hint">{t('settings.browser.noCustomWords')}</div>
          )}
        </div>
      </div>
    </CollapsibleSubsection>
  );
}
