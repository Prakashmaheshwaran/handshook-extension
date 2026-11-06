import { useState } from 'react';
import { Input, type InputProps } from './Input';

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Preserve separators while typing, while keeping settings as a clean list. */
export function ListInput({
  values,
  onValuesChange,
  ...props
}: Omit<InputProps, 'value' | 'onChange'> & {
  values: readonly string[];
  onValuesChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(', '));
  const value =
    JSON.stringify(parseList(text)) === JSON.stringify(values) ? text : values.join(', ');
  return (
    <Input
      {...props}
      value={value}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        onValuesChange(parseList(next));
      }}
    />
  );
}
