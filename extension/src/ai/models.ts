import { z } from 'zod';
import type { OpenRouterModelsPayload, OpenRouterModelSummary } from '@/core/contracts';
import { getMeta, setMeta } from '@/core/storage/db';
import { redactSecretsText } from '@/core/logging/redact';

// Bump when the prompt layout changes so cached matches are invalidated.
export const AI_PROMPT_VERSION = '2';

export const OPENROUTER_MODELS_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_MODELS_STORAGE_KEY = 'ai.openrouter.models.v1';
export const OPENROUTER_MAX_MODELS = 5000;

export const openRouterModelSummarySchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(512),
  contextLength: z.number().finite().nonnegative().nullable(),
  promptPricePerMillion: z.number().finite().nonnegative().nullable(),
  completionPricePerMillion: z.number().finite().nonnegative().nullable(),
  isFree: z.boolean(),
  supportsStructuredOutputs: z.boolean(),
  supportsResponseFormat: z.boolean(),
  expirationDate: z.string().max(64).nullable(),
});

const catalogSchema = z.object({
  models: z.array(openRouterModelSummarySchema).max(OPENROUTER_MAX_MODELS),
  fetchedAt: z.number().finite().nonnegative(),
});

export interface OpenRouterModelsStore {
  read(): Promise<unknown>;
  write(value: OpenRouterModelsPayload): Promise<void>;
}

export const openRouterModelsStore: OpenRouterModelsStore = {
  read: () => getMeta(OPENROUTER_MODELS_STORAGE_KEY),
  write: (value) => setMeta(OPENROUTER_MODELS_STORAGE_KEY, value),
};

export async function readOpenRouterModels(
  now = Date.now(),
  store = openRouterModelsStore,
  secrets: readonly string[] = [],
): Promise<OpenRouterModelsPayload | undefined> {
  try {
    const parsed = catalogSchema.safeParse(await store.read());
    if (
      parsed.success &&
      parsed.data.fetchedAt <= now &&
      now - parsed.data.fetchedAt < OPENROUTER_MODELS_TTL_MS
    )
      return {
        ...parsed.data,
        models: parsed.data.models.map((model) => ({
          ...model,
          id: redactSecretsText(model.id, secrets),
          name: redactSecretsText(model.name, secrets),
          expirationDate:
            model.expirationDate === null ? null : redactSecretsText(model.expirationDate, secrets),
        })),
      };
  } catch {
    // Catalog storage failure must not stop matching without format hints.
  }
  return undefined;
}

const rawModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().max(512).optional(),
  context_length: z.number().finite().nonnegative().nullish(),
  pricing: z
    .object({ prompt: z.string().max(128).optional(), completion: z.string().max(128).optional() })
    .optional(),
  supported_parameters: z.array(z.string().max(128)).max(128).optional(),
  architecture: z.object({ output_modalities: z.array(z.string().max(64)).max(16) }).optional(),
  top_provider: z
    .object({ context_length: z.number().finite().nonnegative().nullish() })
    .optional(),
  expiration_date: z.string().max(64).nullish(),
});

function pricePerMillion(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw) * 1_000_000;
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Number(value.toPrecision(15));
  return Number.isFinite(rounded) ? rounded : null;
}

/** API prices are USD per token; display and routing policy use USD per million. */
export function mapOpenRouterModels(
  payload: unknown,
  secrets: readonly string[] = [],
): OpenRouterModelSummary[] {
  const envelope = z
    .object({ data: z.array(z.unknown()).max(OPENROUTER_MAX_MODELS) })
    .safeParse(payload);
  if (!envelope.success) throw new Error('Invalid OpenRouter model catalog');
  const models = new Map<string, OpenRouterModelSummary>();
  for (const value of envelope.data.data) {
    const parsed = rawModelSchema.safeParse(value);
    if (!parsed.success || !parsed.data.architecture?.output_modalities.includes('text')) continue;
    const raw = parsed.data;
    const promptPricePerMillion = pricePerMillion(raw.pricing?.prompt);
    const completionPricePerMillion = pricePerMillion(raw.pricing?.completion);
    const id = redactSecretsText(raw.id, secrets);
    models.set(id, {
      id,
      name: redactSecretsText(raw.name ?? raw.id, secrets),
      contextLength: raw.context_length ?? raw.top_provider?.context_length ?? null,
      promptPricePerMillion,
      completionPricePerMillion,
      isFree:
        id.endsWith(':free') || (promptPricePerMillion === 0 && completionPricePerMillion === 0),
      supportsStructuredOutputs: raw.supported_parameters?.includes('structured_outputs') ?? false,
      supportsResponseFormat: raw.supported_parameters?.includes('response_format') ?? false,
      expirationDate: raw.expiration_date ? redactSecretsText(raw.expiration_date, secrets) : null,
    });
  }
  return [...models.values()];
}
