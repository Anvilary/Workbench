import { useEffect, useRef } from 'react';
import type { MawNotificationItem } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';
import { notificationText } from './notification-labels.js';
import { formatWhen } from '../i18n/format.js';

interface Props {
  notifications: readonly MawNotificationItem[];
  unreadCount: number;
  onClose: () => void;
  onSelect: (item: MawNotificationItem) => void;
  onMarkRead: (notificationId: string) => void;
  onMarkAllRead: () => void;
  onDone: (notificationId: string) => void;
}

export function NotificationInbox({
  notifications,
  unreadCount,
  onClose,
  onSelect,
  onMarkRead,
  onMarkAllRead,
  onDone,
}: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function getStatusLabel(state: MawNotificationItem['state']): string {
    switch (state) {
      case 'finished':
        return t('agency.notifications.statusFinished');
      case 'working':
        return t('agency.notifications.statusWorking');
      case 'failed':
        return t('agency.notifications.statusFailed');
      case 'unknown':
        return t('agency.notifications.statusUnknown');
      default:
        return t('agency.notifications.statusIdle');
    }
  }

  function formatTime(iso: string): string {
    try {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) {
        return formatWhen(ms);
      }
    } catch {}
    return '';
  }

  return (
    <div
      ref={panelRef}
      className="maw-notification-inbox"
      role="dialog"
      aria-modal="false"
      aria-label={t('agency.notifications.title')}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="maw-inbox-header">
        <div className="maw-inbox-header-title">
          <h3>{t('agency.notifications.title')}</h3>
          {unreadCount > 0 && (
            <span className="maw-inbox-count-pill">{unreadCount}</span>
          )}
        </div>
        <div className="maw-inbox-header-actions">
          {unreadCount > 0 && (
            <button
              type="button"
              className="agency-text-button"
              onClick={onMarkAllRead}
            >
              {t('agency.notifications.markAllRead')}
            </button>
          )}
          <button
            type="button"
            className="agency-icon-button"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      <div className="maw-inbox-list" role="feed">
        {notifications.length === 0 ? (
          <div className="maw-inbox-empty">
            <span className="maw-empty-icon" aria-hidden="true">📭</span>
            <p>{t('agency.notifications.empty')}</p>
          </div>
        ) : (
          notifications.map((item) => (
            <div
              key={item.id}
              className={`maw-inbox-item ${item.read ? 'read' : 'unread'} state-${item.state}`}
              role="article"
              tabIndex={0}
              onClick={() => onSelect(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(item);
                }
              }}
            >
              <div className="maw-inbox-item-indicator" aria-hidden="true">
                {!item.read && <span className="maw-unread-dot" />}
              </div>

              <div className="maw-inbox-item-body">
                <div className="maw-inbox-item-top">
                  <span className={`maw-state-badge state-${item.state}`}>
                    {getStatusLabel(item.state)}
                  </span>
                  <span className="maw-inbox-item-time">{formatTime(item.createdAt)}</span>
                </div>
                <div className="maw-inbox-item-title">{notificationText(item).title}</div>
                <div className="maw-inbox-item-desc">{notificationText(item).body}</div>
              </div>

              <div className="maw-inbox-item-actions">
                <button
                  type="button"
                  className="maw-done-button"
                  title={t('agency.notifications.done')}
                  aria-label={t('agency.notifications.done')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDone(item.id);
                  }}
                >
                  ✓
                </button>
                {!item.read && (
                  <button
                    type="button"
                    className="maw-mark-read-button"
                    title={t('agency.notifications.markRead')}
                    aria-label={t('agency.notifications.markRead')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkRead(item.id);
                    }}
                  >
                    ●
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
