/**
 * Resume-matching orchestration (T13).
 *
 * Order (ARCHITECTURE.md §13):
 *   providers in settings order (each with its own cache) -> heuristic fallback
 *
 * Guarantees:
 * - `match()` never rejects. Every failure is a typed `AppError`, and a provider
 *   failure never blocks an application: the deterministic heuristic runs last.
 * - A returned `resumeId` is always one of `input.resumes[].id`. Provider output
 *   is re-checked here even though providers validate, so a buggy provider can
 *   never select a resume outside the allowlist.
 * - Aborts short-circuit to `CANCELLED` and do not fall through to a match.
 * - Only non-heuristic results are cached: the heuristic is pure and cheap, and
 *   caching it would let a heuristic pick block a better cloud answer later.
 * - With AI disabled, the cache is ignored entirely: a user who turns AI off
 *   must not receive a stored cloud match.
 */

import type {
  AiProvider,
  AppError,
  MatchInput,
  MatchResult,
  ResumeMatcher,
  Result,
  Settings,
} from '@/core/contracts';
import { appError, err, ok } from '@/core/contracts';
import { clamp } from '@/core/util/time';
import { abortable } from '@/ai/cancellation';
import { cacheKey, createAiCache } from '@/ai/cache';
import { createHeuristicMatcher, heuristicMatch } from '@/ai/heuristic';
import { availabilityOf, collectAvailability, providerOrder } from '@/ai/providers/availability';
import { createOpenRouterMatcher } from '@/ai/providers/openrouter';
import {
  toAppError,
  type AiMatcher,
  type MatcherAvailability,
  type MatchCache,
  type MatcherDeps,
} from '@/ai/types';

function cancelled(): AppError {
  return appError('CANCELLED', 'Resume matching was cancelled', { retryable: true });
}

function isValidResult(result: MatchResult, input: MatchInput): boolean {
  if (!Number.isFinite(result.confidence)) return false;
  if (result.confidence < 0 || result.confidence > 1) return false;
  return input.resumes.some((resume) => resume.id === result.resumeId);
}

export function createMatcher(deps: MatcherDeps): AiMatcher {
  const settings: Settings = deps.settings;
  const keys = deps.keys ?? {};
  const onError = deps.onError ?? (() => {});
  const openRouter: ResumeMatcher =
    deps.openRouter ??
    createOpenRouterMatcher({
      apiKey: keys.openRouterApiKey,
      settings: settings.ai.openRouter,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
    });
  const heuristic: ResumeMatcher = createHeuristicMatcher();
  const cache: MatchCache | null =
    deps.cache === undefined ? createAiCache({ now: deps.now }) : deps.cache;
  // Recomputed per call so a settings change between matches takes effect even
  // when the caller keeps one matcher instance alive (background worker).
  const currentOrder = (): AiProvider[] =>
    providerOrder(settings.ai, { hasOpenRouterKey: Boolean(deps.keys?.openRouterApiKey) });

  function matcherFor(id: AiProvider): ResumeMatcher {
    if (id === 'openrouter') return openRouter;
    return heuristic;
  }

  async function readCache(
    key: string,
    input: MatchInput,
    minConfidence: number,
    provider: AiProvider,
  ): Promise<MatchResult | undefined> {
    if (!cache || !settings.ai.enabled) return undefined;
    try {
      const cached = await cache.get(key);
      if (!cached) return undefined;
      if (cached.provider !== provider) return undefined;
      // A cache entry must still name a resume that is on offer right now, and
      // it must clear the threshold currently configured (which may have been
      // raised since the entry was written).
      if (!isValidResult(cached, input)) return undefined;
      return cached.confidence >= minConfidence ? cached : undefined;
    } catch (error) {
      onError(toAppError(error));
      return undefined;
    }
  }

  async function writeCache(key: string, result: MatchResult): Promise<void> {
    if (!cache || !settings.ai.enabled) return;
    if (result.provider === 'heuristic') return;
    try {
      await cache.put(key, result);
      await cache.prune();
    } catch (error) {
      onError(toAppError(error));
    }
  }

  async function match(input: MatchInput, signal?: AbortSignal): Promise<Result<MatchResult>> {
    try {
      if (input.resumes.length === 0) {
        return err(appError('INVALID_INPUT', 'No resumes available to match'));
      }
      if (signal?.aborted) return err(cancelled());

      const minConfidence = clamp(settings.ai.minConfidence, 0, 1);
      for (const id of currentOrder()) {
        if (id === 'heuristic') continue;
        if (signal?.aborted) return err(cancelled());

        const provider = matcherFor(id);
        const model = provider.modelId ? await abortable(provider.modelId(), signal) : undefined;
        if ((await availabilityOf(provider, signal)) !== 'available') continue;
        const key = await abortable(cacheKey(input, id, model), signal);
        const cacheModels = [model, ...settings.ai.openRouter.fallbackModels];
        for (const cacheModel of new Set(cacheModels)) {
          const candidateKey =
            cacheModel === model ? key : await abortable(cacheKey(input, id, cacheModel), signal);
          const cached = await abortable(readCache(candidateKey, input, minConfidence, id), signal);
          if (cached) return ok({ ...cached, cached: true });
        }
        if (signal?.aborted) return err(cancelled());

        try {
          const result = await abortable(provider.match(input, signal), signal);
          if (signal?.aborted) return err(cancelled());
          if (!isValidResult(result, input)) {
            onError(appError('INVALID_INPUT', 'AI provider selected an unknown resume'));
            continue;
          }
          if (result.confidence < minConfidence) continue;
          const resultKey =
            result.modelId && result.modelId !== model
              ? await abortable(cacheKey(input, id, result.modelId), signal)
              : key;
          await abortable(writeCache(resultKey, { ...result, provider: id }), signal);
          if (signal?.aborted) return err(cancelled());
          return ok({ ...result, cached: false });
        } catch (error) {
          const mapped = toAppError(error);
          if (mapped.code === 'CANCELLED') return err(mapped);
          onError(mapped);
          if (mapped.code === 'TIMEOUT') break;
        }
      }

      if (signal?.aborted) return err(cancelled());

      const fallback = heuristicMatch(input);
      if (fallback.confidence >= minConfidence) return ok(fallback);

      const defaultResumeId = settings.documents.defaultResumeId;
      if (defaultResumeId && input.resumes.some((resume) => resume.id === defaultResumeId)) {
        const percent = Math.round(fallback.confidence * 100);
        return ok({
          resumeId: defaultResumeId,
          confidence: fallback.confidence,
          reason: `Low confidence (${percent}%); using your default resume`,
          provider: 'heuristic',
          cached: false,
        });
      }
      return ok(fallback);
    } catch (error) {
      return err(toAppError(error));
    }
  }

  return {
    match,
    availability: (): Promise<MatcherAvailability> =>
      collectAvailability({
        settings: settings.ai,
        hasOpenRouterKey: Boolean(deps.keys?.openRouterApiKey),
        openRouter,
      }),
    providerOrder: () => currentOrder(),
  };
}

/** Convenience wrapper for callers that only need one match. */
export async function matchResume(
  input: MatchInput,
  deps: MatcherDeps,
  signal?: AbortSignal,
): Promise<Result<MatchResult>> {
  return createMatcher(deps).match(input, signal);
}
