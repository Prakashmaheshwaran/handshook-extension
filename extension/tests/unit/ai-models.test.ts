import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatcher } from '@/ai/matcher';
import { cacheKey, createAiCache, createMemoryCacheStore } from '@/ai/cache';
import {
  mapOpenRouterModels,
  OPENROUTER_MODELS_TTL_MS,
  openRouterModelsStore,
  readOpenRouterModels,
  type OpenRouterModelsStore,
} from '@/ai/models';
import {
  createOpenRouterMatcher,
  loadOpenRouterKeyInfo,
  loadOpenRouterModels,
  OPENROUTER_MODELS_ENDPOINT,
  OPENROUTER_KEY_ENDPOINT,
} from '@/ai/providers/openrouter';
import { resetDb } from '@/core/storage/db';
import { DEFAULT_SETTINGS, mergeSettings } from '@/core/contracts';
import type { FetchLike } from '@/ai/types';
import {
  ANSWER,
  CHAT,
  INPUT,
  KEY,
  MODEL,
  MODEL_SUMMARY,
  ROUTING,
  options,
  response,
} from './helpers/openrouter';

const rawModel = {
  id: MODEL,
  name: 'Text model',
  context_length: 32768,
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
  supported_parameters: ['structured_outputs', 'response_format'],
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  top_provider: { context_length: 65536, max_completion_tokens: 8192 },
  expiration_date: '2030-01-01',
};
beforeEach(async () => {
  await resetDb();
});

function memoryCatalog() {
  let value: unknown;
  const store: OpenRouterModelsStore = {
    read: async () => value,
    write: async (next) => {
      value = next;
    },
  };
  return {
    store,
    set: (next: unknown) => {
      value = next;
    },
  };
}

describe('OpenRouter model catalog', () => {
  it('maps prices per token to per million, capabilities, context and expiration', () => {
    expect(mapOpenRouterModels({ data: [rawModel] })).toEqual([
      {
        ...MODEL_SUMMARY,
        supportsStructuredOutputs: true,
        supportsResponseFormat: true,
        expirationDate: '2030-01-01',
      },
    ]);
  });
  it('keeps text-output models and ignores malformed or image-only entries', () => {
    const models = mapOpenRouterModels({
      data: [
        rawModel,
        null,
        { id: '' },
        { ...rawModel, id: 'image/model', architecture: { output_modalities: ['image'] } },
        { ...rawModel, id: 'audio/model', architecture: { output_modalities: ['audio'] } },
      ],
    });
    expect(models.map((model) => model.id)).toEqual([MODEL]);
  });
  it('marks zero-price and :free variants and treats unknown or invalid prices as null', () => {
    const models = mapOpenRouterModels({
      data: [
        { ...rawModel, id: 'fixture/zero', pricing: { prompt: '0', completion: '0' } },
        { ...rawModel, id: 'fixture/model:free', pricing: { prompt: 'unknown', completion: '-1' } },
        {
          ...rawModel,
          id: 'fixture/unknown',
          pricing: { prompt: 'Infinity', completion: '' },
          context_length: null,
          top_provider: undefined,
        },
        { ...rawModel, id: 'fixture/context', context_length: null },
      ],
    });
    expect(models[0]).toMatchObject({
      isFree: true,
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
    });
    expect(models[1]).toMatchObject({
      isFree: true,
      promptPricePerMillion: null,
      completionPricePerMillion: null,
    });
    expect(models[2]).toMatchObject({
      isFree: false,
      contextLength: null,
      promptPricePerMillion: null,
      completionPricePerMillion: null,
    });
    expect(models[3]?.contextLength).toBe(65536);
  });
  it('fetches with optional bearer authentication and never sends a referer', async () => {
    for (const apiKey of [KEY, undefined]) {
      const fetchImpl = vi.fn<FetchLike>(async () => response({ data: [rawModel] }));
      await loadOpenRouterModels(options({ apiKey, fetchImpl }), true);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe(OPENROUTER_MODELS_ENDPOINT);
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init?.headers).toEqual({
        ...(apiKey ? { Authorization: `Bearer ${KEY}` } : {}),
        'X-OpenRouter-Title': 'Handshook',
      });
      expect(init?.body).toBeUndefined();
    }
  });
  it('treats missing, negative, variable and overflowing prices as unknown', () => {
    for (const prompt of [undefined, '', '-0.1', '-1', '1e309', '1.797693134862315e302']) {
      const [model] = mapOpenRouterModels({ data: [{ ...rawModel, pricing: { prompt } }] });
      expect(model?.promptPricePerMillion).toBeNull();
      expect(model?.isFree).toBe(false);
    }
  });
  it('rejects an oversized catalog and skips oversized model text', () => {
    expect(() => mapOpenRouterModels({ data: Array(5001).fill(rawModel) })).toThrow();
    expect(mapOpenRouterModels({ data: [{ ...rawModel, name: 'x'.repeat(513) }] })).toEqual([]);
    expect(mapOpenRouterModels({ data: [{ ...rawModel, id: 'x'.repeat(257) }] })).toEqual([]);
  });
  it('uses the 24-hour IndexedDB meta cache and refresh bypasses it', async () => {
    let clock = 1000;
    const fetchImpl = vi.fn<FetchLike>(async () => response({ data: [rawModel] }));
    const deps = options({ fetchImpl, modelsStore: openRouterModelsStore, now: () => clock });
    const first = await loadOpenRouterModels(deps);
    expect(first.fetchedAt).toBe(clock);
    expect(await readOpenRouterModels(clock)).toEqual(first);
    clock += OPENROUTER_MODELS_TTL_MS - 1;
    expect(await loadOpenRouterModels(deps)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
    clock++;
    expect((await loadOpenRouterModels(deps)).fetchedAt).toBe(clock);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await loadOpenRouterModels(deps, true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([
    { models: [], fetchedAt: 2001 },
    { models: [], fetchedAt: -1 },
    { models: [{ id: MODEL }], fetchedAt: 1000 },
    { models: [], fetchedAt: '1000' },
  ])('refetches invalid or future cache metadata', async (value) => {
    const { store, set } = memoryCatalog();
    set(value);
    const fetchImpl = vi.fn<FetchLike>(async () => response({ data: [rawModel] }));
    expect(
      (await loadOpenRouterModels(options({ fetchImpl, modelsStore: store, now: () => 2000 })))
        .models,
    ).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('returns a usable catalog if metadata cannot be saved and rejects invalid envelopes', async () => {
    const store = {
      read: async () => {
        throw new Error('offline storage');
      },
      write: async () => {
        throw new Error('quota');
      },
    };
    expect(
      (
        await loadOpenRouterModels(
          options({ modelsStore: store, fetchImpl: async () => response({ data: [rawModel] }) }),
        )
      ).models,
    ).toHaveLength(1);
    await expect(
      loadOpenRouterModels(options({ fetchImpl: async () => response({ data: 'invalid' }) })),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
  it('uses locally cached model capabilities to send structured output', async () => {
    const { store, set } = memoryCatalog();
    set({ models: [{ ...MODEL_SUMMARY, supportsStructuredOutputs: true }], fetchedAt: 1000 });
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    await createOpenRouterMatcher(
      options({ modelsStore: store, now: () => 1000, fetchImpl }),
    ).match(INPUT);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).response_format.type).toBe(
      'json_schema',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('redacts reflected credentials in catalog text', async () => {
    const result = await loadOpenRouterModels(
      options({ fetchImpl: async () => response({ data: [{ ...rawModel, name: KEY }] }) }),
    );
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.models[0]?.name).toBe('[REDACTED]');
  });
  it('redacts reflected credentials in cached catalog text too', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    // A fixed clock: reading Date.now() inside the store could land a
    // millisecond after the loader's own clock and look like a future entry.
    const result = await loadOpenRouterModels(
      options({
        apiKey: 'fixture-unusual-key',
        fetchImpl,
        now: () => 10_000,
        modelsStore: {
          read: async () => ({
            models: [{ ...MODEL_SUMMARY, name: 'fixture-unusual-key sk-or-v1-test-cache' }],
            fetchedAt: 9_000,
          }),
          write: async () => {},
        },
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/fixture-unusual-key|sk-or-/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('OpenRouter key information', () => {
  it('maps nullable credits, free quotas and a redacted label', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response({
        data: {
          label: `Test ${KEY}`,
          limit: null,
          limit_remaining: null,
          usage: 1.25,
          is_free_tier: true,
          free_model_daily_requests: { used: 5, limit: 50, remaining: 45 },
        },
      }),
    );
    expect(await loadOpenRouterKeyInfo(options({ fetchImpl }))).toEqual({
      label: 'Test [REDACTED]',
      limit: null,
      limitRemaining: null,
      usage: 1.25,
      isFreeTier: true,
      freeDailyRemaining: 45,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(OPENROUTER_KEY_ENDPOINT);
  });
  it('maps numeric limits without assuming a free-tier quota exists', async () => {
    expect(
      await loadOpenRouterKeyInfo(
        options({
          fetchImpl: async () =>
            response({
              data: {
                label: 'Test',
                limit: 10,
                limit_remaining: 8,
                usage: 2,
                is_free_tier: false,
              },
            }),
        }),
      ),
    ).toEqual({
      label: 'Test',
      limit: 10,
      limitRemaining: 8,
      usage: 2,
      isFreeTier: false,
      freeDailyRemaining: null,
    });
  });
  it('rejects invalid keys and invalid key-info bodies without leaking keys', async () => {
    await expect(
      loadOpenRouterKeyInfo(
        options({ fetchImpl: async () => response({ error: { code: 401, message: KEY } }, 401) }),
      ),
    ).rejects.toMatchObject({
      appError: { code: 'FORBIDDEN', message: expect.stringMatching(/invalid or disabled/i) },
    });
    await expect(
      loadOpenRouterKeyInfo(
        options({ fetchImpl: async () => response({ data: { usage: 'invalid' } }) }),
      ),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
});

describe('OpenRouter match cache identity', () => {
  it('writes under response.model and hits configured fallback models without a remembered preference', async () => {
    const fallback = 'fixture/fallback';
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      ai: {
        enabled: true,
        provider: 'openrouter',
        openRouter: { ...ROUTING, fallbackModels: [fallback] },
      },
    });
    const fetchImpl = vi.fn<FetchLike>(async () => response({ ...CHAT, model: fallback }));
    const cache = createAiCache({ store: createMemoryCacheStore() });
    const run = () =>
      createMatcher({
        settings,
        cache,
        openRouter: createOpenRouterMatcher(
          options({ fetchImpl, settings: settings.ai.openRouter }),
        ),
      }).match(INPUT);
    expect(await run()).toMatchObject({ value: { ...ANSWER, modelId: fallback, cached: false } });
    expect(await cache.get(await cacheKey(INPUT, 'openrouter', MODEL))).toBeUndefined();
    expect(await cache.get(await cacheKey(INPUT, 'openrouter', fallback))).toBeDefined();
    expect(await run()).toMatchObject({ value: { modelId: fallback, cached: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(settings.ai.openRouter.model).toBe(MODEL);
  });
  it('does not reuse an unconfigured fallback after model settings change', async () => {
    const cache = createAiCache({ store: createMemoryCacheStore() });
    await cache.put(await cacheKey(INPUT, 'openrouter', 'fixture/old'), {
      ...ANSWER,
      provider: 'openrouter',
      modelId: 'fixture/old',
    });
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      ai: { enabled: true, provider: 'openrouter', openRouter: ROUTING },
    });
    expect(
      await createMatcher({
        settings,
        cache,
        openRouter: createOpenRouterMatcher(options({ fetchImpl })),
      }).match(INPUT),
    ).toMatchObject({ value: { cached: false, modelId: MODEL } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
