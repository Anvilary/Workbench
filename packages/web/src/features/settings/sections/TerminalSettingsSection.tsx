import type { ConsoleShellId } from '@agent-workbench/shared';
import { t } from '../../../i18n/index.js';
import type { AppSettingsApi } from '../useAppSettings.js';
import { CollapsibleSubsection } from '../CollapsibleSubsection.js';

export interface TerminalSettingsSectionProps {
  status: AppSettingsApi['status'];
  shellChoices: readonly { id: ConsoleShellId; label: string }[];
  shownShell: ConsoleShellId;
  serverEditable: boolean;
  remoteClient: boolean;
  highlightedCardId: string | null;
  expandSignal?: number;
  onSelectShell: (shellId: ConsoleShellId) => void;
}

export function TerminalSettingsSection({
  status,
  shellChoices,
  shownShell,
  serverEditable,
  remoteClient,
  highlightedCardId,
  expandSignal,
  onSelectShell,
}: TerminalSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <CollapsibleSubsection
        id="setting-card-console"
        title={t('settings.section.console')}
        highlighted={highlightedCardId === 'setting-card-console'}
        forceExpanded={highlightedCardId === 'setting-card-console'}
        expandSignal={expandSignal}
      >
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
      </CollapsibleSubsection>
    </div>
  );
}
