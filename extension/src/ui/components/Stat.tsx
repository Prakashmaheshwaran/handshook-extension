import type { ReactNode } from 'react';

export interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'danger';
  className?: string;
}

const VALUE_TONE = {
  default: 'text-ink',
  accent: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
} as const;

export function Stat({ label, value, hint, tone = 'default', className = '' }: StatProps) {
  return (
    <div className={['min-w-0', className].filter(Boolean).join(' ')}>
      <p className="truncate text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted">
        {label}
      </p>
      <p
        className={[
          'hs-numeric mt-0.5 text-[17px] font-semibold leading-tight',
          VALUE_TONE[tone],
        ].join(' ')}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
