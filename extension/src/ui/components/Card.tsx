import type { ReactNode } from 'react';

export type CardTone = 'default' | 'muted' | 'accent' | 'warn' | 'danger' | 'info';

export interface CardProps {
  children: ReactNode;
  tone?: CardTone;
  padded?: boolean;
  className?: string;
  id?: string;
  'aria-labelledby'?: string;
}

const TONE_CLASS: Record<CardTone, string> = {
  default: 'bg-surface border-line',
  muted: 'bg-surface-2 border-line',
  accent: 'bg-accent-soft border-accent/35',
  warn: 'bg-warn-soft border-warn/35',
  danger: 'bg-danger-soft border-danger/35',
  info: 'bg-info-soft border-info/35',
};

export function Card({
  children,
  tone = 'default',
  padded = true,
  className = '',
  id,
  'aria-labelledby': labelledBy,
}: CardProps) {
  return (
    <div
      id={id}
      aria-labelledby={labelledBy}
      className={[
        'rounded-panel border shadow-[var(--shadow)]',
        TONE_CLASS[tone],
        padded ? 'p-3.5' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
