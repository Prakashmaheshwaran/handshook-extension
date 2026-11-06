import { createContext, useContext, useId, type ReactNode } from 'react';

export interface FieldControlContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldControlContext = createContext<FieldControlContextValue | null>(null);

/** Inputs read this to inherit the id / hint / error wiring from `<Field>`. */
export function useFieldControl(): FieldControlContextValue | null {
  return useContext(FieldControlContext);
}

export interface FieldProps {
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  /** Hide the label visually but keep it for screen readers. */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  id,
  hint,
  error,
  required = false,
  hideLabel = false,
  children,
  className = '',
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={['min-w-0', className].filter(Boolean).join(' ')}>
      <label
        htmlFor={controlId}
        className={
          hideLabel
            ? 'sr-only'
            : 'mb-1 flex items-baseline gap-1 text-[12.5px] font-medium text-ink'
        }
      >
        <span>{label}</span>
        {required ? (
          <>
            <span aria-hidden="true" className="text-danger">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </label>
      <FieldControlContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error) }}>
        {children}
      </FieldControlContext.Provider>
      {hint ? (
        <p id={hintId} className="mt-1 text-[11.5px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-[11.5px] font-medium leading-snug text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const CONTROL_CLASS =
  'block w-full min-w-0 rounded-lg border bg-surface px-2.5 text-[13px] text-ink shadow-none transition-colors placeholder:text-muted/80 disabled:cursor-not-allowed disabled:opacity-60';

export function controlClass(invalid: boolean, extra = ''): string {
  return [CONTROL_CLASS, invalid ? 'border-danger' : 'border-line hover:border-line-strong', extra]
    .filter(Boolean)
    .join(' ');
}
