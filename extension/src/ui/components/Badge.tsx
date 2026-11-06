import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  /** Renders a leading dot. */
  dot?: boolean;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent/30',
  success: 'bg-success-soft text-success border-success/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  info: 'bg-info-soft text-info border-info/30',
};

export function Badge({ children, tone = 'neutral', className = '', dot = false }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-[1.5]',
        TONE_CLASS[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
