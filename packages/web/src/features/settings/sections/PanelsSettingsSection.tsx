import { t } from '../../../i18n/index.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from '../../../shared/lib/panel-visibility.js';
import { CollapsibleSubsection } from '../CollapsibleSubsection.js';
import { PANEL_NAMES } from '../settings-search.js';

export interface PanelsSettingsSectionProps {
  panels: PanelVisibility;
  consoleCount: number;
  confirmingConsole: boolean;
  highlightedCardId: string | null;
  expandSignal?: number;
  onTogglePanel: (panel: HideablePanel, visible: boolean) => void;
  onConfirmHideConsole: () => void;
  onCancelHideConsole: () => void;
}

export function PanelsSettingsSection({
  panels,
  consoleCount,
  confirmingConsole,
  highlightedCardId,
  expandSignal,
  onTogglePanel,
  onConfirmHideConsole,
  onCancelHideConsole,
}: PanelsSettingsSectionProps): JSX.Element {
  return (
    <div className="wb-settings-groups">
      <CollapsibleSubsection
        id="setting-card-panels"
        title={t('settings.section.panels')}
        highlighted={highlightedCardId === 'setting-card-panels'}
        forceExpanded={highlightedCardId === 'setting-card-panels'}
        expandSignal={expandSignal}
      >
        <div className="wb-settings-panels-grid">
          {HIDEABLE_PANELS.map((panel) => (
            <label key={panel} className="wb-settings-choice">
              <input
                type="checkbox"
                checked={panels.isVisible(panel)}
                onChange={(event) => onTogglePanel(panel, event.target.checked)}
              />
              <span className="wb-settings-choice-label">{t(PANEL_NAMES[panel])}</span>
            </label>
          ))}
        </div>
        {confirmingConsole && (
          <div className="wb-settings-confirm" role="alert">
            <span>{t('settings.panels.consoleConfirm', { count: consoleCount })}</span>
            <div className="wb-settings-confirm-actions">
              <button
                type="button"
                className="link-button"
                onClick={onConfirmHideConsole}
              >
                {t('settings.panels.consoleConfirmYes')}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={onCancelHideConsole}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </CollapsibleSubsection>
    </div>
  );
}
