import type { ToastItem } from './useNotificationStore.js';
import { t } from '../i18n/index.js';
import { notificationText } from './notification-labels.js';

interface Props {
  toasts: readonly ToastItem[];
  onDismiss: (toastId: string) => void;
  onNavigate: (toast: ToastItem) => void;
}

export function NotificationToastContainer({ toasts, onDismiss, onNavigate }: Props): JSX.Element | null {
  if (toasts.length === 0) return null;

  return (
    <div
      className="maw-toast-container"
      role="region"
      aria-label={t('agency.notifications.title')}
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`maw-toast-item state-${toast.state}`}
          role="status"
          tabIndex={0}
          onClick={() => onNavigate(toast)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onNavigate(toast);
            }
          }}
        >
          <div className="maw-toast-icon" aria-hidden="true">
            {toast.state === 'finished' ? '✓' : toast.state === 'failed' ? '✕' : toast.state === 'working' ? '⚙' : '◇'}
          </div>
          <div className="maw-toast-content">
            <div className="maw-toast-title">{notificationText(toast).title}</div>
            <div className="maw-toast-body">{notificationText(toast).body}</div>
          </div>
          <button
            type="button"
            className="maw-toast-dismiss"
            aria-label={t('agency.notifications.dismissToast')}
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(toast.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
