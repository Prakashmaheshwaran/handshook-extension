import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectorHealth } from '@/core/contracts';
import { handleContentEvent, handleUi } from '@/background/router';
import { listSelectorHealth } from '@/core/diagnostics/selectorHealth';
import { buildDiagnosticsBundle } from '@/core/diagnostics/export';
import { resetDb } from '@/core/storage/db';
import { createFakeBrowser } from './helpers/fakeBrowser';

const health: SelectorHealth[] = [
  {
    at: 1_000,
    page: 'search',
    selector: 'discovery.jobCard',
    strategy: 'role=listitem',
    ok: true,
  },
  {
    at: 2_000,
    page: 'job',
    selector: 'job.applyButton',
    strategy: 'none',
    ok: false,
  },
];

beforeEach(async () => {
  const { fake } = createFakeBrowser();
  vi.stubGlobal('browser', fake);
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('content.event.selectorHealth — P1-13 is persisted and exposed', () => {
  it('accepts a whole snapshot and returns it from diagnostics and export', async () => {
    await handleContentEvent({
      type: 'content.event.selectorHealth',
      health: health.map((entry) => ({ ...entry, detail: 'Untrusted page text' })),
    });

    expect(await listSelectorHealth()).toEqual(health);

    const diagnostics = await handleUi({ type: 'ui.diagnostics.get', requestId: 'diag-1' });
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) {
      const payload = diagnostics.data as {
        selectors: SelectorHealth[];
        storage: { ok: boolean };
      };
      expect(payload.selectors).toEqual(health);
      expect(payload.storage.ok).toBe(true);
    }

    const bundle = await buildDiagnosticsBundle('test');
    expect(bundle.selectorHealth).toEqual([
      {
        page: 'search',
        selector: 'discovery.jobCard',
        strategy: 'role=listitem',
        successes: 1,
        failures: 0,
        lastAt: 1_000,
      },
      {
        page: 'job',
        selector: 'job.applyButton',
        strategy: 'none',
        successes: 0,
        failures: 1,
        lastAt: 2_000,
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain('Untrusted page text');

    const exported = await handleUi({ type: 'ui.diagnostics.export', requestId: 'diag-2' });
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect((exported.data as { json: string }).json).toContain('job.applyButton');
    }
  });

  it('accepts a single entry and drops malformed entries', async () => {
    await handleContentEvent({ type: 'content.event.selectorHealth', health: health[0]! });
    await handleContentEvent({
      type: 'content.event.selectorHealth',
      health: { selector: '', bogus: true } as unknown as SelectorHealth,
    });

    expect(await listSelectorHealth()).toEqual([health[0]]);
  });

  it('clears selector health with the rest of diagnostics', async () => {
    await handleContentEvent({ type: 'content.event.selectorHealth', health });

    await handleUi({ type: 'ui.diagnostics.clear', requestId: 'diag-3' });

    expect(await listSelectorHealth()).toEqual([]);
  });
});
