import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type AiAvailability,
  type AiProvider,
  type MatchInput,
  type MatchResult,
  type ResumeMatcher,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { createMatcher } from '@/ai/matcher';
import {
  cacheKey,
  clearAiCache,
  createAiCache,
  createMemoryCacheStore,
  pruneAiCache,
} from '@/ai/cache';
import { providerOrder } from '@/ai/providers/availability';
import { providerError } from '@/ai/types';
import { ROUTING } from './helpers/openrouter';

const RESUMES = [
  { id: '101', title: 'FullStack Developer', description: 'React, TypeScript, Node.js' },
  { id: '202', title: 'AI/ML Engineer', description: 'PyTorch, NLP, data science' },
  { id: '303', title: 'Automation Engineer', description: 'RPA, UiPath, low-code' },
];

function makeInput(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    jobTitle: 'Full Stack Engineer',
    jobDescription: 'Build React and TypeScript applications with Node.js services.',
    resumes: RESUMES,
    ...overrides,
  };
}

function makeSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(mergeSettings(DEFAULT_SETTINGS, { ai: { openRouter: ROUTING } }), patch);
}

const AI_ON: SettingsPatch = {
  ai: { enabled: true, provider: 'auto', minConfidence: 0.55 },
};

/** Explicit-provider settings that keep the rest of the AI defaults. */
function withProvider(provider: Settings['ai']['provider']): SettingsPatch {
  return { ai: { enabled: true, provider, minConfidence: 0.55 } };
}

function matchResult(
  resumeId: string,
  confidence = 0.9,
  provider: AiProvider = 'openrouter',
): MatchResult {
  return { resumeId, confidence, reason: 'Fixture match', provider, cached: false };
}

function fakeProvider(
  id: AiProvider,
  options: {
    result?: MatchResult;
    error?: unknown;
    availability?: AiAvailability;
  } = {},
): ResumeMatcher & { match: ReturnType<typeof vi.fn>; availability: ReturnType<typeof vi.fn> } {
  return {
    id,
    availability: vi.fn(async () => options.availability ?? 'available'),
    match: vi.fn(async () => {
      if ('error' in options) throw options.error;
      return options.result ?? matchResult(RESUMES[0]?.id ?? '101', 0.9, id);
    }),
  } as ResumeMatcher & {
    match: ReturnType<typeof vi.fn>;
    availability: ReturnType<typeof vi.fn>;
  };
}

describe('provider order', () => {
  it('uses only the heuristic when AI is disabled', () => {
    expect(
      providerOrder({ ...DEFAULT_SETTINGS.ai, enabled: false }, { hasOpenRouterKey: true }),
    ).toEqual(['heuristic']);
  });

  it('honours an explicit provider selection', () => {
    const base = {
      ...DEFAULT_SETTINGS.ai,
      openRouter: ROUTING,
      enabled: true,
      minConfidence: 0.5,
    } as const;
    expect(providerOrder({ ...base, provider: 'heuristic' }, { hasOpenRouterKey: true })).toEqual([
      'heuristic',
    ]);
    expect(providerOrder({ ...base, provider: 'openrouter' }, { hasOpenRouterKey: true })).toEqual([
      'openrouter',
      'heuristic',
    ]);
    expect(providerOrder({ ...base, provider: 'openrouter' }, { hasOpenRouterKey: false })).toEqual(
      ['openrouter', 'heuristic'],
    );
  });

  it('in auto mode only adds OpenRouter when a key and model can actually run', () => {
    const ai = {
      ...DEFAULT_SETTINGS.ai,
      openRouter: ROUTING,
      enabled: true,
      provider: 'auto',
      minConfidence: 0.5,
    } as const;
    expect(providerOrder(ai, { hasOpenRouterKey: false })).toEqual(['heuristic']);
    expect(providerOrder(ai, { hasOpenRouterKey: true })).toEqual(['openrouter', 'heuristic']);
    const noModel = { ...ai, openRouter: { ...ROUTING, model: null } };
    expect(providerOrder(noModel, { hasOpenRouterKey: true })).toEqual(['heuristic']);
  });

  it('gives a stored auto provider only OpenRouter and basic matching, never a model step', () => {
    const ai = { ...DEFAULT_SETTINGS.ai, openRouter: ROUTING, enabled: true } as const;
    expect(providerOrder({ ...ai, provider: 'auto' }, { hasOpenRouterKey: true })).toEqual([
      'openrouter',
      'heuristic',
    ]);
    expect(providerOrder({ ...ai, provider: 'auto' }, { hasOpenRouterKey: false })).toEqual([
      'heuristic',
    ]);
  });
});

describe('matcher provider selection', () => {
  it('uses OpenRouter in auto mode when a key and model are configured', async () => {
    const openRouter = fakeProvider('openrouter', {
      result: matchResult('303', 0.95, 'openrouter'),
    });
    const matcher = createMatcher({
      settings: makeSettings(AI_ON),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });

    const result = await matcher.match(makeInput());

    expect(result.ok && result.value.resumeId).toBe('303');
    expect(openRouter.match).toHaveBeenCalledTimes(1);
  });

  it('skips an unavailable provider and uses the next one', async () => {
    const openRouter = fakeProvider('openrouter', { availability: 'unavailable' });
    const matcher = createMatcher({
      settings: makeSettings(AI_ON),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });

    const result = await matcher.match(makeInput());

    expect(result.ok && result.value.provider).toBe('heuristic');
    expect(openRouter.match).not.toHaveBeenCalled();
  });

  it('falls back to the heuristic when the AI provider fails', async () => {
    const onError = vi.fn();
    const openRouter = fakeProvider('openrouter', {
      error: providerError('RATE_LIMITED', 'rate limited', { retryable: true }),
    });
    const matcher = createMatcher({
      settings: makeSettings(AI_ON),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
      onError,
    });

    const result = await matcher.match(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('heuristic');
    expect(result.value.resumeId).toBe('101');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.map(([error]) => (error as { code: string }).code)).toEqual([
      'RATE_LIMITED',
    ]);
  });

  it('never returns a resume that is not in the allowlist', async () => {
    const onError = vi.fn();
    const openRouter = fakeProvider('openrouter', {
      result: matchResult('999', 0.99, 'openrouter'),
    });
    const matcher = createMatcher({
      settings: makeSettings(withProvider('openrouter')),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
      onError,
    });

    const result = await matcher.match(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(RESUMES.map((resume) => resume.id)).toContain(result.value.resumeId);
    expect(onError).toHaveBeenCalled();
  });

  it('rejects a low-confidence AI answer and uses the heuristic instead', async () => {
    const openRouter = fakeProvider('openrouter', {
      result: matchResult('303', 0.2, 'openrouter'),
    });
    const matcher = createMatcher({
      settings: makeSettings(withProvider('openrouter')),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });

    const result = await matcher.match(makeInput());

    expect(openRouter.match).toHaveBeenCalledTimes(1);
    expect(result.ok && result.value.provider).toBe('heuristic');
    expect(result.ok && result.value.resumeId).toBe('101');
  });

  it('uses the configured default resume when confidence stays below the threshold', async () => {
    const matcher = createMatcher({
      settings: makeSettings({
        ai: { enabled: true, provider: 'heuristic', minConfidence: 1 },
        documents: { defaultResumeId: '303' },
      }),
      cache: null,
      openRouter: fakeProvider('openrouter', { availability: 'unavailable' }),
    });

    const result = await matcher.match(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumeId).toBe('303');
    expect(result.value.reason).toContain('default resume');
    expect(result.value.confidence).toBeLessThan(1);
  });

  it('reports availability and the effective order', async () => {
    const matcher = createMatcher({
      settings: makeSettings(AI_ON),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter: fakeProvider('openrouter', { availability: 'available' }),
    });

    await expect(matcher.availability()).resolves.toEqual({
      heuristic: 'available',
      openRouter: 'available',
      order: ['openrouter', 'heuristic'],
    });
    expect(matcher.providerOrder()).toEqual(['openrouter', 'heuristic']);
  });

  it('works with no provider injection and no AI key (heuristic only)', async () => {
    const matcher = createMatcher({ settings: makeSettings(), cache: null });
    const result = await matcher.match(makeInput());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.provider).toBe('heuristic');
    await expect(matcher.availability()).resolves.toMatchObject({ openRouter: 'unavailable' });
  });
});

describe('matcher safety', () => {
  it('returns INVALID_INPUT instead of throwing when there are no resumes', async () => {
    const matcher = createMatcher({ settings: makeSettings(), cache: null });
    const result = await matcher.match(makeInput({ resumes: [] }));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.code).toBe('INVALID_INPUT');
  });

  it('returns CANCELLED when the signal is already aborted', async () => {
    const openRouter = fakeProvider('openrouter');
    const matcher = createMatcher({
      settings: makeSettings(AI_ON),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await matcher.match(makeInput(), controller.signal);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.code).toBe('CANCELLED');
    expect(openRouter.match).not.toHaveBeenCalled();
  });

  it('does not reject when a provider throws an untyped value', async () => {
    const openRouter = {
      id: 'openrouter' as const,
      availability: vi.fn(async () => 'available' as const),
      match: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const matcher = createMatcher({
      settings: makeSettings(withProvider('openrouter')),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });

    await expect(matcher.match(makeInput())).resolves.toMatchObject({ ok: true });
  });

  it('stops with CANCELLED when a provider reports cancellation mid-flight', async () => {
    const controller = new AbortController();
    const openRouter = {
      id: 'openrouter' as const,
      availability: vi.fn(async () => 'available' as const),
      match: vi.fn(async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }),
    };
    const matcher = createMatcher({
      settings: makeSettings(withProvider('openrouter')),
      keys: { openRouterApiKey: 'test-key' },
      cache: null,
      openRouter,
    });

    const result = await matcher.match(makeInput(), controller.signal);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.code).toBe('CANCELLED');
  });
});

describe('cache integration', () => {
  it('returns a cached AI result without calling the provider again', async () => {
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store, now: () => 1_000 });
    const openRouter = fakeProvider('openrouter', {
      result: matchResult('202', 0.9, 'openrouter'),
    });
    const matcher = createMatcher({
      settings: makeSettings(withProvider('openrouter')),
      keys: { openRouterApiKey: 'test-key' },
      cache,
      openRouter,
    });

    const first = await matcher.match(makeInput());
    const second = await matcher.match(makeInput());

    expect(first.ok && first.value.cached).toBe(false);
    expect(second.ok && second.value.cached).toBe(true);
    expect(second.ok && second.value.resumeId).toBe('202');
    expect(openRouter.match).toHaveBeenCalledTimes(1);
  });

  it('does not persist heuristic results', async () => {
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store });
    const matcher = createMatcher({ settings: makeSettings(), cache });

    await matcher.match(makeInput());

    expect(await store.getAll()).toEqual([]);
  });

  it('ignores the cache when AI is disabled', async () => {
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store });
    await store.put({
      key: await cacheKey(makeInput()),
      createdAt: 1,
      result: matchResult('202', 0.99, 'openrouter'),
    });

    const matcher = createMatcher({ settings: makeSettings(), cache });
    const result = await matcher.match(makeInput());

    expect(result.ok && result.value.provider).toBe('heuristic');
    expect(result.ok && result.value.cached).not.toBe(true);
  });

  it('ignores a cached result that no longer clears the threshold', async () => {
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store });
    await store.put({
      key: await cacheKey(makeInput()),
      createdAt: 1,
      result: matchResult('202', 0.6, 'openrouter'),
    });
    const openRouter = fakeProvider('openrouter', {
      result: matchResult('303', 0.95, 'openrouter'),
    });
    const matcher = createMatcher({
      settings: makeSettings({
        ai: { enabled: true, provider: 'openrouter', minConfidence: 0.9 },
      }),
      keys: { openRouterApiKey: 'test-key' },
      cache,
      openRouter,
    });

    const result = await matcher.match(makeInput());

    expect(openRouter.match).toHaveBeenCalledTimes(1);
    expect(result.ok && result.value.resumeId).toBe('303');
    expect(result.ok && result.value.cached).toBe(false);
  });

  it('builds a deterministic, order-independent hash key with no raw text', async () => {
    const forward = await cacheKey(makeInput());
    const shuffled = await cacheKey(makeInput({ resumes: [...RESUMES].reverse() }));

    expect(forward).toBe(shuffled);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).not.toContain('Full Stack');
    expect(await cacheKey(makeInput({ jobTitle: 'Data Engineer' }))).not.toBe(forward);
  });

  it('prunes the oldest entries down to the limit', async () => {
    let clock = 0;
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store, now: () => (clock += 1) });

    for (const id of ['1', '2', '3', '4', '5']) {
      await cache.put(`key-${id}`, matchResult(id, 0.9, 'openrouter'));
    }

    await expect(cache.prune(3)).resolves.toBe(2);
    expect((await store.getAll()).map((entry) => entry.key).sort()).toEqual([
      'key-3',
      'key-4',
      'key-5',
    ]);
    expect(await cache.get('key-1')).toBeUndefined();
    expect(await cache.get('key-5')).toMatchObject({ resumeId: '5', cached: true });
  });

  it('drops a corrupted cache entry instead of returning it', async () => {
    const store = createMemoryCacheStore();
    const cache = createAiCache({ store });
    await store.put({ key: 'bad', createdAt: 1, result: { resumeId: '999', confidence: 2 } });

    await expect(cache.get('bad')).resolves.toBeUndefined();
    expect(await store.get('bad')).toBeUndefined();
  });

  it('persists through the IndexedDB store and clears fully', async () => {
    await clearAiCache();
    const cache = createAiCache({ now: () => 123 });

    await cache.put('idb-key', matchResult('101', 0.7, 'heuristic'));
    await expect(cache.get('idb-key')).resolves.toMatchObject({
      resumeId: '101',
      provider: 'heuristic',
      cached: true,
    });

    await expect(pruneAiCache(0)).resolves.toBe(1);
    await expect(cache.get('idb-key')).resolves.toBeUndefined();
  });
});
