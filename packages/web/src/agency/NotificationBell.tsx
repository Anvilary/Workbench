import { t } from '../i18n/index.js';

interface Props {
  unreadCount: number;
  open: boolean;
  onToggle: () => void;
}

export function NotificationBell({ unreadCount, open, onToggle }: Props): JSX.Element {
  const badgeLabel = unreadCount > 0
    ? t('agency.notifications.unreadCount', { count: unreadCount })
    : '';

  return (
    <button
      type="button"
      className={`agency-icon-button maw-bell-button ${open ? 'active' : ''}`}
      onClick={onToggle}
      aria-label={t('agency.notifications.bell')}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={t('agency.notifications.bell')}
    >
      <span className="maw-bell-icon" aria-hidden="true">🔔</span>
      {unreadCount > 0 && (
        <span
          className="maw-unread-badge"
          aria-label={badgeLabel}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
