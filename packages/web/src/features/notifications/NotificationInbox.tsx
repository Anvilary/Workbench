import { useEffect, useRef } from 'react';
import type { MawNotificationItem } from '@anvilary/workbench-shared';
import { t } from '../../i18n/index.js';
import { notificationText } from './notification-labels.js';
import { formatWhen } from '../../i18n/format.js';

export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported';

interface Props {
  notifications: readonly MawNotificationItem[];
  unreadCount: number;
  notificationsEnabled: boolean;
  desktopPermission: DesktopPermission;
  onToggleNotifications: () => void;
  onRequestDesktopPermission: () => void;
  onClose: () => void;
  onSelect: (item: MawNotificationItem) => void;
  onMarkRead: (notificationId: string) => void;
  onMarkAllRead: () => void;
  onDone: (notificationId: string) => void;
}

export function NotificationInbox({
  notifications,
  unreadCount,
  notificationsEnabled,
  desktopPermission,
  onToggleNotifications,
  onRequestDesktopPermission,
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
    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose]);

  function getStatusLabel(state: MawNotificationItem['state']): string {
    switch (state) {
      case 'finished':
        return t('agency.notifications.statusFinished');
      case 'needs-input':
        return t('agency.ui.needsInput');
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
      className="wb-notification-inbox"
      role="dialog"
      aria-modal="false"
      aria-label={t('agency.notifications.title')}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="wb-inbox-header">
        <div className="wb-inbox-header-title">
          <h3>{t('agency.notifications.title')}</h3>
          {unreadCount > 0 && (
            <span className="wb-inbox-count-pill">{unreadCount}</span>
          )}
        </div>
        <div className="wb-inbox-header-actions">
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

      <div className="wb-inbox-list" role="feed">
        {notifications.length === 0 ? (
          <div className="wb-inbox-empty">
            <span className="wb-empty-icon" aria-hidden="true">📭</span>
            <p>{t('agency.notifications.empty')}</p>
          </div>
        ) : (
          notifications.map((item) => (
            <div
              key={item.id}
              className={`wb-inbox-item ${item.read ? 'read' : 'unread'} state-${item.state}`}
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
              <div className="wb-inbox-item-indicator" aria-hidden="true">
                {!item.read && <span className="wb-unread-dot" />}
              </div>

              <div className="wb-inbox-item-body">
                <div className="wb-inbox-item-top">
                  <span className={`wb-state-badge state-${item.state}`}>
                    {getStatusLabel(item.state)}
                  </span>
                  <span className="wb-inbox-item-time">{formatTime(item.createdAt)}</span>
                </div>
                <div className="wb-inbox-item-title">{notificationText(item).title}</div>
                <div className="wb-inbox-item-desc">{notificationText(item).body}</div>
              </div>

              <div className="wb-inbox-item-actions">
                <button
                  type="button"
                  className="wb-done-button"
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
                    className="wb-mark-read-button"
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

      <div className="wb-inbox-footer">
        <div className="wb-inbox-footer-desktop">
          {desktopPermission === 'default' ? (
            <button
              type="button"
              className="workbench-desktop-perm-button"
              onClick={onRequestDesktopPermission}
              disabled={!notificationsEnabled}
            >
              {t('agency.notifications.enableDesktop')}
            </button>
          ) : (
            <span className={`workbench-desktop-perm-status ${desktopPermission}`}>
              {desktopPermission === 'granted'
                ? t('agency.notifications.desktopAllowed')
                : desktopPermission === 'denied'
                ? t('agency.notifications.desktopBlocked')
                : t('agency.notifications.desktopUnavailable')}
            </span>
          )}
        </div>
        <button
          type="button"
          className="wb-notification-toggle-button"
          onClick={onToggleNotifications}
        >
          {notificationsEnabled
            ? t('agency.ui.disableNotifications')
            : t('agency.ui.enableNotifications')}
        </button>
      </div>
    </div>
  );
}
