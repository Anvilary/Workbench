import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { calculateAnchoredDialogPosition } from '../lib/overlay-position.js';

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

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
  anchorRect?: AnchorRect | null;
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
  anchorRect = null,
  className = '',
  children,
  actions,
}: ModalDialogProps): JSX.Element {
  const generatedId = useId();
  const titleId = explicitTitleId ?? generatedId;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [anchoredPos, setAnchoredPos] = useState<{ left: number; top: number } | null>(() => {
    if (!anchorRect || typeof window === 'undefined') return null;
    return calculateAnchoredDialogPosition({
      triggerRect: anchorRect,
      dialogWidth: 380,
      dialogHeight: 260,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  });

  useLayoutEffect(() => {
    if (!anchorRect || typeof window === 'undefined') {
      setAnchoredPos(null);
      return;
    }
    const updatePosition = () => {
      const rect = dialogRef.current?.getBoundingClientRect();
      const pos = calculateAnchoredDialogPosition({
        triggerRect: anchorRect,
        dialogWidth: rect && rect.width > 0 ? rect.width : 380,
        dialogHeight: rect && rect.height > 0 ? rect.height : 260,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setAnchoredPos((prev) => (prev && prev.left === pos.left && prev.top === pos.top ? prev : pos));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [anchorRect]);

  useFocusTrap(dialogRef, trapFocus, { restoreFocus });
  useEscapeKey(() => {
    if (!closeDisabled) onClose();
  }, dismissOnEscape);

  const anchoredStyle: CSSProperties | undefined = anchorRect && anchoredPos
    ? { position: 'fixed', left: `${anchoredPos.left}px`, top: `${anchoredPos.top}px`, margin: 0 }
    : undefined;
  const dialogClasses = ['agency-dialog', anchorRect ? 'agency-anchored-dialog' : '', className]
    .filter(Boolean)
    .join(' ');

  const dialog = (
    <div
      className={anchorRect ? 'agency-modal-backdrop agency-modal-backdrop-anchored' : 'agency-modal-backdrop'}
      onMouseDown={(event) => {
        if (dismissOnBackdrop && !closeDisabled && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={dialogClasses}
        style={anchoredStyle}
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

  return typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog;
}
