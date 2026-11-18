import type { ConsoleShellId } from '@agent-workbench/shared';
import { t } from '../../../i18n/index.js';
import type { AppSettingsApi } from '../../../useAppSettings.js';

export interface TerminalSettingsSectionProps {
  status: AppSettingsApi['status'];
  shellChoices: readonly { id: ConsoleShellId; label: string }[];
  shownShell: ConsoleShellId;
  serverEditable: boolean;
  remoteClient: boolean;
  highlightedCardId: string | null;
  onSelectShell: (shellId: ConsoleShellId) => void;
}

export function TerminalSettingsSection({
  status,
  shellChoices,
  shownShell,
  serverEditable,
  remoteClient,
  highlightedCardId,
  onSelectShell,
}: TerminalSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <div
        id="setting-card-console"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-console' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-card-header">
          <span className="maw-settings-card-title">{t('settings.section.console')}</span>
        </div>
        <div className="maw-settings-card-body">
          {status === null ? (
            <p className="maw-settings-hint">{t('settings.oldServer')}</p>
          ) : status.consoleShells.length === 0 ? (
            <p className="maw-settings-hint">{t('console.noShell')}</p>
          ) : (
            <>
              <div
                className="maw-settings-choices"
                role="radiogroup"
                aria-label={t('settings.section.console')}
              >
                {shellChoices.map((choice) => (
                  <label key={choice.id} className="maw-settings-choice">
                    <input
                      type="radio"
                      name="console-shell"
                      checked={shownShell === choice.id}
                      disabled={!serverEditable}
                      onChange={() => onSelectShell(choice.id)}
                    />
                    <span className="maw-settings-choice-label">{choice.label}</span>
                  </label>
                ))}
              </div>
              <p className="maw-settings-hint">{t('settings.console.hint')}</p>
              {remoteClient && (
                <p className="maw-settings-hint maw-settings-warning">{t('settings.hostOnly')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
