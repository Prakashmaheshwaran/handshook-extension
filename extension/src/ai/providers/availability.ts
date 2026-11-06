/**
 * Provider availability + ordering (T14).
 *
 * The UI needs a per-provider status, and the orchestrator needs the order to
 * try them in. Both derive from settings, so this module is the single place
 * that encodes ARCHITECTURE.md §13:
 *
 *   explicit provider -> that provider, then heuristic
 *   auto              -> OpenRouter (key + model + grant) -> heuristic
 *   AI disabled       -> heuristic only
 *
 * `providerOrder` only decides the intent; the orchestrator checks each
 * provider's live availability before calling it. `heuristic` is always last
 * and always `available`: it is the guaranteed fallback and the only provider
 * that can run without a network or a model.
 */

import type { AiAvailability, AiProvider, ResumeMatcher, Settings } from '@/core/contracts';
import type { MatcherAvailability } from '@/ai/types';
import { abortable, requestScope, AI_AVAILABILITY_TIMEOUT_MS } from '@/ai/cancellation';

export interface ProviderOrderOptions {
  hasOpenRouterKey: boolean;
}

/** Pure ordering decision from the AI settings slice. */
export function providerOrder(ai: Settings['ai'], options: ProviderOrderOptions): AiProvider[] {
  if (!ai.enabled) return ['heuristic'];
  switch (ai.provider) {
    case 'heuristic':
      return ['heuristic'];
    case 'openrouter':
      return ['openrouter', 'heuristic'];
    default: {
      const order: AiProvider[] = [];
      if (options.hasOpenRouterKey && ai.openRouter.model) order.push('openrouter');
      order.push('heuristic');
      return order;
    }
  }
}

/** Reads a provider's availability without letting it throw. */
export async function availabilityOf(
  matcher: ResumeMatcher | undefined,
  signal?: AbortSignal,
): Promise<AiAvailability> {
  if (!matcher) return 'unavailable';
  const scope = requestScope(signal, AI_AVAILABILITY_TIMEOUT_MS);
  try {
    return await abortable(matcher.availability(), scope.signal);
  } catch {
    return 'unavailable';
  } finally {
    scope.dispose();
  }
}

export interface AvailabilityOptions {
  settings: Settings['ai'];
  hasOpenRouterKey: boolean;
  openRouter?: ResumeMatcher;
}

/**
 * Reports every provider's status plus the effective order. The heuristic is
 * hard-coded as available because it is pure JavaScript with no dependencies.
 */
export async function collectAvailability(
  options: AvailabilityOptions,
): Promise<MatcherAvailability> {
  const openRouter = await availabilityOf(options.openRouter);
  return {
    heuristic: 'available',
    openRouter,
    order: providerOrder(options.settings, { hasOpenRouterKey: options.hasOpenRouterKey }),
  };
}
