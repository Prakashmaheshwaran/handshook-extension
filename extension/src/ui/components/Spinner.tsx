export interface SpinnerProps {
  size?: number;
  /** Accessible name. Omit for a decorative spinner inside a labelled control. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className ? `animate-spin ${className}` : 'animate-spin'}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    >
      {label ? <title>{label}</title> : null}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
