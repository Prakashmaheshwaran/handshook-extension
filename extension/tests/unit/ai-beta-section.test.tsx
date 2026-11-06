import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsPatch } from '@/core/contracts';
import { makeSettings } from '@/test/factories';
import { BetaSection } from '@/ui/screens/Settings/BetaSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let changes: SettingsPatch[];

beforeEach(() => {
  changes = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <BetaSection
        draft={makeSettings({ ai: { enabled: true, provider: 'auto' } })}
        onChange={(patch) => changes.push(patch)}
      />,
    ),
  );
}

describe('Beta features', () => {
  it('shows only the external job links toggle and no model download control', async () => {
    await render();
    const switches = Array.from(container.querySelectorAll('[role="switch"]'));
    expect(switches).toHaveLength(1);
    expect(container.textContent).toContain('Collect external job links (beta)');
    expect(container.textContent).toMatch(/off by default/i);
    expect(container.textContent).not.toMatch(/on-device|download/i);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('persists the external job links choice through onChange', async () => {
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing switch');
    await act(async () => toggle.click());
    expect(changes).toEqual([{ search: { collectExternalJobs: true } }]);
  });
});
