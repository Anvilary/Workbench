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
    <div className="maw-settings-groups">
      <CollapsibleSubsection
        id="setting-card-language"
        title={t('settings.language')}
        highlighted={highlightedCardId === 'setting-card-language'}
        forceExpanded={highlightedCardId === 'setting-card-language'}
        expandSignal={expandSignal}
      >
        <div className="maw-settings-row">
          <div className="maw-settings-row-text">
            <span className="maw-settings-label">{t('settings.language')}</span>
            <span className="maw-settings-subtext">{t('settings.desc.general')}</span>
          </div>
          <div className="maw-settings-control">
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
        <div className="maw-settings-row">
          <div className="maw-settings-row-text">
            <span className="maw-settings-label">{t('settings.section.appearance')}</span>
            <span className="maw-settings-subtext">{t('settings.appearance.themeDark')}</span>
          </div>
          <div className="maw-settings-control">
            <span className="maw-settings-badge badge-available">
              {t('settings.appearance.darkBadge')}
            </span>
          </div>
        </div>

        <div className="maw-settings-row maw-settings-row-top" style={{ marginTop: '12px' }}>
          <div className="maw-settings-row-text">
            <span className="maw-settings-label">{t('settings.terminalTheme')}</span>
            <span className="maw-settings-subtext">{t('settings.terminalTheme.hint')}</span>
          </div>
          <div className="maw-settings-control">
            <div
              className="maw-settings-choices"
              role="radiogroup"
              aria-label={t('settings.terminalTheme')}
            >
              {(['dark', 'follow'] as const).map((preference) => (
                <label key={preference} className="maw-settings-choice">
                  <input
                    type="radio"
                    name="terminal-theme"
                    checked={terminalTheme.preference === preference}
                    onChange={() => terminalTheme.setPreference(preference)}
                  />
                  <span className="maw-settings-choice-label">
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
          <div className="maw-settings-action-row">
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
