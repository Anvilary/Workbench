export function GlobeIcon({ className = '', size = 14 }: { className?: string; size?: number }): JSX.Element {
  return (
    <svg
      className={`wb-globe-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" />
      <path d="M8 1.5c-2.5 2-4 4.5-4 6.5s1.5 4.5 4 6.5c2.5-2 4-4.5 4-6.5s-1.5-4.5-4-6.5z" />
    </svg>
  );
}
