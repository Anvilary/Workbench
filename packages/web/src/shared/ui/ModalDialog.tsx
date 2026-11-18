import { useId, useRef, type ReactNode } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';

export interface ModalDialogProps {
  title: ReactNode;
  titleId?: string;
  onClose: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
  trapFocus?: boolean;
  restoreFocus?: boolean;
  className?: string;
  children: ReactNode;
  actions?: ReactNode;
}

export function ModalDialog({
  title,
  titleId: explicitTitleId,
  onClose,
  closeLabel = 'Close',
  closeDisabled = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  trapFocus = true,
  restoreFocus = true,
  className = '',
  children,
  actions,
}: ModalDialogProps): JSX.Element {
  const generatedId = useId();
  const titleId = explicitTitleId ?? generatedId;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap(dialogRef, trapFocus, { restoreFocus });
  useEscapeKey(() => {
    if (!closeDisabled) onClose();
  }, dismissOnEscape);

  return (
    <div
      className="agency-modal-backdrop"
      onMouseDown={(event) => {
        if (dismissOnBackdrop && !closeDisabled && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `agency-dialog ${className}` : 'agency-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="agency-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="agency-icon-button"
            disabled={closeDisabled}
            onClick={onClose}
            aria-label={closeLabel}
          >
            ×
          </button>
        </div>
        {children}
        {actions && <div className="agency-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}
