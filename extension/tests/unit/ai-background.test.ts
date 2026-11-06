import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAiProvider as probe, type AiTestDeps } from '@/background/ai';
import { createOpenRouterRuntime } from '@/ai/providers/openrouter';
import type { AiProvider } from '@/core/contracts';
import type { FetchLike } from '@/ai/types';
import { ROUTING, MODEL, CHAT } from './helpers/openrouter';

function testAiProvider(provider: AiProvider, deps: AiTestDeps = {}) {
  return probe(provider, {
    hasPermission: async () => true,
    runtime: createOpenRouterRuntime(),
    settings: ROUTING,
    modelsStore: { read: async () => undefined, write: async () => {} },
    ...deps,
  });
}

function response(status: number): Response {
  return new Response(
    JSON.stringify(
      status === 200
        ? {
            ...CHAT,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    resumeId: 'test-resume',
                    confidence: 1,
                    reason: 'Relevant',
                  }),
                },
              },
            ],
          }
        : {},
    ),
    { status },
  );
}

function fetchReturning(status: number): FetchLike {
  return vi.fn(async () => response(status));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('testAiProvider — P1-11 makes a real minimal OpenRouter call', () => {
  it('asks for a key when none is configured', async () => {
    const result = await testAiProvider('openrouter', { keys: {} });
    expect(result).toMatchObject({ provider: 'openrouter', ok: false });
    expect(result.message).toMatch(/add an OpenRouter api key/i);
  });

  it.each([
    [401, /invalid or disabled/i],
    [403, /moderation.*budget/i],
    [429, /rate limit/i],
    [503, /unavailable/i],
  ])('reports HTTP %i honestly', async (status, pattern) => {
    const result = await testAiProvider('openrouter', {
      keys: { openRouterApiKey: 'secret-key-value' },
      fetchImpl: fetchReturning(status),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
    expect(result.message).not.toContain('secret-key-value');
  });

  it('reports a network failure without hiding it', async () => {
    const result = await testAiProvider('openrouter', {
      keys: { openRouterApiKey: 'secret-key-value' },
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not reach OpenRouter/i);
  });

  it('reports success on a 2xx response', async () => {
    const result = await testAiProvider('openrouter', {
      keys: { openRouterApiKey: 'secret-key-value' },
      fetchImpl: fetchReturning(200),
    });
    expect(result).toMatchObject({ ok: true, model: MODEL, costUsd: CHAT.usage.cost });
  });

  it('reports keyword matching as always available', async () => {
    expect(await testAiProvider('heuristic')).toMatchObject({ ok: true });
  });
});
