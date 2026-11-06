/**
 * Validation for model output (ARCHITECTURE.md §13, CONTRACTS.md §10).
 *
 * Everything that crosses the model boundary is untrusted: a model may return
 * prose, markdown fences, extra keys, an id that was never offered, or a
 * confidence outside 0..1. This module is the only place that turns raw text
 * into a `MatchResult`, and it rejects rather than "repairs":
 *
 * - malformed JSON            -> INVALID_INPUT
 * - not an object             -> INVALID_INPUT
 * - unknown resume id         -> INVALID_INPUT
 * - confidence outside 0..1   -> INVALID_INPUT
 * - reason longer than 500    -> INVALID_INPUT
 * - any extra field           -> INVALID_INPUT
 *
 * Rejecting means the orchestrator falls back to the deterministic heuristic
 * instead of trusting a coerced value.
 */

import { z } from 'zod';
import { appError, err, ok } from '@/core/contracts';
import type { AiProvider, AppError, MatchResult, Result } from '@/core/contracts';
import { MAX_AI_REASON_CHARS } from '@/ai/prompts';

/**
 * Strict variant of the contract's `aiMatchSchema`: unknown keys are rejected
 * and the reason cap matches the prompt.
 */
const aiMatchOutputSchema = z
  .object({
    resumeId: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(MAX_AI_REASON_CHARS),
  })
  .strict();

function invalid(message: string, issues: string[] = []): AppError {
  return appError('INVALID_INPUT', message, {
    details: issues.length > 0 ? { issues } : undefined,
  });
}

function parseJson(raw: string): Result<unknown> {
  const text = raw.trim();
  if (text.length === 0) return err(invalid('AI response was empty'));
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    // Deliberately no fence stripping: the contract requires JSON only, and
    // silently accepting markdown would hide provider regressions.
    return err(invalid('AI response was not valid JSON'));
  }
}

/**
 * Validates a model response against the allowlist of resume ids.
 *
 * `raw` may be the parsed object or the raw text returned by a provider.
 * `provider` is stamped onto the result; it defaults to `heuristic` so a
 * validated payload never claims to come from a cloud provider by accident.
 */
export function validateAiMatch(
  raw: unknown,
  validIds: readonly string[],
  provider: AiProvider = 'heuristic',
): Result<MatchResult> {
  const allowlist = new Set(validIds.filter((id) => id.length > 0));
  if (allowlist.size === 0) {
    return err(invalid('No valid resume ids to match against'));
  }

  const parsedValue = typeof raw === 'string' ? parseJson(raw) : ok(raw);
  if (!parsedValue.ok) return parsedValue;

  const parsed = aiMatchOutputSchema.safeParse(parsedValue.value);
  if (!parsed.success) {
    return err(
      invalid(
        'AI response did not match the required shape',
        parsed.error.issues.map((issue) => issue.path.join('.') || 'root'),
      ),
    );
  }

  if (!allowlist.has(parsed.data.resumeId)) {
    return err(invalid('AI response selected an unknown resume'));
  }

  return ok({
    resumeId: parsed.data.resumeId,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason.trim(),
    provider,
    cached: false,
  });
}
