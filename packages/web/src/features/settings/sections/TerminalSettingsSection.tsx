import type { ConsoleShellId } from '@anvilary/workbench-shared';
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
    <div className="wb-settings-groups">
      <CollapsibleSubsection
        id="setting-card-console"
        title={t('settings.section.console')}
        highlighted={highlightedCardId === 'setting-card-console'}
        forceExpanded={highlightedCardId === 'setting-card-console'}
        expandSignal={expandSignal}
      >
        {status === null ? (
          <p className="wb-settings-hint">{t('settings.oldServer')}</p>
        ) : status.consoleShells.length === 0 ? (
          <p className="wb-settings-hint">{t('console.noShell')}</p>
        ) : (
          <>
            <div
              className="wb-settings-choices"
              role="radiogroup"
              aria-label={t('settings.section.console')}
            >
              {shellChoices.map((choice) => (
                <label key={choice.id} className="wb-settings-choice">
                  <input
                    type="radio"
                    name="console-shell"
                    checked={shownShell === choice.id}
                    disabled={!serverEditable}
                    onChange={() => onSelectShell(choice.id)}
                  />
                  <span className="wb-settings-choice-label">{choice.label}</span>
                </label>
              ))}
            </div>
            <p className="wb-settings-hint">{t('settings.console.hint')}</p>
            {remoteClient && (
              <p className="wb-settings-hint wb-settings-warning">{t('settings.hostOnly')}</p>
            )}
          </>
        )}
      </CollapsibleSubsection>
    </div>
  );
}
