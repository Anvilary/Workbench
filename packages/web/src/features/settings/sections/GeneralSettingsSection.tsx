import { t } from '../../../i18n/index.js';
import { LocaleMenu } from '../LocaleMenu.js';
import type { TerminalThemeState } from '../../terminals/useTerminalTheme.js';
import { vaultName } from '../../vault/vault-ui.js';
import { CollapsibleSubsection } from '../CollapsibleSubsection.js';
import { TERMINAL_THEME_NAMES } from '../settings-search.js';
import { PerformanceSettingsSubsection } from './PerformanceSettingsSubsection.js';

export interface GeneralSettingsSectionProps {
  terminalTheme: TerminalThemeState;
  highlightedCardId: string | null;
  expandSignal?: number;
  onOpenVault: (() => void) | null;
  onOpenRemote: (() => void) | null;
}

export function GeneralSettingsSection({
  terminalTheme,
  highlightedCardId,
  expandSignal,
  onOpenVault,
  onOpenRemote,
}: GeneralSettingsSectionProps): JSX.Element {
  return (
    <div className="wb-settings-groups">
      <CollapsibleSubsection
        id="setting-card-language"
        title={t('settings.language')}
        highlighted={highlightedCardId === 'setting-card-language'}
        forceExpanded={highlightedCardId === 'setting-card-language'}
        expandSignal={expandSignal}
      >
        <div className="wb-settings-row">
          <div className="wb-settings-row-text">
            <span className="wb-settings-label">{t('settings.language')}</span>
            <span className="wb-settings-subtext">{t('settings.desc.general')}</span>
          </div>
          <div className="wb-settings-control">
            <LocaleMenu />
          </div>
        </div>
      </CollapsibleSubsection>

      <CollapsibleSubsection
        id="setting-card-theme"
        title={t('settings.section.appearance')}
        highlighted={highlightedCardId === 'setting-card-theme'}
        forceExpanded={highlightedCardId === 'setting-card-theme'}
        expandSignal={expandSignal}
      >
        <div className="wb-settings-row">
          <div className="wb-settings-row-text">
            <span className="wb-settings-label">{t('settings.section.appearance')}</span>
            <span className="wb-settings-subtext">{t('settings.appearance.themeDark')}</span>
          </div>
          <div className="wb-settings-control">
            <span className="wb-settings-badge badge-available">
              {t('settings.appearance.darkBadge')}
            </span>
          </div>
        </div>

        <div className="wb-settings-row wb-settings-row-top" style={{ marginTop: '12px' }}>
          <div className="wb-settings-row-text">
            <span className="wb-settings-label">{t('settings.terminalTheme')}</span>
            <span className="wb-settings-subtext">{t('settings.terminalTheme.hint')}</span>
          </div>
          <div className="wb-settings-control">
            <div
              className="wb-settings-choices"
              role="radiogroup"
              aria-label={t('settings.terminalTheme')}
            >
              {(['dark', 'follow'] as const).map((preference) => (
                <label key={preference} className="wb-settings-choice">
                  <input
                    type="radio"
                    name="terminal-theme"
                    checked={terminalTheme.preference === preference}
                    onChange={() => terminalTheme.setPreference(preference)}
                  />
                  <span className="wb-settings-choice-label">
                    {t(TERMINAL_THEME_NAMES[preference])}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </CollapsibleSubsection>

      <PerformanceSettingsSubsection
        highlighted={highlightedCardId === 'setting-card-performance'}
        expandSignal={expandSignal}
      />

      {(onOpenVault !== null || onOpenRemote !== null) && (
        <CollapsibleSubsection
          id="setting-card-more"
          title={t('settings.section.more')}
          highlighted={highlightedCardId === 'setting-card-more'}
          forceExpanded={highlightedCardId === 'setting-card-more'}
          expandSignal={expandSignal}
        >
          <div className="wb-settings-action-row">
            {onOpenVault !== null && (
              <button
                type="button"
                className="primary-button primary-button-small"
                onClick={onOpenVault}
              >
                {t('settings.more.open', { name: vaultName() })}
              </button>
            )}
            {onOpenRemote !== null && (
              <button
                type="button"
                className="primary-button primary-button-small"
                onClick={onOpenRemote}
              >
                {t('settings.more.open', { name: t('app.header.remoteAccess') })}
              </button>
            )}
          </div>
        </CollapsibleSubsection>
      )}
    </div>
  );
}
