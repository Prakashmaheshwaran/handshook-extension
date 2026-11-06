import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeSettings, type Settings } from '@/core/contracts';
import { makeSettings } from '@/test/factories';
import { PacingSection } from '@/ui/screens/Settings/PacingSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function render(initial = makeSettings()) {
  let current: Settings = initial;
  function Harness() {
    const [draft, setDraft] = useState(initial);
    current = draft;
    return (
      <PacingSection draft={draft} onChange={(patch) => setDraft(mergeSettings(draft, patch))} />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => root.render(<Harness />));
  return { container, current: () => current };
}

describe('pacing settings controls', () => {
  it('shows one five-stop speed slider with the derived default rate and no raw timing', async () => {
    const { container, current } = await render();
    const sliders = container.querySelectorAll('input[type="range"]');
    expect(sliders).toHaveLength(1);
    const slider = sliders[0] as HTMLInputElement;
    expect(slider.value).toBe('4');
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('5');
    expect(slider.getAttribute('aria-valuetext')).toBe('Faster');
    expect(container.textContent).toContain(
      'About 32–40 applications per hour, including apply time and breaks.',
    );
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('fieldset')).toBeNull();
    for (const removed of [
      'Shortest delay',
      'Longest delay',
      'Delay jitter',
      'Advanced pacing',
      'Scan delay',
      'Action delay',
    ]) {
      expect(container.textContent).not.toContain(removed);
    }
    expect(current().pacing.useAdvanced).toBe(false);
  });

  it('keeps the daily and hard caps editable', async () => {
    const { container } = await render();
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(4);
    expect(container.textContent).toContain('Daily cap');
    expect(container.textContent).toContain('Hard cap');
  });

  it('keeps the non-timing reliability controls without exposing delays', async () => {
    const { container } = await render();
    expect(container.textContent).toContain('Pause after failures');
    expect(container.textContent).toContain('Tries per job');
    expect(container.textContent).not.toContain('Batch size');
    expect(container.textContent).not.toContain('Break min');
  });

  it('derives the label from saved custom timing and returns to presets with the slider', async () => {
    const { container, current } = await render(
      makeSettings({
        pacing: {
          speed: 1,
          useAdvanced: true,
          minDelayMs: 25_000,
          maxDelayMs: 25_000,
          jitterPercent: 0,
          sessionBatchSize: 1,
          sessionBreakMinMs: 0,
          sessionBreakMaxMs: 0,
        },
      }),
    );
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('Custom');
    expect(container.textContent).toContain(
      'About 90 applications per hour, including apply time and breaks.',
    );
    expect(container.textContent).not.toContain('About 6–10 applications per hour');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(current().pacing).toMatchObject({ speed: 5, useAdvanced: false });
    expect(slider.getAttribute('aria-valuetext')).toBe('Fastest');
    expect(container.textContent).toContain(
      'About 100–127 applications per hour, including apply time and breaks.',
    );
  });
});
