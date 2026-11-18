// Monochrome neutral SVG icon system for Settings navigation and headers (16x16 viewBox, strokeWidth 1.3).

export function GearIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.24 1.24M11.36 11.36l1.24 1.24M3.4 12.6l1.24-1.24M11.36 4.64l1.24-1.24" />
    </svg>
  );
}

export function TerminalIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
      <path d="M4.5 5.5l3 2.5-3 2.5M9.5 10.5h2.5" />
    </svg>
  );
}

export function BrowserIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="1.75" y1="8" x2="14.25" y2="8" />
      <path d="M8 1.75c-2.4 2-3.8 4.25-3.8 6.25s1.4 4.25 3.8 6.25c2.4-2 3.8-4.25 3.8-6.25s-1.4-4.25-3.8-6.25z" />
    </svg>
  );
}

export function RobotIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="4.5" width="11" height="9" rx="1.5" />
      <path d="M5.5 8h.01M10.5 8h.01M8 1.5v3M4 1.5h8" />
      <path d="M6 11h4" />
    </svg>
  );
}

export function UsageIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="2" y1="13.5" x2="14" y2="13.5" />
      <rect x="3" y="8.5" width="2.5" height="5" rx="0.5" />
      <rect x="6.75" y="5.5" width="2.5" height="8" rx="0.5" />
      <rect x="10.5" y="2.5" width="2.5" height="11" rx="0.5" />
    </svg>
  );
}

export function InfoIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="8" y1="7" x2="8" y2="11.5" />
      <circle cx="8" cy="4.75" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function PanelsIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
      <line x1="5.5" y1="2" x2="5.5" y2="14" />
      <line x1="1.5" y1="6" x2="5.5" y2="6" />
    </svg>
  );
}

export function SearchIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.5" cy="6.5" r="4.5" />
      <line x1="10" y1="10" x2="14" y2="14" />
    </svg>
  );
}
