export interface ProgressProps {
  value: number;
  max?: number;
  label: string;
  /** Hide the accessible name visually; still announced. */
  showLabel?: boolean;
  tone?: 'accent' | 'warn' | 'danger';
  className?: string;
}

const TONE_CLASS = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
} as const;

export function Progress({
  value,
  max = 100,
  label,
  showLabel = false,
  tone = 'accent',
  className = '',
}: ProgressProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(safeMax, Math.max(0, value));
  const percent = Math.round((clamped / safeMax) * 100);

  return (
    <div className={['min-w-0', className].filter(Boolean).join(' ')}>
      {showLabel ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="truncate text-muted">{label}</span>
          <span className="hs-numeric shrink-0 text-muted">{percent}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={`${percent}%`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line"
      >
        <div
          className={['h-full rounded-full transition-[width] duration-300', TONE_CLASS[tone]].join(
            ' ',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
