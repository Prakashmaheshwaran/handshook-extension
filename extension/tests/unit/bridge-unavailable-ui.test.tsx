import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/bridge')>();
  return {
    ...actual,
    getBridgeMode: () => Promise.resolve('unavailable' as const),
  };
});

import { App } from '@/ui/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('packaged build without a background', () => {
  it('blocks with a reload prompt instead of showing mock data or Start', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    try {
      expect(container.textContent).toContain('Background not responding');
      expect(container.textContent).toContain('Reload extension');
      expect(container.textContent).not.toContain('Start review run');
      expect(container.textContent).not.toContain('Demo');
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      root.unmount();
      container.remove();
    }
  });
});
