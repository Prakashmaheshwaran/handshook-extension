import { useId, type ReactNode } from 'react';

export interface RadioOption {
  value: string;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: ReactNode;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly RadioOption[];
  hint?: ReactNode;
  error?: string;
  /** Card presentation for consequential choices (mode, destructive toggles). */
  variant?: 'inline' | 'cards';
  className?: string;
}

export function RadioGroup({
  legend,
  name,
  value,
  onChange,
  options,
  hint,
  error,
  variant = 'inline',
  className = '',
}: RadioGroupProps) {
  const groupId = useId();
  const hintId = hint ? `${groupId}-hint` : undefined;
  const errorId = error ? `${groupId}-error` : undefined;

  return (
    <fieldset
      className={['min-w-0', className].filter(Boolean).join(' ')}
      aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1.5 text-[12.5px] font-medium text-ink">{legend}</legend>
      <div className={variant === 'cards' ? 'grid gap-2' : 'grid gap-1.5'}>
        {options.map((option) => {
          const optionId = `${groupId}-${option.value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          const selected = option.value === value;
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className={[
                'flex cursor-pointer items-start gap-2 rounded-lg border text-[12.5px] leading-snug transition-colors',
                variant === 'cards' ? 'p-2.5' : 'px-2 py-1.5',
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-surface hover:bg-surface-2',
                option.disabled ? 'cursor-not-allowed opacity-60' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
                className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="block font-medium text-ink">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-[11.5px] font-normal text-muted">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {hint ? (
        <p id={hintId} className="mt-1 text-[11.5px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-[11.5px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
