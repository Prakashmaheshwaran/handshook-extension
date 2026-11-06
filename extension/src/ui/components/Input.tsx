import type { InputHTMLAttributes } from 'react';
import { controlClass, useFieldControl } from './Field';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  /** Visually compact control for dense rows. */
  compact?: boolean;
}

export function Input({ className = '', invalid, compact = false, id, ...rest }: InputProps) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      {...rest}
      id={id ?? field?.id}
      aria-invalid={isInvalid || undefined}
      aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
      className={controlClass(isInvalid, compact ? `h-8 ${className}` : `h-9 ${className}`)}
    />
  );
}
