import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  /** Announced while `loading` is true. */
  loadingLabel?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  className?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-transparent hover:bg-accent/90 active:bg-accent/80',
  secondary: 'bg-surface text-ink border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-surface-2',
  danger: 'bg-danger text-bg border-transparent hover:bg-danger/90',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-[12.5px]',
  md: 'h-9 gap-2 rounded-lg px-3.5 text-[13px]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  block = false,
  loadingLabel = 'Working',
  iconLeft,
  iconRight,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-live={loading ? 'polite' : undefined}
      className={[
        'inline-flex select-none items-center justify-center border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        block ? 'w-full' : 'w-auto',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? <Spinner size={size === 'sm' ? 13 : 15} /> : iconLeft}
      <span className={block ? 'truncate' : undefined}>{children}</span>
      {loading ? <span className="sr-only">{loadingLabel}</span> : iconRight}
    </button>
  );
}
