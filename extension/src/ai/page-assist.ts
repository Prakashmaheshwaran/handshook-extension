/**
 * AI page assist: ask the OpenRouter model to pick one described control.
 *
 * The model only chooses WHICH candidate is the requested control. It never
 * chooses answers, documents, or whether to submit, and the content script
 * still applies its deterministic safety rules to the returned element.
 */
import { z } from 'zod';
import { DEFAULT_OPENROUTER_MODEL } from '@/core/contracts';
import type {
  PageAssistCandidate,
  PageAssistScope,
  PageAssistTarget,
} from '@/core/contracts/pageAssist';
import { redactSecretsText } from '@/core/logging/redact';
import { requestOpenRouterJson, type OpenRouterMatcherOptions } from '@/ai/providers/openrouter';
import { providerError } from '@/ai/types';

/** A model answer below this confidence is treated as "not found". */
export const PAGE_ASSIST_MIN_CONFIDENCE = 0.7;

const SELECTION_SCHEMA_NAME = 'page_assist_candidate';
const MAX_REASON_LENGTH = 200;

const selectionSchema = z
  .object({
    index: z.number().int(),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(MAX_REASON_LENGTH),
  })
  .strict();

export interface PageAssistSelection {
  /** Candidate index, or null when the model answered -1. */
  readonly index: number | null;
  readonly confidence: number;
  readonly reason: string;
  readonly model: string;
  readonly costUsd?: number;
}

export interface PageAssistInput {
  readonly target: PageAssistTarget;
  readonly scope: PageAssistScope;
  readonly candidates: readonly PageAssistCandidate[];
}

const TARGET_DESCRIPTIONS: Record<PageAssistTarget, string> = {
  applyButton:
    'the page-level Apply button that opens the job application dialog (it must be OUTSIDE any open dialog)',
  submitButton:
    'the Submit Application button inside the open application dialog (it must be INSIDE the dialog)',
  resumeField: 'the control inside the dialog that attaches or selects the resume',
  coverLetterField: 'the control inside the dialog that attaches or selects the cover letter',
  transcriptField: 'the control inside the dialog that attaches or selects the transcript',
  otherDocumentField:
    'the control inside the dialog that attaches or selects one of the other required documents',
};

function systemPrompt(input: PageAssistInput): string {
  return [
    'You are locating exactly one control on a Handshake job application page.',
    `The requested target is: ${TARGET_DESCRIPTIONS[input.target]}.`,
    `The candidate controls were collected from the ${input.scope === 'dialog' ? 'open application dialog' : 'job page'}.`,
    'Answer with one candidate index from the provided list, or -1 when no candidate is the requested control.',
    'Never choose a destructive or unrelated action such as withdraw, delete, remove, cancel, close, save, share, upload, preview, or logout.',
    'Return only the JSON object required by the schema: index, confidence (0..1) and a short reason.',
  ].join('\n');
}

function responseSchema(indexes: readonly number[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['index', 'confidence', 'reason'],
    properties: {
      index: { type: 'integer', enum: [...indexes, -1] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: MAX_REASON_LENGTH },
    },
  };
}

/**
 * Picks one candidate with the configured OpenRouter model. Rejects with an
 * `AiProviderError` whose message is always static, so no provider text can
 * leak a key through a caller's error handling.
 */
export async function choosePageAssistCandidate(
  input: PageAssistInput,
  options: OpenRouterMatcherOptions,
  signal?: AbortSignal,
): Promise<PageAssistSelection> {
  if (input.candidates.length === 0)
    throw providerError('INVALID_INPUT', 'No page-assist candidates were supplied.');
  const indexes = input.candidates.map((candidate) => candidate.index);
  const { json, model, costUsd } = await requestOpenRouterJson(
    {
      system: systemPrompt(input),
      user: JSON.stringify({
        target: input.target,
        scope: input.scope,
        candidates: input.candidates,
      }),
      schemaName: SELECTION_SCHEMA_NAME,
      schema: responseSchema(indexes),
      maxTokens: 200,
    },
    options,
    signal,
  );
  const parsed = selectionSchema.safeParse(json);
  if (!parsed.success)
    throw providerError(
      'INVALID_INPUT',
      'OpenRouter returned an invalid page-assist answer; skipping.',
    );
  const { index, confidence, reason } = parsed.data;
  if (index !== -1 && !indexes.includes(index))
    throw providerError(
      'INVALID_INPUT',
      'OpenRouter returned a page-assist candidate outside the supplied list; skipping.',
    );
  return {
    index: index === -1 ? null : index,
    confidence,
    reason: redactSecretsText(reason, options.apiKey ? [options.apiKey] : []).slice(
      0,
      MAX_REASON_LENGTH,
    ),
    model,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** The model this feature will call; exported for diagnostics and tests. */
export function pageAssistModel(settings: OpenRouterMatcherOptions['settings']): string {
  return settings?.model ?? DEFAULT_OPENROUTER_MODEL;
}
