import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterMatcher } from '@/ai/providers/openrouter';
import { createMatcher } from '@/ai/matcher';
import { handleUi } from '@/background/router';
import { DEFAULT_SETTINGS, mergeSettings } from '@/core/contracts';
import { resetDb } from '@/core/storage/db';
import { saveAiKey, saveSettings } from '@/core/storage/settings';
import { createFakeBrowser } from './helpers/fakeBrowser';
import type { FetchLike } from '@/ai/types';
import { CHAT, INPUT, KEY, MODEL, ROUTING, response } from './helpers/openrouter';

let epoch = 0;
const realNow = Date.now.bind(Date);
beforeEach(async () => {
  const offset = ++epoch * 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  vi.stubGlobal('browser', createFakeBrowser({ openRouterPermission: true }).fake);
  await resetDb();
  localStorage.clear();
  await saveSettings(
    mergeSettings(DEFAULT_SETTINGS, {
      ai: { enabled: true, provider: 'openrouter', openRouter: ROUTING },
    }),
  );
  await saveAiKey(KEY);
  await handleUi({ type: 'ui.ai.clearKey', requestId: 'clear-status' });
  await saveAiKey(KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenRouter background RPC', () => {
  it('status and local-provider probes never contact OpenRouter even with a saved key', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    vi.stubGlobal('fetch', fetchImpl);
    const replies = [
      await handleUi({ type: 'ui.ai.status', requestId: 'status' }),
      await handleUi({ type: 'ui.ai.test', requestId: 'basic', provider: 'heuristic' }),
    ];
    expect(JSON.stringify(replies)).not.toContain(KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('surfaces sanitized model failures and clears the status when the key changes', async () => {
    await createMatcher({
      settings: mergeSettings(DEFAULT_SETTINGS, {
        ai: { enabled: true, provider: 'openrouter', openRouter: ROUTING },
      }),
      cache: null,
      openRouter: createOpenRouterMatcher({
        apiKey: KEY,
        settings: ROUTING,
        hasPermission: async () => true,
        minIntervalMs: 0,
        modelsStore: { read: async () => undefined, write: async () => {} },
        fetchImpl: async () => response({ error: { code: 404, message: KEY } }, 404),
      }),
    }).match(INPUT);
    const status = await handleUi({ type: 'ui.ai.status', requestId: 'status' });
    expect(status).toMatchObject({
      ok: true,
      data: {
        openRouterConfigured: true,
        openRouterPermission: 'granted',
        geminiReplacedNotice: false,
        openRouterMessage: expect.stringMatching(/model unavailable.*using basic matching/i),
      },
    });
    expect(JSON.stringify(status)).not.toContain(KEY);
    await handleUi({ type: 'ui.ai.setKey', requestId: 'key', apiKey: `  ${KEY}  ` });
    expect(await handleUi({ type: 'ui.ai.status', requestId: 'status2' })).toMatchObject({
      ok: true,
      data: { openRouterMessage: undefined },
    });
  });
  it('returns a warning for unusual key prefixes without rejecting them', async () => {
    expect(
      await handleUi({ type: 'ui.ai.setKey', requestId: 'key', apiKey: 'fixture-unusual-key' }),
    ).toMatchObject({
      ok: true,
      data: { saved: true, warning: expect.stringMatching(/sk-or-/) },
    });
  });
  it('reports missing consent and missing model with useful status text', async () => {
    vi.stubGlobal('browser', createFakeBrowser().fake);
    await saveAiKey(KEY);
    await saveSettings(mergeSettings(DEFAULT_SETTINGS, { ai: { openRouter: ROUTING } }));
    expect(await handleUi({ type: 'ui.ai.status', requestId: 'permission' })).toMatchObject({
      data: {
        openRouterPermission: 'not_granted',
        openRouterMessage: expect.stringMatching(/permission is not granted/i),
      },
    });
    await saveSettings(
      mergeSettings(DEFAULT_SETTINGS, {
        ai: { openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: null } },
      }),
    );
    expect(await handleUi({ type: 'ui.ai.status', requestId: 'model' })).toMatchObject({
      data: { openRouterMessage: expect.stringMatching(/choose.*model/i) },
    });
  });
  it('returns model summaries, caching metadata and no key', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          {
            id: MODEL,
            name: 'Text model',
            pricing: { prompt: '0', completion: '0' },
            architecture: { output_modalities: ['text'] },
            supported_parameters: [],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const result = await handleUi({
      type: 'ui.ai.openrouter.models',
      requestId: 'models',
      refresh: true,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { models: [{ id: MODEL, isFree: true }], fetchedAt: expect.any(Number) },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    await handleUi({ type: 'ui.ai.openrouter.models', requestId: 'cached' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('returns clear model errors when consent is missing', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubGlobal('browser', createFakeBrowser().fake);
    expect(await handleUi({ type: 'ui.ai.openrouter.models', requestId: 'models' })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', message: expect.stringMatching(/permission/i) },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('maps key credits through the keyInfo RPC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          data: {
            label: 'Fixture key',
            limit: 10,
            limit_remaining: 9,
            usage: 1,
            is_free_tier: false,
          },
        }),
      ),
    );
    const result = await handleUi({ type: 'ui.ai.openrouter.keyInfo', requestId: 'key-info' });
    expect(result).toMatchObject({
      ok: true,
      data: {
        label: 'Fixture key',
        limit: 10,
        limitRemaining: 9,
        usage: 1,
        isFreeTier: false,
        freeDailyRemaining: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it('tests the selected model with a tiny validated matching request and returns actual model and cost', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response({
        ...CHAT,
        model: 'fixture/actual-model',
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
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const result = await handleUi({
      type: 'ui.ai.test',
      requestId: 'test',
      provider: 'openrouter',
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        ok: true,
        provider: 'openrouter',
        model: 'fixture/actual-model',
        costUsd: CHAT.usage.cost,
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: MODEL,
      provider: { data_collection: 'deny' },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
