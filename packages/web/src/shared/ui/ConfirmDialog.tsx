import type { ReactNode } from 'react';
import { ModalDialog } from './ModalDialog.js';

export interface ConfirmDialogProps {
  title: ReactNode;
  titleId?: string;
  message?: ReactNode;
  warning?: ReactNode;
  error?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  closeLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmOnly?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  titleId,
  message,
  warning,
  error,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  closeLabel,
  danger = false,
  busy = false,
  confirmOnly = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps): JSX.Element {
  return (
    <ModalDialog
      title={title}
      titleId={titleId}
      onClose={onClose}
      closeLabel={closeLabel ?? cancelLabel}
      closeDisabled={busy}
      actions={
        <>
          {!confirmOnly && (
            <button type="button" className="agency-secondary-button" disabled={busy} onClick={onClose}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={danger ? 'agency-primary-button agency-text-danger' : 'agency-primary-button'}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message && <p className="agency-muted">{message}</p>}
      {children}
      {warning && (
        <p className="agency-error" role="alert">
          {warning}
        </p>
      )}
      {error && (
        <p className="agency-error" role="alert">
          {error}
        </p>
      )}
    </ModalDialog>
  );
}
