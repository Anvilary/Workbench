import { useEffect, useRef } from 'react';
import type { AgencyCliProfile, SplitDirection } from '@agent-workbench/shared';
import type { WorkspaceTab } from './workspace-model.js';
import { t } from '../../i18n/index.js';
import { trapTabFocus } from '../../shared/hooks/useFocusTrap.js';
import { getWorkspaceTabDisplayName } from './workspace-tab-helpers.js';

export interface WorkspaceSessionDialogsProps {
  closing: WorkspaceTab | null;
  fileDialog: { paneId: string; direction?: SplitDirection } | null;
  configuringProfileOpen: boolean;
  inFlight: boolean;
  busy: boolean;
  online: boolean;
  error: string | null;
  filePathInput: string;
  profiles: readonly AgencyCliProfile[];
  unsavedTabIds: ReadonlySet<string>;
  onChangeFilePathInput: (value: string) => void;
  onDismiss: () => void;
  onConfirmClose: (tab: WorkspaceTab) => void;
  onConfirmOpenFile: (filePath: string, paneId: string) => void;
}

export function WorkspaceSessionDialogs({
  closing,
  fileDialog,
  configuringProfileOpen,
  inFlight,
  busy,
  online,
  error,
  filePathInput,
  profiles,
  unsavedTabIds,
  onChangeFilePathInput,
  onDismiss,
  onConfirmClose,
  onConfirmOpenFile,
}: WorkspaceSessionDialogsProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if ((!closing && !fileDialog) || configuringProfileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !inFlight) {
        onDismiss();
      }
      if (event.key === 'Tab') {
        trapTabFocus(
          event,
          dialogRef.current,
          'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closing, fileDialog, configuringProfileOpen, inFlight, onDismiss]);

  if (!closing && !fileDialog) return null;

  return (
    <div className="agency-modal-backdrop">
      <div
        ref={dialogRef}
        className="agency-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maw-session-dialog"
      >
        <h2 id="maw-session-dialog">
          {closing
            ? closing.kind === 'web'
              ? t('agency.web.closeConfirmTitle')
              : t('agency.tabs.confirmClose', { name: getWorkspaceTabDisplayName(closing, profiles) })
            : t('agency.tabs.openFile')}
        </h2>

        {closing ? (
          closing.kind === 'web' ? (
            <div>
              <p>{t('agency.web.closeConfirmMessage')}</p>
              {closing.web.title ? (
                <p className="maw-close-web-page-title">
                  {closing.web.title}
                </p>
              ) : null}
            </div>
          ) : (
            <p>
              {closing.kind === 'editor' && unsavedTabIds.has(closing.id)
                ? t('agency.tabs.unsavedWarning')
                : t('agency.tabs.closeExplanation')}
            </p>
          )
        ) : (
          <form
            id="maw-open-file-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (fileDialog) onConfirmOpenFile(filePathInput, fileDialog.paneId);
            }}
          >
            <label className="agency-field">
              <span>{t('agency.tabs.filePath')}</span>
              <input
                autoFocus
                value={filePathInput}
                placeholder={t('agency.tabs.filePathPlaceholder')}
                required
                onChange={(event) => onChangeFilePathInput(event.target.value)}
              />
            </label>
          </form>
        )}

        {error && (
          <p role="alert" className="agency-error">
            {error}
          </p>
        )}
        <div className="agency-dialog-actions">
          <button type="button" autoFocus={!!closing} disabled={busy} onClick={onDismiss}>
            {t('common.cancel')}
          </button>
          {fileDialog ? (
            <button
              type="submit"
              form="maw-open-file-form"
              className="agency-primary-button"
              disabled={busy || !online || !filePathInput.trim()}
            >
              {t('agency.tabs.open')}
            </button>
          ) : (
            <button
              type="button"
              className="agency-primary-button"
              disabled={busy || !online}
              onClick={() => {
                if (closing) onConfirmClose(closing);
              }}
            >
              {closing?.kind === 'web' ? t('agency.web.closeConfirmAction') : t('agency.tabs.closeSession')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
