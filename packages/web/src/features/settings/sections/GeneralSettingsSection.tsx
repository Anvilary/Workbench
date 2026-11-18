import { t } from '../../../i18n/index.js';
import { LocaleMenu } from '../../../LocaleMenu.js';
import type { TerminalThemeState } from '../../../useTerminalTheme.js';
import { vaultName } from '../../../vault-ui.js';
import { TERMINAL_THEME_NAMES } from '../settings-search.js';

export interface GeneralSettingsSectionProps {
  terminalTheme: TerminalThemeState;
  highlightedCardId: string | null;
  onOpenVault: (() => void) | null;
  onOpenRemote: (() => void) | null;
}

export function GeneralSettingsSection({
  terminalTheme,
  highlightedCardId,
  onOpenVault,
  onOpenRemote,
}: GeneralSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <div
        id="setting-card-language"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-language' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-card-header">
          <span className="maw-settings-card-title">{t('settings.language')}</span>
        </div>
        <div className="maw-settings-card-body">
          <div className="maw-settings-row">
            <div className="maw-settings-row-text">
              <span className="maw-settings-label">{t('settings.language')}</span>
              <span className="maw-settings-subtext">{t('settings.desc.general')}</span>
            </div>
            <div className="maw-settings-control">
              <LocaleMenu />
            </div>
          </div>
        </div>
      </div>

      <div
        id="setting-card-theme"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-theme' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-card-header">
          <span className="maw-settings-card-title">{t('settings.section.appearance')}</span>
        </div>
        <div className="maw-settings-card-body">
          <div className="maw-settings-row">
            <div className="maw-settings-row-text">
              <span className="maw-settings-label">{t('settings.section.appearance')}</span>
              <span className="maw-settings-subtext">{t('settings.appearance.themeDark')}</span>
            </div>
            <div className="maw-settings-control">
              <span className="maw-settings-badge badge-available">Dark</span>
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
        </div>
      </div>

      {(onOpenVault !== null || onOpenRemote !== null) && (
        <div
          id="setting-card-more"
          className={`maw-settings-card ${highlightedCardId === 'setting-card-more' ? 'maw-settings-card-highlighted' : ''}`}
        >
          <div className="maw-settings-card-header">
            <span className="maw-settings-card-title">{t('settings.section.more')}</span>
          </div>
          <div className="maw-settings-card-body">
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
          </div>
        </div>
      )}
    </div>
  );
}
