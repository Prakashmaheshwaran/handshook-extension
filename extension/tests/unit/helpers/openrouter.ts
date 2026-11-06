import { DEFAULT_SETTINGS, type MatchInput, type OpenRouterModelSummary } from '@/core/contracts';
import { createOpenRouterRuntime, type OpenRouterMatcherOptions } from '@/ai/providers/openrouter';

export const MODEL = 'fixture/text-model';
export const KEY = 'sk-or-v1-unit-test-only-1234567890';
export const ROUTING = { ...DEFAULT_SETTINGS.ai.openRouter, model: MODEL };
export const INPUT: MatchInput = {
  jobTitle: 'Frontend developer',
  jobDescription: 'Build React applications.',
  resumes: [{ id: 'r1', title: 'Frontend developer', description: 'React applications' }],
};
export const ANSWER = { resumeId: 'r1', confidence: 0.9, reason: 'Relevant experience' };
export const MODEL_SUMMARY: OpenRouterModelSummary = {
  id: MODEL,
  name: 'Text model',
  contextLength: 32768,
  promptPricePerMillion: 0.1,
  completionPricePerMillion: 0.2,
  isFree: false,
  supportsStructuredOutputs: false,
  supportsResponseFormat: false,
  expirationDate: null,
};
export const CHAT = {
  model: MODEL,
  choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.000014 },
};
export function response(payload: unknown = CHAT, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}
export function options(patch: OpenRouterMatcherOptions = {}): OpenRouterMatcherOptions {
  return {
    apiKey: KEY,
    settings: { ...ROUTING },
    runtime: createOpenRouterRuntime(),
    minIntervalMs: 0,
    hasPermission: async () => true,
    modelsStore: { read: async () => undefined, write: async () => {} },
    ...patch,
  };
}
