import type { TextareaHTMLAttributes } from 'react';
import { controlClass, useFieldControl } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ className = '', invalid, id, rows = 3, ...rest }: TextareaProps) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      {...rest}
      id={id ?? field?.id}
      rows={rows}
      aria-invalid={isInvalid || undefined}
      aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
      className={controlClass(isInvalid, `min-h-[70px] resize-y py-1.5 leading-snug ${className}`)}
    />
  );
}
