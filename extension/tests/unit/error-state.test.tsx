import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@/core/contracts';
import { ErrorState } from '@/ui/components/ErrorState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const error: AppError = {
  code: 'UI_CHANGED',
  message: 'Selector apply.submit did not match',
  retryable: false,
};

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (!cleanup) return;
  await cleanup();
  cleanup = null;
});

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

describe('ErrorState copy', () => {
  it('leads with plain-language copy instead of the raw error code', async () => {
    const container = await render(<ErrorState error={error} />);

    const primary = container.querySelector('p');
    expect(primary?.textContent).toContain('page changed');
    expect(primary?.textContent).not.toContain('UI_CHANGED');
  });

  it('keeps the raw code behind an Advanced disclosure', async () => {
    const container = await render(<ErrorState error={error} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('Advanced');
    expect(details?.textContent).toContain('UI_CHANGED');
    expect(details?.textContent).toContain('Selector apply.submit did not match');
  });
});
