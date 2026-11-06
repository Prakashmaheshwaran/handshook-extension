import { useId, type ReactNode } from 'react';

export interface CheckboxProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Announce an error next to the control. */
  error?: string;
}

export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  id,
  className = '',
  error,
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={['min-w-0', className].filter(Boolean).join(' ')}>
      <div className="flex items-start gap-2">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
          className="mt-[3px] size-4 shrink-0 accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <label
          htmlFor={inputId}
          className="min-w-0 cursor-pointer text-[12.5px] leading-snug text-ink"
        >
          {label}
          {description ? (
            <span id={descriptionId} className="mt-0.5 block text-[11.5px] text-muted">
              {description}
            </span>
          ) : null}
        </label>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-[11.5px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
