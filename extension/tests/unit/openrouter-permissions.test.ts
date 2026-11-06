import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_ORIGIN, hasOpenRouterHostPermission } from '@/ai/permissions';
import {
  loadOpenRouterKeyInfo,
  loadOpenRouterModels,
  requestOpenRouter,
} from '@/ai/providers/openrouter';
import type { FetchLike } from '@/ai/types';
import { INPUT, options } from './helpers/openrouter';

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter consent at every transport boundary', () => {
  const requests = {
    chat: (deps: ReturnType<typeof options>) => requestOpenRouter(INPUT, deps),
    models: (deps: ReturnType<typeof options>) => loadOpenRouterModels(deps, true),
    key: (deps: ReturnType<typeof options>) => loadOpenRouterKeyInfo(deps),
  };
  it.each(['missing', 'denied', 'throws'] as const)(
    'sends no requests with a %s permission check',
    async (mode) => {
      const contains = vi.fn(async () => {
        if (mode === 'throws') throw new Error('Permission lookup failed');
        return false;
      });
      vi.stubGlobal('browser', mode === 'missing' ? {} : { permissions: { contains } });
      vi.stubGlobal('chrome', undefined);
      for (const request of Object.values(requests)) {
        const fetchImpl = vi.fn<FetchLike>();
        await expect(
          request(options({ fetchImpl, hasPermission: undefined })),
        ).rejects.toMatchObject({ appError: { code: 'FORBIDDEN' } });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    },
  );

  it('checks the exact optional origin using the Chrome-only fallback', async () => {
    vi.stubGlobal('browser', undefined);
    const contains = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { contains } });
    expect(await hasOpenRouterHostPermission()).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: [OPENROUTER_ORIGIN] });
  });

  it.each(Object.keys(requests) as Array<keyof typeof requests>)(
    'blocks %s if permission is revoked during shared pacing',
    async (kind) => {
      let granted = true;
      let clock = 100;
      const fetchImpl = vi.fn<FetchLike>();
      const deps = options({
        fetchImpl,
        now: () => clock,
        hasPermission: async () => granted,
        wait: async () => {
          clock = 200;
          granted = false;
        },
      });
      if (!deps.runtime) throw new Error('Missing runtime fixture');
      deps.runtime.nextAllowedAt = 200;
      await expect(requests[kind](deps)).rejects.toMatchObject({ appError: { code: 'FORBIDDEN' } });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('requires permission for a cached catalog too', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    await expect(
      loadOpenRouterModels(
        options({
          fetchImpl,
          hasPermission: async () => false,
          now: () => 10_000,
          modelsStore: {
            read: async () => ({ models: [], fetchedAt: 9_000 }),
            write: async () => {},
          },
        }),
      ),
    ).rejects.toMatchObject({ appError: { code: 'FORBIDDEN' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
