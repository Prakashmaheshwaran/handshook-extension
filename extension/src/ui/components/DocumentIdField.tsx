import { useEffect, useState, type ReactNode } from 'react';
import { parseHandshakeDocumentId } from '@/core/documents/selection';
import { Field } from './Field';
import { Input } from './Input';

export const DOCUMENT_ID_ERROR = 'Paste a Handshake document link (…/docs/12345678) or its ID.';

export interface DocumentIdFieldProps {
  /** Visible label; defaults to the generic Handshake wording. */
  label?: string;
  /** The committed ID from settings or a per-job override. */
  value?: string;
  /**
   * Receives the parsed ID, or `''` when the field is empty or unparseable.
   * `''` (not `undefined`) is what clears a saved choice: settings patches cross
   * extension messaging, which drops `undefined` keys.
   */
  onChange: (id: string) => void;
  hint?: ReactNode;
  required?: boolean;
  /** Shown instead of the parse error while `required` and the field is empty. */
  requiredMessage?: string;
  disabled?: boolean;
  /** Reports whether the typed text cannot be parsed, so a caller can block saving. */
  onValidityChange?: (invalid: boolean) => void;
}

interface FieldState {
  /** The value this field last saw or emitted, used to detect external edits. */
  source: string;
  /** Raw text the user sees. */
  text: string;
  /** Set when the raw text was a link that parsed to a different ID. */
  converted: string | null;
}

export function DocumentIdField({
  label = 'Handshake link or ID',
  value,
  onChange,
  hint,
  required = false,
  requiredMessage = 'Add a document link or ID.',
  disabled = false,
  onValidityChange,
}: DocumentIdFieldProps) {
  const [state, setState] = useState<FieldState>(() => ({
    source: value ?? '',
    text: value ?? '',
    converted: null,
  }));

  // Settings discard (or any other external write) replaces the raw text.
  let current = state;
  if ((value ?? '') !== state.source) {
    current = { source: value ?? '', text: value ?? '', converted: null };
    setState(current);
  }

  const trimmed = current.text.trim();
  const parsed = parseHandshakeDocumentId(current.text);
  const invalid = trimmed.length > 0 && parsed === null;
  const error = invalid
    ? DOCUMENT_ID_ERROR
    : required && trimmed.length === 0
      ? requiredMessage
      : undefined;

  useEffect(() => {
    onValidityChange?.(invalid);
  }, [invalid, onValidityChange]);

  const update = (text: string): void => {
    const nextId = parseHandshakeDocumentId(text);
    const converted = nextId !== null && text.trim() !== nextId ? nextId : null;
    setState({ source: nextId ?? '', text, converted });
    onChange(nextId ?? '');
  };

  const effectiveHint = current.converted ? `Saved as document ID ${current.converted}` : hint;

  return (
    <Field label={label} hint={effectiveHint} error={error} required={required}>
      <Input
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://app.joinhandshake.com/docs/12345678"
        value={current.text}
        disabled={disabled}
        onChange={(event) => update(event.currentTarget.value)}
      />
    </Field>
  );
}
