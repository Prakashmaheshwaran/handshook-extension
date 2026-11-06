import type { SelectHTMLAttributes } from 'react';
import { controlClass, useFieldControl } from './Field';
import { IconChevronDown } from './icons';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean;
  compact?: boolean;
  options?: readonly SelectOption[];
  /** Rendered above the options; use for "All" style choices. */
  placeholder?: string;
}

export function Select({
  className = '',
  invalid,
  compact = false,
  options,
  placeholder,
  id,
  children,
  style,
  ...rest
}: SelectProps) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <span className="relative block min-w-0">
      <select
        {...rest}
        id={id ?? field?.id}
        style={{ ...style, paddingRight: 30 }}
        aria-invalid={isInvalid || undefined}
        aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
        className={controlClass(
          isInvalid,
          `appearance-none ${compact ? 'h-8' : 'h-9'} ${className}`,
        )}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <IconChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
    </span>
  );
}
