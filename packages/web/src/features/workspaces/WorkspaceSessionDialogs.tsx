import { useRef } from 'react';
import type { AgencyCliProfile, SplitDirection } from '@anvilary/workbench-shared';
import type { WorkspaceTab } from './workspace-model.js';
import { t } from '../../i18n/index.js';
import { useConfirmKeyboard } from '../../shared/hooks/useConfirmKeyboard.js';
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
  /** May return a promise; a second submit is ignored until it settles. */
  onConfirmOpenFile: (filePath: string, paneId: string) => void | Promise<unknown>;
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const open = Boolean(closing || fileDialog);

  const confirm = useConfirmKeyboard({
    open,
    resetKey: closing ? `close:${closing.id}` : fileDialog ? `file:${fileDialog.paneId}` : null,
    active: !configuringProfileOpen,
    canConfirm: !busy && !inFlight && online && (closing ? true : filePathInput.trim().length > 0),
    canCancel: !inFlight,
    // The file branch keeps native form submission from its input.
    enterConfirms: Boolean(closing),
    onConfirm: () => {
      if (closing) return onConfirmClose(closing);
      if (fileDialog) return onConfirmOpenFile(filePathInput, fileDialog.paneId);
    },
    onCancel: onDismiss,
    containerRef: dialogRef,
    confirmRef,
    cancelRef,
    initialFocusRef: closing ? confirmRef : fileInputRef,
  });

  if (!closing && !fileDialog) return null;

  return (
    <div className="agency-modal-backdrop">
      <div
        ref={dialogRef}
        className="agency-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-session-dialog"
      >
        <h2 id="wb-session-dialog">
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
                <p className="wb-close-web-page-title">
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
              confirm();
            }}
          >
            <label className="agency-field">
              <span>{t('agency.tabs.filePath')}</span>
              <input
                ref={fileInputRef}
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
          <button ref={cancelRef} type="button" disabled={busy} onClick={onDismiss}>
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
              ref={confirmRef}
              type="button"
              className="agency-primary-button"
              disabled={busy || !online}
              onClick={confirm}
            >
              {closing?.kind === 'web' ? t('agency.web.closeConfirmAction') : t('agency.tabs.closeSession')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
