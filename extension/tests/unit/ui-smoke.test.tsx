import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/ui/App';
import { resetMockStore, sendRequest } from '@/ui/bridge';

// The panel is plain React + DOM, so a tiny act()-based smoke test is enough
// here. Full flows live in the Playwright suite.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderApp(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe('side panel smoke', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMockStore();
  });

  it('shows first-run onboarding before any run', async () => {
    const { container, unmount } = await renderApp();

    expect(container.textContent).toContain('Handshook setup');
    expect(container.textContent).toContain('Step 1 of 6');
    expect(container.textContent).toContain('No account, no password, no telemetry.');
    expect(container.textContent).not.toContain('Applications today');

    unmount();
  });

  it('renders the dashboard with mock queue state after setup', async () => {
    const completed = await sendRequest({ type: 'ui.onboarding.update', patch: { step: 'done' } });
    expect(completed.ok).toBe(true);

    const { container, unmount } = await renderApp();

    expect(container.textContent).toContain('Applications today');
    expect(container.textContent).toContain('Start applying');
    expect(container.textContent).toContain('Autopilot');
    expect(container.textContent).toContain('In queue');
    expect(container.textContent).not.toContain('Handshook setup');

    unmount();
  });
});
