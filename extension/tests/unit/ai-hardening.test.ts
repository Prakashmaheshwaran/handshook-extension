import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatcher } from '@/ai/matcher';
import { cacheKey, createAiCache, createMemoryCacheStore } from '@/ai/cache';
import { AI_REQUEST_TIMEOUT_MS } from '@/ai/cancellation';
import { AI_PROMPT_VERSION, type OpenRouterModelsStore } from '@/ai/models';
import { MODEL, ROUTING, CHAT } from './helpers/openrouter';
import {
  createOpenRouterMatcher as buildOpenRouterMatcher,
  type OpenRouterMatcherOptions,
  createOpenRouterRuntime,
  OPENROUTER_BACKOFF_BASE_MS,
  OPENROUTER_MIN_INTERVAL_MS,
} from '@/ai/providers/openrouter';
import { openRouterStatusMessage, testAiProvider as probe, type AiTestDeps } from '@/background/ai';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  mergeSettings,
  type MatchInput,
  type ResumeMatcher,
  type AiProvider,
} from '@/core/contracts';
import type { FetchLike } from '@/ai/types';

const resume = { id: 'r1', title: 'Frontend', description: 'React applications' };
const input: MatchInput = {
  jobTitle: 'Frontend developer',
  jobDescription: 'Build React applications.',
  resumes: [resume],
};
const answer = { resumeId: 'r1', confidence: 0.9, reason: 'Relevant experience' };
const settings = (provider: 'openrouter' | 'auto' | 'heuristic' = 'openrouter') =>
  mergeSettings(DEFAULT_SETTINGS, {
    ai: { enabled: true, provider, openRouter: ROUTING },
  });
const body = CHAT;
const response = (payload: unknown = body, status = 200): Response =>
  new Response(JSON.stringify(payload), { status });
const never = <T>(): Promise<T> => new Promise(() => {});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let epoch = 0;
let remembered: unknown;
const modelsStore: OpenRouterModelsStore = {
  read: async () => remembered,
  write: async (value) => {
    remembered = value;
  },
};
function createOpenRouterMatcher(options: OpenRouterMatcherOptions) {
  return buildOpenRouterMatcher({
    hasPermission: async () => true,
    settings: ROUTING,
    modelsStore,
    ...options,
  });
}
function testAiProvider(provider: AiProvider, deps: AiTestDeps = {}) {
  return probe(provider, {
    hasPermission: async () => true,
    modelsStore,
    settings: ROUTING,
    runtime: createOpenRouterRuntime(),
    ...deps,
  });
}
beforeEach(() => {
  remembered = undefined;
  vi.useFakeTimers();
  // Separate fake-clock windows without resetting the shared production runtime.
  vi.setSystemTime(new Date(2_000_000_000_000 + ++epoch * 1_000_000));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function openRouter(fetchImpl: FetchLike, timeoutMs?: number) {
  return createOpenRouterMatcher({
    apiKey: 'fixture-key',
    fetchImpl,
    runtime: createOpenRouterRuntime(),
    timeoutMs,
  });
}
function matcher(provider: ResumeMatcher) {
  return createMatcher({
    settings: settings('openrouter'),
    openRouter: provider.id === 'openrouter' ? provider : undefined,
    cache: null,
  });
}

describe('AI cancellation and deadlines', () => {
  it('cancels an in-flight OpenRouter call promptly even when fetch ignores abort', async () => {
    const started = deferred<void>();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<FetchLike>((_url, init) => {
      requestSignal = init?.signal;
      started.resolve();
      return never<Response>();
    });
    const controller = new AbortController();
    const pending = matcher(openRouter(fetchImpl)).match(input, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'] as const)(
    'falls back when OpenRouter %s never arrive',
    async (phase) => {
      const started = deferred<void>();
      const fetchImpl: FetchLike = async () => {
        started.resolve();
        return phase === 'headers'
          ? never<Response>()
          : new Response(new ReadableStream({ pull: () => never<void>() }));
      };
      const onError = vi.fn();
      const pending = createMatcher({
        settings: settings(),
        cache: null,
        openRouter: openRouter(fetchImpl),
        onError,
      }).match(input);
      await started.promise;
      await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: true, value: { provider: 'heuristic' } });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT' }));
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('shared OpenRouter pacing', () => {
  it('spaces concurrent requests across fresh matcher instances globally', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<FetchLike>(async () => {
      calls.push(Date.now());
      return response();
    });
    const first = createOpenRouterMatcher({ apiKey: 'fixture-key', fetchImpl }).match(input);
    const second = createOpenRouterMatcher({ apiKey: 'fixture-key', fetchImpl }).match(input);
    const third = createOpenRouterMatcher({ apiKey: 'fixture-key', fetchImpl }).match(input);
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OPENROUTER_MIN_INTERVAL_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(OPENROUTER_MIN_INTERVAL_MS);
    await third;
    expect(calls.map((time) => time - (calls[0] ?? 0))).toEqual([0, 1000, 2000]);
  });

  it.each([429, 200])(
    'backs off across new instances on quota errors in HTTP %i and falls back',
    async (http) => {
      const runtime = createOpenRouterRuntime();
      const fetchImpl = vi.fn<FetchLike>(async () => response({ error: { code: 429 } }, http));
      const run = () =>
        matcher(createOpenRouterMatcher({ apiKey: 'fixture-key', fetchImpl, runtime })).match(
          input,
        );
      await expect(run()).resolves.toMatchObject({ ok: true, value: { provider: 'heuristic' } });
      await expect(run()).resolves.toMatchObject({ ok: true, value: { provider: 'heuristic' } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(OPENROUTER_BACKOFF_BASE_MS);
      await run();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(OPENROUTER_BACKOFF_BASE_MS);
      await run();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(OPENROUTER_BACKOFF_BASE_MS);
      await run();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );
});

describe('cache identity and bounds', () => {
  it('hits unchanged input, misses resume edits and provider switches, and honors auto order', async () => {
    const cache = createAiCache({ store: createMemoryCacheStore() });
    const openRouterMatch = vi.fn(async () => ({ ...answer, provider: 'openrouter' as const }));
    const openRouterProvider: ResumeMatcher = {
      id: 'openrouter',
      availability: async () => 'available',
      match: openRouterMatch,
    };
    const run = (provider: 'openrouter' | 'auto' | 'heuristic', job = input) =>
      createMatcher({
        settings: settings(provider),
        cache,
        openRouter: openRouterProvider,
        keys: { openRouterApiKey: 'fixture-key' },
      }).match(job);
    await run('openrouter');
    await expect(run('openrouter')).resolves.toMatchObject({ value: { cached: true } });
    await run('openrouter', {
      ...input,
      resumes: [{ ...resume, description: 'Updated skills' }],
    });
    expect(openRouterMatch).toHaveBeenCalledTimes(2);
    await expect(run('auto')).resolves.toMatchObject({
      value: { provider: 'openrouter' },
    });
    expect(openRouterMatch).toHaveBeenCalledTimes(2);
    await expect(run('heuristic')).resolves.toMatchObject({
      value: { provider: 'heuristic', cached: false },
    });
  });

  it('invalidates keys for model, prompt version, resume name, and ambiguous ids', async () => {
    const original = await cacheKey(input, 'openrouter', MODEL);
    expect(await cacheKey(input, 'openrouter', `${MODEL}-next`)).not.toBe(original);
    expect(await cacheKey(input, 'openrouter', MODEL, `${AI_PROMPT_VERSION}-next`)).not.toBe(
      original,
    );
    expect(await cacheKey({ ...input, resumes: [{ ...resume, title: 'New name' }] })).not.toBe(
      original,
    );
    const single = { ...input, resumes: [{ id: 'a,b', title: '', description: '' }] };
    const pair = {
      ...input,
      resumes: [
        { id: 'a', title: '', description: '' },
        { id: 'b', title: '', description: '' },
      ],
    };
    expect(await cacheKey(single)).not.toBe(await cacheKey(pair));
  });

  it('prunes old cache entries automatically after a successful match', async () => {
    const store = createMemoryCacheStore();
    for (let index = 0; index < LIMITS.maxAiCache; index++) {
      await store.put({
        key: `old-${index}`,
        createdAt: 0,
        result: { ...answer, provider: 'openrouter' },
      });
    }
    await createMatcher({
      settings: settings(),
      cache: createAiCache({ store }),
      openRouter: openRouter(async () => response()),
    }).match(input);
    expect(await store.getAll()).toHaveLength(LIMITS.maxAiCache);
    expect(await store.get(await cacheKey(input, 'openrouter', MODEL))).toBeDefined();
  });
});

describe('actionable OpenRouter status', () => {
  it('reports an unavailable model through background status and probe with heuristic fallback', async () => {
    const fetchImpl: FetchLike = async () =>
      response({ error: { status: 'NOT_FOUND', message: 'untrusted fixture-key' } }, 404);
    const pending = matcher(
      createOpenRouterMatcher({ apiKey: 'fixture-key', fetchImpl, minIntervalMs: 0 }),
    ).match(input);
    await expect(pending).resolves.toMatchObject({ value: { provider: 'heuristic' } });
    expect(openRouterStatusMessage()).toMatch(/model unavailable.*using basic matching/i);
    expect(openRouterStatusMessage()).toMatch(/pick another model/i);
    const probing = testAiProvider('openrouter', {
      keys: { openRouterApiKey: 'fixture-key' },
      fetchImpl,
      minIntervalMs: 0,
    });
    const result = await probing;
    expect(result).toMatchObject({ ok: false, message: openRouterStatusMessage() });
    expect(result.message).not.toContain('fixture-key');
  });

  it.each([400, 401, 403])(
    'gives actionable key or permission guidance for HTTP %i',
    async (status) => {
      const result = await testAiProvider('openrouter', {
        keys: { openRouterApiKey: 'fixture-key' },
        fetchImpl: async () => response({}, status),
      });
      expect(result.message).toMatch(/using basic matching/i);
      expect(result.message).toMatch(/check|replace/i);
      expect(result.message).not.toContain('fixture-key');
    },
  );

  it('bounds the background probe even if fetch ignores abort', async () => {
    const pending = testAiProvider('openrouter', {
      keys: { openRouterApiKey: 'fixture-key' },
      fetchImpl: () => never<Response>(),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/timed out/i),
    });
  });
});
