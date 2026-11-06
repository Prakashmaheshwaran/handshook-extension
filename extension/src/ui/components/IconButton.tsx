import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'aria-label'
> {
  /** Required: icon-only controls need an accessible name. */
  label: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'danger';
  loading?: boolean;
  children: ReactNode;
  className?: string;
}

export function IconButton({
  label,
  size = 'md',
  tone = 'default',
  loading = false,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const toneClass =
    tone === 'danger'
      ? 'text-danger hover:bg-danger-soft'
      : 'text-muted hover:bg-surface-2 hover:text-ink';
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        box,
        toneClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? <Spinner size={14} /> : children}
    </button>
  );
}
