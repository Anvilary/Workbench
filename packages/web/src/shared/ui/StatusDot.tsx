export type StatusDotTone =
  | 'working'
  | 'finished'
  | 'attention'
  | 'failed'
  | 'idle'
  | 'unknown'
  | 'muted';

export interface StatusDotProps {
  tone?: StatusDotTone | string;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

export function StatusDot({ tone, title, ariaLabel, className }: StatusDotProps): JSX.Element {
  const classes = ['agency-status-dot', tone, className].filter(Boolean).join(' ');
  return <span className={classes} title={title} aria-label={ariaLabel} />;
}
