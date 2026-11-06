/** OpenRouter BYOK transport, shared pacing and validated resume selection. */
import { z } from 'zod';
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SETTINGS,
  isRecord,
  type MatchInput,
  type MatchResult,
  type OpenRouterKeyInfo,
  type OpenRouterModelsPayload,
  type OpenRouterModelSummary,
  type ResumeMatcher,
  type Settings,
} from '@/core/contracts';
import { sleep } from '@/core/util/time';
import { redactSecretsText } from '@/core/logging/redact';
import { abortable, requestScope } from '@/ai/cancellation';
import { hasOpenRouterHostPermission } from '@/ai/permissions';
import {
  mapOpenRouterModels,
  openRouterModelsStore,
  readOpenRouterModels,
  type OpenRouterModelsStore,
} from '@/ai/models';
import { buildMatchPrompt } from '@/ai/prompts';
import { validateAiMatch } from '@/ai/validate';
import { AiProviderError, providerError, type FetchLike } from '@/ai/types';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODELS_ENDPOINT =
  'https://openrouter.ai/api/v1/models?output_modalities=text';
export const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
export const OPENROUTER_MIN_INTERVAL_MS = 1000;
export const OPENROUTER_MAX_OUTPUT_TOKENS = 400;
export const OPENROUTER_BACKOFF_BASE_MS = 30_000;
export const OPENROUTER_BACKOFF_MAX_MS = 300_000;
export const OPENROUTER_MAX_RESPONSE_BYTES = 64 * 1024;
export const OPENROUTER_MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export interface OpenRouterRuntime {
  nextAllowedAt: number;
  backoffUntil: number;
  rateLimitCount: number;
  message?: string;
}

export function createOpenRouterRuntime(): OpenRouterRuntime {
  return { nextAllowedAt: 0, backoffUntil: 0, rateLimitCount: 0 };
}

const runtime = createOpenRouterRuntime();

export function openRouterStatusMessage(): string | undefined {
  return runtime.message;
}

export function clearOpenRouterStatus(): void {
  runtime.message = undefined;
}

export interface OpenRouterMatcherOptions {
  apiKey?: string;
  settings?: Settings['ai']['openRouter'];
  fetchImpl?: FetchLike;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  minIntervalMs?: number;
  runtime?: OpenRouterRuntime;
  timeoutMs?: number;
  hasPermission?: () => Promise<boolean>;
  modelsStore?: OpenRouterModelsStore;
  modelSummary?: OpenRouterModelSummary;
}

const apiErrorSchema = z.object({
  code: z.union([z.number(), z.string().max(64)]).optional(),
  message: z.string().max(2048).optional(),
});

function responseError(payload: unknown): z.infer<typeof apiErrorSchema> | undefined {
  if (!isRecord(payload)) return undefined;
  const first = Array.isArray(payload.choices) ? (payload.choices[0] as unknown) : undefined;
  const raw = payload.error ?? (isRecord(first) ? first.error : undefined);
  if (raw === undefined || raw === null) return undefined;
  const parsed = apiErrorSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function openRouterStatusError(status: number, payload?: unknown): AiProviderError {
  const apiError = responseError(payload);
  const code = Number(apiError?.code ?? status);
  if (code === 401) {
    return providerError(
      'FORBIDDEN',
      'OpenRouter key is invalid or disabled. Replace it in AI settings; using basic matching.',
    );
  }
  if (code === 402) {
    return providerError(
      'FORBIDDEN',
      'OpenRouter is out of credits. Add credits or choose a free model; using basic matching.',
    );
  }
  if (code === 403) {
    return providerError(
      'FORBIDDEN',
      'OpenRouter blocked this request due to moderation, a guardrail, or an exhausted key budget. Check key limits or choose another model; using basic matching.',
    );
  }
  if (code === 404 || code === 503) {
    const privacy =
      /privacy|data.?collect|data policy|zero.?data|\bzdr\b|no endpoints.*policy/i.test(
        apiError?.message ?? '',
      );
    return providerError(
      'NETWORK',
      privacy
        ? 'OpenRouter privacy settings exclude all providers of this model. Allow data collection or pick another model; using basic matching.'
        : 'OpenRouter model unavailable or expired. Pick another model; if privacy filters exclude its providers, allow data collection or choose a different model. Using basic matching.',
      { retryable: true },
    );
  }
  if (code === 408 || code === 504) {
    return providerError(
      'TIMEOUT',
      'OpenRouter timed out. Try again or pick another model; using basic matching.',
      { retryable: true },
    );
  }
  if (code === 429) {
    return providerError(
      'RATE_LIMITED',
      'OpenRouter rate limit reached. Wait before trying again; free models also have daily caps. Using basic matching.',
      { retryable: true },
    );
  }
  if (code === 502 || code >= 500) {
    return providerError(
      'NETWORK',
      'OpenRouter model is down or returned an invalid response. Try again or pick another model; using basic matching.',
      { retryable: true },
    );
  }
  if (code === 400) {
    return providerError(
      'INVALID_INPUT',
      'OpenRouter rejected the model or request parameters. Check the selected model and routing settings; using basic matching.',
    );
  }
  return providerError(
    'INVALID_INPUT',
    'OpenRouter returned an unexpected response; using basic matching.',
  );
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const header = response.headers?.get('Retry-After')?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

function rememberFailure(error: unknown, options: OpenRouterMatcherOptions): AiProviderError {
  const mapped =
    error instanceof AiProviderError
      ? error
      : providerError(
          'NETWORK',
          'Could not reach OpenRouter. Check your connection and the OpenRouter host permission; using basic matching.',
          { retryable: true },
        );
  if (mapped.appError.code !== 'CANCELLED')
    (options.runtime ?? runtime).message = mapped.appError.message;
  return mapped;
}

async function requirePermission(
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<void> {
  let granted = false;
  try {
    granted = await abortable((options.hasPermission ?? hasOpenRouterHostPermission)(), signal);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
  }
  if (!granted)
    throw providerError(
      'FORBIDDEN',
      'OpenRouter permission is not granted. Allow it from AI settings before loading models, testing, or matching.',
    );
}

/** Bound decoded bytes even when Content-Length is absent or misleading. */
async function readBoundedJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const tooLarge = () =>
    providerError('INVALID_INPUT', 'OpenRouter response was too large; using basic matching.');
  if (Number(response.headers.get('Content-Length')) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let complete = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) {
        complete = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw tooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** One deadline covers metadata, shared pacing, headers and body parsing. */
async function requestJson(
  url: string,
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
  makeBody?: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const scope = requestScope(signal, options.timeoutMs);
  const now = options.now ?? Date.now;
  const state = options.runtime ?? runtime;
  const wait = options.wait ?? sleep;
  const apiKey = options.apiKey?.trim();
  try {
    if (scope.signal.aborted) await abortable(Promise.resolve(), scope.signal);
    if (!apiKey && url !== OPENROUTER_MODELS_ENDPOINT) {
      throw providerError('FORBIDDEN', 'Add an OpenRouter API key in AI settings first.');
    }
    const body = makeBody ? await abortable(makeBody(scope.signal), scope.signal) : undefined;
    if (state.backoffUntil > now()) throw openRouterStatusError(429);
    while (state.nextAllowedAt > now()) {
      await abortable(wait(state.nextAllowedAt - now(), scope.signal), scope.signal);
      if (state.backoffUntil > now()) throw openRouterStatusError(429);
    }
    state.nextAllowedAt = now() + (options.minIntervalMs ?? OPENROUTER_MIN_INTERVAL_MS);
    // CORS is not consent. Revocation during a pacing wait must stop this request.
    await requirePermission(options, scope.signal);
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    const response = await abortable(
      fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-OpenRouter-Title': 'Handshook',
        },
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: scope.signal,
      }),
      scope.signal,
    );
    let payload: unknown;
    try {
      payload = await readBoundedJson(
        response,
        url === OPENROUTER_MODELS_ENDPOINT
          ? OPENROUTER_MAX_CATALOG_BYTES
          : OPENROUTER_MAX_RESPONSE_BYTES,
        scope.signal,
      );
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (response.ok)
        throw providerError(
          'INVALID_INPUT',
          'OpenRouter returned a response that was not JSON; using basic matching.',
        );
    }
    const apiError = responseError(payload);
    if (!response.ok || apiError) {
      const mapped = openRouterStatusError(
        response.status,
        apiError ? { error: apiError } : payload,
      );
      if (mapped.appError.code === 'RATE_LIMITED' && state.backoffUntil <= now()) {
        state.rateLimitCount = Math.min(state.rateLimitCount + 1, 5);
        const exponential = OPENROUTER_BACKOFF_BASE_MS * 2 ** (state.rateLimitCount - 1);
        const delay = retryAfterMs(response, now()) ?? exponential;
        state.backoffUntil =
          now() + Math.min(OPENROUTER_BACKOFF_MAX_MS, Math.max(OPENROUTER_BACKOFF_BASE_MS, delay));
      }
      throw mapped;
    }
    state.rateLimitCount = 0;
    state.message = undefined;
    return payload;
  } catch (error) {
    throw rememberFailure(error, options);
  } finally {
    scope.dispose();
  }
}

export async function loadOpenRouterModels(
  options: OpenRouterMatcherOptions = {},
  refresh = false,
  signal?: AbortSignal,
): Promise<OpenRouterModelsPayload> {
  const scope = requestScope(signal, options.timeoutMs);
  try {
    await requirePermission(options, scope.signal);
    const store = options.modelsStore ?? openRouterModelsStore;
    const now = options.now ?? Date.now;
    if (!refresh) {
      const cached = await abortable(
        readOpenRouterModels(now(), store, options.apiKey ? [options.apiKey] : []),
        scope.signal,
      );
      if (cached) return cached;
    }
    const payload = await requestJson(OPENROUTER_MODELS_ENDPOINT, options, scope.signal);
    let models: OpenRouterModelSummary[];
    try {
      models = mapOpenRouterModels(payload, options.apiKey ? [options.apiKey] : []);
    } catch {
      throw providerError(
        'INVALID_INPUT',
        'OpenRouter returned an invalid model catalog. Try refreshing models.',
      );
    }
    const catalog = { models, fetchedAt: now() };
    try {
      await abortable(store.write(catalog), scope.signal);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      // The live catalog remains usable when persistence is unavailable.
    }
    return catalog;
  } catch (error) {
    throw rememberFailure(error, options);
  } finally {
    scope.dispose();
  }
}

export async function loadOpenRouterKeyInfo(
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<OpenRouterKeyInfo> {
  const payload = await requestJson(OPENROUTER_KEY_ENDPOINT, options, signal);
  const parsed = z
    .object({
      data: z.object({
        label: z.string().max(512),
        limit: z.number().finite().nonnegative().nullable(),
        limit_remaining: z.number().finite().nonnegative().nullable(),
        usage: z.number().finite().nonnegative(),
        is_free_tier: z.boolean(),
        free_model_daily_requests: z
          .object({ remaining: z.number().finite().nonnegative().nullable().optional() })
          .nullish(),
      }),
    })
    .safeParse(payload);
  if (!parsed.success)
    throw rememberFailure(
      providerError(
        'INVALID_INPUT',
        'OpenRouter returned invalid key information. Try checking the key again.',
      ),
      options,
    );
  const data = parsed.data.data;
  return {
    label: redactSecretsText(data.label, options.apiKey ? [options.apiKey] : []),
    limit: data.limit,
    limitRemaining: data.limit_remaining,
    usage: data.usage,
    isFreeTier: data.is_free_tier,
    freeDailyRemaining: data.free_model_daily_requests?.remaining ?? null,
  };
}

const chatResponseSchema = z.object({
  model: z.string().trim().min(1).max(256),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().max(16384).nullable().optional() }).optional(),
        finish_reason: z.string().max(64).nullable().optional(),
        error: apiErrorSchema.optional(),
      }),
    )
    .min(1)
    .max(4),
  usage: z.object({ cost: z.number().finite().nonnegative().optional() }).optional(),
});

/** Both the settings probe and real matching use exactly the selected routing policy. */
export async function requestOpenRouter(
  input: MatchInput,
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<{ payload: z.infer<typeof chatResponseSchema>; model: string; costUsd?: number }> {
  // The matcher needs a real answer to pick a resume; a reasoning model that
  // spends the whole budget before writing content returns an empty message, so
  // one retry with more room is made before falling back to basic matching.
  const attempt = (maxTokens: number) =>
    requestJson(OPENROUTER_ENDPOINT, options, signal, async (signal) => {
      const settings = options.settings ?? DEFAULT_SETTINGS.ai.openRouter;
      if (!settings.model)
        throw providerError('INVALID_INPUT', 'Choose an OpenRouter model in AI settings first.');
      const catalog = options.modelSummary
        ? undefined
        : await abortable(readOpenRouterModels(options.now?.(), options.modelsStore), signal);
      const summary =
        options.modelSummary?.id === settings.model
          ? options.modelSummary
          : catalog?.models.find((model) => model.id === settings.model);
      const prompt = buildMatchPrompt(input);
      const structured = summary?.supportsStructuredOutputs === true;
      const responseFormat = structured
        ? {
            type: 'json_schema',
            json_schema: {
              name: 'resume_match',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['resumeId', 'confidence', 'reason'],
                properties: {
                  resumeId: { type: 'string', enum: input.resumes.map((resume) => resume.id) },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  reason: { type: 'string', maxLength: 500 },
                },
              },
            },
          }
        : summary?.supportsResponseFormat
          ? { type: 'json_object' }
          : undefined;
      return {
        model: settings.model,
        ...(settings.fallbackModels.length
          ? { models: [settings.model, ...settings.fallbackModels], route: 'fallback' }
          : {}),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        provider: {
          data_collection: settings.allowDataCollection ? 'allow' : 'deny',
          ...(settings.zeroDataRetention ? { zdr: true } : {}),
          ...(settings.maxPromptPricePerMillion === null
            ? {}
            : { max_price: { prompt: settings.maxPromptPricePerMillion } }),
          ...(structured ? { require_parameters: true } : {}),
        },
      };
    });
  const read = async (maxTokens: number) => {
    const payload = await attempt(maxTokens);
    const parsed = chatResponseSchema.safeParse(payload);
    if (!parsed.success)
      throw rememberFailure(
        providerError(
          'INVALID_INPUT',
          'OpenRouter returned an invalid or empty model response; using basic matching.',
        ),
        options,
      );
    return parsed;
  };
  let parsed = await read(OPENROUTER_MAX_OUTPUT_TOKENS);
  if (!parsed.data.choices[0]?.message?.content?.trim() && !signal?.aborted) {
    parsed = await read(OPENROUTER_MAX_OUTPUT_TOKENS * 4);
  }
  const first = parsed.data.choices[0];
  if (first?.error)
    throw rememberFailure(openRouterStatusError(502, { error: first.error }), options);
  if (first?.finish_reason === 'content_filter')
    throw rememberFailure(openRouterStatusError(403), options);
  return {
    payload: parsed.data,
    model: redactSecretsText(parsed.data.model, options.apiKey ? [options.apiKey] : []),
    costUsd: parsed.data.usage?.cost,
  };
}

export interface OpenRouterJsonRequest {
  readonly system: string;
  readonly user: string;
  /** Name of the json_schema response format. */
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  readonly maxTokens?: number;
}

export interface OpenRouterJsonAnswer {
  readonly json: unknown;
  readonly model: string;
  readonly costUsd?: number;
}

/**
 * A generic structured-output request for features that are not resume matching.
 * Routing, pacing, redaction and the require_parameters guarantee are shared with
 * matching so a page-assist answer can never take a different privacy path.
 */
export async function requestOpenRouterJson(
  request: OpenRouterJsonRequest,
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<OpenRouterJsonAnswer> {
  try {
    const settings = options.settings ?? DEFAULT_SETTINGS.ai.openRouter;
    const model = settings.model ?? DEFAULT_OPENROUTER_MODEL;
    const budget = request.maxTokens ?? OPENROUTER_MAX_OUTPUT_TOKENS;
    const attempt = async (maxTokens: number) => {
      const payload = await requestJson(OPENROUTER_ENDPOINT, options, signal, async () => ({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, strict: true, schema: request.schema },
        },
        provider: {
          data_collection: settings.allowDataCollection ? 'allow' : 'deny',
          ...(settings.zeroDataRetention ? { zdr: true } : {}),
          ...(settings.maxPromptPricePerMillion === null
            ? {}
            : { max_price: { prompt: settings.maxPromptPricePerMillion } }),
          require_parameters: true,
        },
      }));
      const parsed = chatResponseSchema.safeParse(payload);
      if (!parsed.success)
        throw providerError(
          'INVALID_INPUT',
          'OpenRouter returned an invalid or empty model response; skipping.',
        );
      const first = parsed.data.choices[0];
      if (first?.error) throw openRouterStatusError(502, { error: first.error });
      if (first?.finish_reason === 'content_filter') throw openRouterStatusError(403);
      return { parsed: parsed.data, first };
    };
    // A reasoning model can spend the whole budget before writing any content,
    // returning an empty message. One retry with more room keeps that transient
    // overrun from failing a page assist, an answer or a resume pick.
    let answer = await attempt(budget);
    if (!answer.first?.message?.content?.trim() && !signal?.aborted) {
      answer = await attempt(budget * 4);
    }
    const raw = answer.first?.message?.content?.trim();
    if (!raw)
      throw providerError(
        'INVALID_INPUT',
        `OpenRouter returned an empty response (finish: ${answer.first?.finish_reason ?? 'unknown'}); skipping.`,
      );
    const text = raw.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i, '$1').trim();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw providerError('INVALID_INPUT', 'OpenRouter returned invalid JSON; skipping.');
    }
    return {
      json,
      model: redactSecretsText(answer.parsed.model, options.apiKey ? [options.apiKey] : []),
      costUsd: answer.parsed.usage?.cost,
    };
  } catch (error) {
    throw rememberFailure(error, options);
  }
}

export async function matchOpenRouter(
  input: MatchInput,
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<MatchResult & { costUsd?: number }> {
  try {
    if (!input.resumes.length)
      throw providerError('INVALID_INPUT', 'No resumes available to match');
    const { payload, model, costUsd } = await requestOpenRouter(input, options, signal);
    const raw = payload.choices[0]?.message?.content?.trim();
    if (!raw)
      throw providerError(
        'INVALID_INPUT',
        'OpenRouter returned an empty response; using basic matching.',
      );
    const text = raw.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i, '$1').trim();
    const validated = validateAiMatch(
      text,
      input.resumes.map((resume) => resume.id),
      'openrouter',
    );
    if (!validated.ok) throw new AiProviderError(validated.error);
    return {
      ...validated.value,
      reason: redactSecretsText(validated.value.reason, options.apiKey ? [options.apiKey] : []),
      modelId: model,
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  } catch (error) {
    throw rememberFailure(error, options);
  }
}

export function createOpenRouterMatcher(options: OpenRouterMatcherOptions = {}): ResumeMatcher {
  return {
    id: 'openrouter',
    availability: async () =>
      options.apiKey?.trim() &&
      options.settings?.model &&
      (await (options.hasPermission ?? hasOpenRouterHostPermission)())
        ? 'available'
        : 'unavailable',
    modelId: () => Promise.resolve(options.settings?.model ?? ''),
    match: (input, signal) => matchOpenRouter(input, options, signal),
  };
}
