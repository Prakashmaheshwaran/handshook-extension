import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { DataSection } from '@/ui/screens/Settings/DataSection';
import { resetMockStore } from '@/ui/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  resetMockStore();
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:test'),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

async function renderDataSection(notify: AppContextValue['notify']): Promise<HTMLDivElement> {
  const context: AppContextValue = {
    engine: null,
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: async () => null,
    start: async () => null,
    pause: async () => null,
    resume: async () => null,
    stop: async () => null,
    settings: null,
    settingsLoading: false,
    settingsError: null,
    refreshSettings: async () => null,
    saveSettings: async () => null,
    applySettings: () => undefined,
    view: 'settings',
    navigate: () => undefined,
    notify,
    bridgeMode: 'mock',
    version: 'test',
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppContext.Provider value={context}>
        <DataSection />
      </AppContext.Provider>,
    );
  });
  cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

describe('DataSection — P1-14 exports a full backup', () => {
  it('labels the action as a backup and points at it before reset', async () => {
    const container = await renderDataSection(() => undefined);

    expect(container.textContent).toContain('Export private backup');
    expect(container.textContent).toContain('Do not attach to bug reports.');
    expect(container.textContent).toContain('Download a backup before you reset');
    expect(container.textContent).not.toContain('queue summary');
  });

  it('downloads a migration backup JSON, not a diagnostics bundle', async () => {
    const notify = vi.fn();
    const container = await renderDataSection(notify);
    const button = Array.from(container.querySelectorAll('button')).find((entry) =>
      entry.textContent?.includes('Export private backup'),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith('success', 'Backup downloaded.');
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
