import { t } from '../i18n/index.js';

interface Props {
  unreadCount: number;
  open: boolean;
  onToggle: () => void;
}

function BellIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11zM6.6 14a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  );
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
      <span className="maw-bell-icon" aria-hidden="true">
        <BellIcon />
      </span>
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
