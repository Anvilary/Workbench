interface Props {
  size?: number;
  className?: string;
  glow?: boolean;
}

/**
 * Anvilary forge mark icon.
 * Decorative stroke icon representing the forge anvil with subtle amber accent.
 */
export function AnvilIcon({ size = 18, className = '', glow = false }: Props): JSX.Element {
  return (
    <span
      className={`anvilary-icon-wrap ${glow ? 'anvilary-glow' : ''} ${className}`}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <path d="M3 9h18l-2 4h-3l-2 5H8l-2-5H5L3 9z" />
        <path d="M9 9V6h6v3" />
      </svg>
    </span>
  );
}
