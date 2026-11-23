import type { AgencyCliProfile } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';

export interface EmptyPaneChooserProps {
  paneId: string;
  online: boolean;
  busy: boolean;
  profiles?: readonly AgencyCliProfile[];
  canClose: boolean;
  onAddTerminal: () => void;
  onAddBrowser: () => void;
  onOpenFile: () => void;
  onClosePane: () => void;
  onMoveTabToPane?: (tabId: string, paneId: string) => void;
}

export function EmptyPaneChooser({
  paneId,
  online,
  busy,
  canClose,
  onAddTerminal,
  onAddBrowser,
  onOpenFile: _onOpenFile,
  onClosePane,
  onMoveTabToPane: _onMoveTabToPane,
}: EmptyPaneChooserProps): JSX.Element {
  const disabled = !online || busy;

  return (
    <div
      className="maw-empty-pane-chooser"
      data-pane-id={paneId}
    >
      <div className="maw-empty-pane-card">
        <div className="maw-empty-pane-header">
          <h3 className="maw-empty-pane-title">
            {t('agency.tabs.emptyTitle')}
          </h3>
          <p className="maw-empty-pane-subtitle">
            {t('agency.tabs.emptySubtitle')}
          </p>
        </div>

        <div className="maw-empty-pane-actions" role="group" aria-label={t('agency.tabs.add')}>
          <button
            type="button"
            className="maw-empty-pane-action"
            disabled={disabled}
            onClick={onAddTerminal}
            aria-label={t('agency.tabs.newTerminal')}
          >
            <span className="maw-empty-pane-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
                <path d="M4.5 5.5l3 2.5-3 2.5M9.5 10.5h2.5" />
              </svg>
            </span>
            <span className="maw-empty-pane-label">{t('agency.tabs.newTerminal')}</span>
          </button>

          <button
            type="button"
            className="maw-empty-pane-action"
            disabled={disabled}
            onClick={onAddBrowser}
            aria-label={t('agency.web.newTab')}
          >
            <span className="maw-empty-pane-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
                <path d="M1.5 5.5h13" />
                <circle cx="4" cy="3.75" r="0.75" fill="currentColor" />
                <circle cx="6.5" cy="3.75" r="0.75" fill="currentColor" />
              </svg>
            </span>
            <span className="maw-empty-pane-label">{t('agency.web.newTab')}</span>
          </button>

          <button
            type="button"
            className="maw-empty-pane-action maw-empty-pane-action-disabled"
            disabled={true}
            title={t('agency.tabs.comingSoon')}
            aria-label={`${t('agency.tabs.openFile')} (${t('agency.tabs.comingSoon')})`}
          >
            <span className="maw-empty-pane-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6L9 1.5z" />
                <path d="M9 1.5V6h4.5" />
              </svg>
            </span>
            <span className="maw-empty-pane-label">
              {t('agency.tabs.openFile')}
              <span className="maw-empty-pane-badge">{t('agency.tabs.comingSoon')}</span>
            </span>
          </button>
        </div>

        {canClose && (
          <button
            type="button"
            className="maw-empty-pane-close"
            onClick={onClosePane}
          >
            {t('agency.splits.closePane')}
          </button>
        )}
      </div>
    </div>
  );
}
