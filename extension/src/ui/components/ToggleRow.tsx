import { useId, type ReactNode } from 'react';

export interface ToggleRowProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Optional warning style for risky settings. */
  tone?: 'default' | 'warn';
  id?: string;
  className?: string;
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  tone = 'default',
  id,
  className = '',
}: ToggleRowProps) {
  const generatedId = useId();
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const labelId = `${id ?? generatedId}-label`;

  return (
    <div
      className={['flex items-start justify-between gap-3 py-2', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="min-w-0">
        <span id={labelId} className="block text-[12.5px] font-medium leading-snug text-ink">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="mt-0.5 block text-[11.5px] leading-snug text-muted">
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          'relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-55',
          checked
            ? tone === 'warn'
              ? 'border-warn bg-warn'
              : 'border-accent bg-accent'
            : 'border-line-strong bg-surface-2',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className={[
            'pointer-events-none block size-[16px] rounded-full bg-surface shadow-sm transition-transform',
            checked ? 'translate-x-[19px]' : 'translate-x-[2px]',
          ].join(' ')}
        />
      </button>
    </div>
  );
}
