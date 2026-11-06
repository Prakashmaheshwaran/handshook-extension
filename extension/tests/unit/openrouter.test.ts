import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppError,
} from '@/core/contracts';
import {
  createOpenRouterMatcher,
  createOpenRouterRuntime,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MIN_INTERVAL_MS,
  OPENROUTER_BACKOFF_BASE_MS,
  OPENROUTER_BACKOFF_MAX_MS,
  loadOpenRouterKeyInfo,
  loadOpenRouterModels,
  requestOpenRouterJson,
} from '@/ai/providers/openrouter';
import { createMatcher } from '@/ai/matcher';
import { AiProviderError, type FetchLike } from '@/ai/types';
import { UNTRUSTED_START, UNTRUSTED_END } from '@/ai/prompts';
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

function answerBody(content: string, model = MODEL) {
  return { ...CHAT, model, choices: [{ message: { content }, finish_reason: 'stop' }] };
}
async function rejection(pending: Promise<unknown>): Promise<AppError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof AiProviderError) return error.appError;
    throw error;
  }
  throw new Error('Expected provider rejection');
}

describe('OpenRouter matching policy', () => {
  it.each([
    [true, true, 'json_schema'],
    [false, true, 'json_object'],
    [false, false, undefined],
  ] as const)(
    'uses the advertised output format (%s, %s)',
    async (structured, format, expected) => {
      const fetchImpl = vi.fn<FetchLike>(async () => response());
      const result = await createOpenRouterMatcher(
        options({
          fetchImpl,
          modelSummary: {
            ...MODEL_SUMMARY,
            supportsStructuredOutputs: structured,
            supportsResponseFormat: format,
          },
        }),
      ).match(INPUT);
      expect(result).toMatchObject({
        ...ANSWER,
        provider: 'openrouter',
        modelId: MODEL,
        cached: false,
      });
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe(OPENROUTER_ENDPOINT);
      expect(url).not.toContain(KEY);
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Handshook',
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        stream: false,
        provider: { data_collection: 'deny' },
      });
      expect(body.models).toBeUndefined();
      expect(body.route).toBeUndefined();
      expect(body.provider.zdr).toBeUndefined();
      expect(body.provider.max_price).toBeUndefined();
      expect(body.response_format?.type).toBe(expected);
      expect(body.provider.require_parameters).toBe(structured ? true : undefined);
      if (structured) {
        expect(body.response_format.json_schema).toMatchObject({
          strict: true,
          schema: { additionalProperties: false, required: ['resumeId', 'confidence', 'reason'] },
        });
        expect(body.response_format.json_schema.schema.properties.resumeId.enum).toEqual(['r1']);
      }
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].content).toContain(UNTRUSTED_START);
      expect(body.messages[1].content).toContain(UNTRUSTED_END);
      expect(body.messages[1].content).toContain('"r1"');
      expect(JSON.stringify(body)).not.toContain(KEY);
    },
  );

  it('sends configured fallback models, collection consent, ZDR and a USD per million price cap', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    await createOpenRouterMatcher(
      options({
        fetchImpl,
        settings: {
          ...ROUTING,
          fallbackModels: ['fixture/second', 'fixture/third'],
          allowDataCollection: true,
          zeroDataRetention: true,
          maxPromptPricePerMillion: 0,
        },
      }),
    ).match(INPUT);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: MODEL,
      models: [MODEL, 'fixture/second', 'fixture/third'],
      route: 'fallback',
      provider: { data_collection: 'allow', zdr: true, max_price: { prompt: 0 } },
    });
    expect(body.provider.max_price.completion).toBeUndefined();
    expect(body.provider.require_parameters).toBeUndefined();
  });

  it('projects only matching fields and never forwards cookie or saved-answer data', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    const enrichedInput = {
      ...INPUT,
      cookies: 'fictional-handshake-cookie',
      answers: [{ value: 'fictional-private-answer' }],
      resumes: INPUT.resumes.map((resume) => ({ ...resume, answer: 'fictional-private-answer' })),
    };
    await createOpenRouterMatcher(options({ fetchImpl })).match(enrichedInput);
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.stringify(request)).not.toMatch(
      /fictional-handshake-cookie|fictional-private-answer/,
    );
    expect(new Headers(request?.headers).has('Cookie')).toBe(false);
    expect(request?.credentials).toBe('omit');
  });

  it.each([
    [false, 'openrouter'],
    [true, 'heuristic'],
  ] as const)('sends no request with enabled=%s and provider=%s', async (enabled, provider) => {
    const fetchImpl = vi.fn<FetchLike>();
    const result = await createMatcher({
      settings: mergeSettings(DEFAULT_SETTINGS, {
        ai: { enabled, provider, openRouter: ROUTING },
      }),
      keys: { openRouterApiKey: KEY },
      fetchImpl,
      cache: null,
    }).match(INPUT);
    expect(result).toMatchObject({ ok: true, value: { provider: 'heuristic' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stamps the model that actually answered and strips JSON fences', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response(answerBody(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``, 'fixture/fallback')),
    );
    expect(await createOpenRouterMatcher(options({ fetchImpl })).match(INPUT)).toMatchObject({
      modelId: 'fixture/fallback',
      provider: 'openrouter',
    });
  });

  it('removes the exact key and other sk-or keys from explanations', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response(answerBody(JSON.stringify({ ...ANSWER, reason: `Match ${KEY} sk-or-short` }))),
    );
    const result = await createOpenRouterMatcher(options({ fetchImpl })).match(INPUT);
    expect(result.reason).toBe('Match [REDACTED] [REDACTED_API_KEY]');
    expect(JSON.stringify(result)).not.toContain('sk-or-');
  });

  it('requires a key, a selected model and the current permission for availability', async () => {
    expect(await createOpenRouterMatcher(options()).availability()).toBe('available');
    for (const patch of [
      { apiKey: undefined },
      { settings: { ...ROUTING, model: null } },
      { hasPermission: async () => false },
    ]) {
      expect(await createOpenRouterMatcher(options(patch)).availability()).toBe('unavailable');
    }
  });

  it('rejects oversized response text and model identities', async () => {
    for (const payload of [
      answerBody(' '.repeat(16385) + JSON.stringify(ANSWER)),
      answerBody(JSON.stringify(ANSWER), 'x'.repeat(257)),
    ]) {
      const error = await rejection(
        createOpenRouterMatcher(options({ fetchImpl: async () => response(payload) })).match(INPUT),
      );
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it.each(['declared', 'streamed'] as const)(
    'cancels %s oversized response bodies before JSON parsing',
    async (kind) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(' '.repeat(65537)));
        },
        cancel,
      });
      const fetchImpl: FetchLike = async () =>
        new Response(stream, { headers: kind === 'declared' ? { 'Content-Length': '65537' } : {} });
      const error = await rejection(createOpenRouterMatcher(options({ fetchImpl })).match(INPUT));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(/too large/i);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(['key', 'models'] as const)('also bounds the %s endpoint body', async (kind) => {
    const cancel = vi.fn();
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
      });
    const deps = options({ fetchImpl });
    const error = await rejection(
      kind === 'key' ? loadOpenRouterKeyInfo(deps) : loadOpenRouterModels(deps, true),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['prose', 'Best resume is r1'],
    ['unknown ID', JSON.stringify({ ...ANSWER, resumeId: 'unknown' })],
    ['extra field', JSON.stringify({ ...ANSWER, action: 'submit' })],
    ['invalid confidence', JSON.stringify({ ...ANSWER, confidence: 2 })],
    ['long explanation', JSON.stringify({ ...ANSWER, reason: 'a'.repeat(501) })],
  ])('rejects %s instead of trusting the model', async (_name, content) => {
    const matcher = createOpenRouterMatcher(
      options({ fetchImpl: async () => response(answerBody(content)) }),
    );
    expect((await rejection(matcher.match(INPUT))).code).toBe('INVALID_INPUT');
  });

  it.each([{}, { model: MODEL, choices: [] }, { choices: CHAT.choices }, answerBody('')])(
    'rejects a malformed or empty chat envelope',
    async (payload) => {
      expect(
        (
          await rejection(
            createOpenRouterMatcher(options({ fetchImpl: async () => response(payload) })).match(
              INPUT,
            ),
          )
        ).code,
      ).toBe('INVALID_INPUT');
    },
  );

  it('rejects blocked choices and choice-level error envelopes', async () => {
    for (const choice of [
      { message: { content: null }, finish_reason: 'content_filter' },
      { error: { code: 403, message: KEY } },
    ]) {
      const result = await rejection(
        createOpenRouterMatcher(
          options({ fetchImpl: async () => response({ model: MODEL, choices: [choice] }) }),
        ).match(INPUT),
      );
      expect(result.code).toBe('FORBIDDEN');
      expect(result.message).toMatch(/moderation/i);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it('does not send a request for a missing key or model', async () => {
    for (const patch of [{ apiKey: undefined }, { settings: { ...ROUTING, model: null } }]) {
      const fetchImpl = vi.fn<FetchLike>();
      await rejection(createOpenRouterMatcher(options({ ...patch, fetchImpl })).match(INPUT));
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('OpenRouter failures preserve basic matching', () => {
  it.each([
    [400, 'INVALID_INPUT', /parameters/i],
    [401, 'FORBIDDEN', /invalid or disabled/i],
    [402, 'FORBIDDEN', /out of credits/i],
    [403, 'FORBIDDEN', /moderation.*budget/i],
    [404, 'NETWORK', /pick another model/i],
    [408, 'TIMEOUT', /timed out/i],
    [429, 'RATE_LIMITED', /rate limit/i],
    [502, 'NETWORK', /model is down/i],
    [503, 'NETWORK', /privacy filters/i],
    [504, 'TIMEOUT', /timed out/i],
  ])(
    'maps HTTP %i to actionable safe text and heuristic fallback',
    async (status, code, message) => {
      const onError = vi.fn();
      const fetchImpl = vi.fn<FetchLike>(async () =>
        response({ error: { code: status, message: `untrusted ${KEY}` } }, status),
      );
      const result = await createMatcher({
        settings: mergeSettings(DEFAULT_SETTINGS, {
          ai: { enabled: true, provider: 'openrouter', openRouter: ROUTING },
        }),
        cache: null,
        onError,
        openRouter: createOpenRouterMatcher(options({ fetchImpl })),
      }).match(INPUT);
      expect(result).toMatchObject({ ok: true, value: { provider: 'heuristic' } });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code, message: expect.stringMatching(message) }),
      );
      expect(JSON.stringify(onError.mock.calls)).not.toContain(KEY);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 402, 403, 404, 429, 503])(
    'treats HTTP 200 error code %i as a failure',
    async (code) => {
      const error = await rejection(
        createOpenRouterMatcher(
          options({ fetchImpl: async () => response({ error: { code, message: KEY } }) }),
        ).match(INPUT),
      );
      expect(error.message).toMatch(/OpenRouter/);
      expect(JSON.stringify(error)).not.toContain(KEY);
    },
  );

  it('explains privacy filters that exclude every provider', async () => {
    const error = await rejection(
      createOpenRouterMatcher(
        options({
          fetchImpl: async () =>
            response(
              { error: { code: 404, message: 'No endpoints found matching data policy' } },
              404,
            ),
        }),
      ).match(INPUT),
    );
    expect(error.message).toMatch(/allow data collection or pick another model/i);
  });

  it('does not echo network exceptions or malformed JSON', async () => {
    const failure = await rejection(
      createOpenRouterMatcher(
        options({
          fetchImpl: async () => {
            throw new Error(KEY);
          },
        }),
      ).match(INPUT),
    );
    expect(failure.code).toBe('NETWORK');
    expect(JSON.stringify(failure)).not.toContain(KEY);
    const invalid = await rejection(
      createOpenRouterMatcher(
        options({
          fetchImpl: async () => new Response(KEY),
        }),
      ).match(INPUT),
    );
    expect(invalid.code).toBe('INVALID_INPUT');
  });
});

describe('shared OpenRouter rate limits', () => {
  it('also backs off for an HTTP 200 choice-level rate-limit error', async () => {
    const runtime = createOpenRouterRuntime();
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response({ model: MODEL, choices: [{ error: { code: 429, message: KEY } }] }, 200, {
        'Retry-After': '90',
      }),
    );
    const deps = options({ fetchImpl, runtime, now: () => 0 });
    expect((await rejection(createOpenRouterMatcher(deps).match(INPUT))).code).toBe('RATE_LIMITED');
    expect(runtime.backoffUntil).toBe(90000);
    await rejection(createOpenRouterMatcher(deps).match(INPUT));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('paces consecutive calls without blocking the event loop', async () => {
    let clock = 0;
    const wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const fetchImpl = vi.fn<FetchLike>(async () => response());
    const matcher = createOpenRouterMatcher(
      options({ fetchImpl, now: () => clock, wait, minIntervalMs: OPENROUTER_MIN_INTERVAL_MS }),
    );
    await matcher.match(INPUT);
    await matcher.match(INPUT);
    expect(wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['60', 60000],
    ['999999', OPENROUTER_BACKOFF_MAX_MS],
    ['0', OPENROUTER_BACKOFF_BASE_MS],
    ['invalid', OPENROUTER_BACKOFF_BASE_MS],
    [new Date(120000).toUTCString(), 120000],
  ])('bounds Retry-After %s and shares the cooldown across instances', async (header, delay) => {
    const runtime = createOpenRouterRuntime();
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response({ error: { code: 429 } }, 429, { 'Retry-After': header }),
    );
    const deps = options({ fetchImpl, runtime, now: () => 0 });
    await rejection(createOpenRouterMatcher(deps).match(INPUT));
    expect(runtime.backoffUntil).toBe(delay);
    await rejection(createOpenRouterMatcher(deps).match(INPUT));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('generic structured-output requests (page assist)', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['index', 'confidence', 'reason'],
    properties: {
      index: { type: 'integer', enum: [0, 1, -1] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: 200 },
    },
  };

  it('uses the DeepSeek default model and a strict json_schema with require_parameters', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({
        model: DEFAULT_OPENROUTER_MODEL,
        choices: [
          {
            message: { content: '{"index":1,"confidence":0.88,"reason":"footer submit"}' },
            finish_reason: 'stop',
          },
        ],
        usage: { cost: 0.00002 },
      });
    });

    const result = await requestOpenRouterJson(
      { system: 'system', user: 'user', schemaName: 'page_assist_candidate', schema },
      options({ fetchImpl, settings: { ...ROUTING, model: null } }),
    );

    expect(bodies[0]).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'page_assist_candidate', strict: true, schema },
      },
      provider: { data_collection: 'deny', require_parameters: true },
    });
    expect(bodies[0]?.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ]);
    expect(result).toEqual({
      json: { index: 1, confidence: 0.88, reason: 'footer submit' },
      model: DEFAULT_OPENROUTER_MODEL,
      costUsd: 0.00002,
    });
  });

  it('rejects a non-JSON answer without leaking provider text', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(answerBody(`not json ${KEY}`)));

    const error = await rejection(
      requestOpenRouterJson(
        { system: 'system', user: 'user', schemaName: 'page_assist_candidate', schema },
        options({ fetchImpl }),
      ),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).not.toContain(KEY);
  });
});

describe('empty answers from a reasoning model', () => {
  it('retries once with more room when the model spends its budget first', async () => {
    let calls = 0;
    const matcher = createOpenRouterMatcher(
      options({
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? response({
                ...CHAT,
                choices: [{ message: { content: '' }, finish_reason: 'length' }],
              })
            : response(answerBody(JSON.stringify(ANSWER)));
        },
      }),
    );

    const result = await matcher.match(INPUT);

    expect(calls).toBe(2);
    expect(result).toMatchObject({ resumeId: ANSWER.resumeId });
  });

  it('still rejects when both attempts are empty', async () => {
    let calls = 0;
    const matcher = createOpenRouterMatcher(
      options({
        fetchImpl: async () => {
          calls += 1;
          return response(answerBody(''));
        },
      }),
    );

    expect((await rejection(matcher.match(INPUT))).code).toBe('INVALID_INPUT');
    expect(calls).toBe(2);
  });
});
