/**
 * AI background helpers: an honest provider probe.
 *
 * `ui.ai.test` performs a real, minimal request when a key/provider exists.
 * Failures are reported as plain copy (401/403/429/network) instead of a
 * blanket "looks ready", and the key never appears in a message or event.
 */

import { matchOpenRouter, type OpenRouterMatcherOptions } from '@/ai/providers/openrouter';
export { openRouterStatusMessage, clearOpenRouterStatus } from '@/ai/providers/openrouter';
import { AiProviderError } from '@/ai/types';
import type { AiKeys, AiProvider, AiTestResult, MatchInput } from '@/core/contracts';
export type { AiTestResult } from '@/core/contracts';

export interface AiTestDeps extends Omit<OpenRouterMatcherOptions, 'apiKey'> {
  keys?: AiKeys;
}

const TEST_INPUT: MatchInput = {
  jobTitle: 'Software developer',
  jobDescription: 'Build software.',
  resumes: [{ id: 'test-resume', title: 'Software developer', description: 'Build software.' }],
};

async function testOpenRouter(deps: AiTestDeps): Promise<AiTestResult> {
  const provider: AiProvider = 'openrouter';
  const apiKey = deps.keys?.openRouterApiKey;
  if (!apiKey) {
    return { provider, ok: false, message: 'Add an OpenRouter API key first.' };
  }
  try {
    const result = await matchOpenRouter(TEST_INPUT, {
      ...deps,
      apiKey,
      timeoutMs: deps.timeoutMs ?? 10_000,
    });
    return {
      provider,
      ok: true,
      message: 'OpenRouter accepted the key and answered.',
      model: result.modelId,
      costUsd: result.costUsd,
    };
  } catch (error) {
    return {
      provider,
      ok: false,
      message:
        error instanceof AiProviderError
          ? error.appError.message
          : 'Could not reach OpenRouter. Check your connection and allow the OpenRouter host permission.',
    };
  }
}

export async function testAiProvider(
  provider: AiProvider,
  deps: AiTestDeps = {},
): Promise<AiTestResult> {
  if (provider === 'heuristic') {
    return { provider, ok: true, message: 'Keyword matching is always available.' };
  }
  return testOpenRouter(deps);
}
