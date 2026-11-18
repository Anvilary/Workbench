export interface BannerNoticeProps {
  variant: 'error' | 'notice';
  message: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function BannerNotice({
  variant,
  message,
  onDismiss,
  dismissLabel = 'Dismiss',
}: BannerNoticeProps): JSX.Element {
  const isError = variant === 'error';
  return (
    <div
      className={isError ? 'agency-error-bar' : 'agency-notice-bar'}
      role={isError ? 'alert' : 'status'}
    >
      <span>{message}</span>
      {onDismiss && (
        <button type="button" aria-label={dismissLabel} onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
