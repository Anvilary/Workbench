import { t } from '../../../i18n/index.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from '../../../panel-visibility.js';
import { PANEL_NAMES } from '../settings-search.js';

export interface PanelsSettingsSectionProps {
  panels: PanelVisibility;
  consoleCount: number;
  confirmingConsole: boolean;
  highlightedCardId: string | null;
  onTogglePanel: (panel: HideablePanel, visible: boolean) => void;
  onConfirmHideConsole: () => void;
  onCancelHideConsole: () => void;
}

export function PanelsSettingsSection({
  panels,
  consoleCount,
  confirmingConsole,
  highlightedCardId,
  onTogglePanel,
  onConfirmHideConsole,
  onCancelHideConsole,
}: PanelsSettingsSectionProps): JSX.Element {
  return (
    <div className="maw-settings-groups">
      <div
        id="setting-card-panels"
        className={`maw-settings-card ${highlightedCardId === 'setting-card-panels' ? 'maw-settings-card-highlighted' : ''}`}
      >
        <div className="maw-settings-card-header">
          <span className="maw-settings-card-title">{t('settings.section.panels')}</span>
        </div>
        <div className="maw-settings-card-body">
          <div className="maw-settings-panels-grid">
            {HIDEABLE_PANELS.map((panel) => (
              <label key={panel} className="maw-settings-choice">
                <input
                  type="checkbox"
                  checked={panels.isVisible(panel)}
                  onChange={(event) => onTogglePanel(panel, event.target.checked)}
                />
                <span className="maw-settings-choice-label">{t(PANEL_NAMES[panel])}</span>
              </label>
            ))}
          </div>
          {confirmingConsole && (
            <div className="maw-settings-confirm" role="alert">
              <span>{t('settings.panels.consoleConfirm', { count: consoleCount })}</span>
              <div className="maw-settings-confirm-actions">
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
        </div>
      </div>
    </div>
  );
}
