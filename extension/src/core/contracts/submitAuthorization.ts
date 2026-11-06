import { z } from 'zod';
import type { ApplyResult } from '@/core/contracts';
import type { AnswerAssistMatch, AnswerAssistQuery } from './answerAssist';
import type { AnswerWriteResult } from './answerWrite';
import type { PageAssistAnswer, PageAssistQuery } from './pageAssist';

/** A click/timestamp alone is never evidence of a completed application. */
export function hasPositiveSubmissionEvidence(result: ApplyResult): boolean {
  if (
    /\b(no|not|never|failed|failure|unable|error|unsuccessful)\b/i.test(
      result.confirmationText ?? '',
    )
  )
    return false;
  return /you applied on|^applied on\b|^withdraw application$|application submitted|application sent|application received|successfully applied|you have applied|^applied$/i.test(
    result.confirmationText ?? '',
  );
}

/** Content must obtain a fresh grant for the exact in-flight apply request. */
export const submitAuthorizationRequestSchema = z.object({
  type: z.literal('engine.authorizeSubmit'),
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  applyRequestId: z.string().min(1),
});

export type SubmitAuthorizationRequest = z.infer<typeof submitAuthorizationRequestSchema>;

export const revokeSubmitRequestSchema = z.object({
  type: z.literal('content.revokeSubmit'),
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  applyRequestId: z.string().min(1),
});

export const submitAuthorizationResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.literal(true),
  data: z.object({ authorized: z.boolean() }),
});

/** Local controls are separate from the serialized options snapshot. */
export interface ApplyControl {
  authorizeSubmit(): Promise<boolean>;
  needsReview(): boolean;
  /** Bound by the content router to the current job route and host. */
  isCurrentJob?(): boolean;
  /** Keeps the late-result observer on the exact pre-submit evidence baseline. */
  beforeSubmit?(baselineTexts: string[]): void;
  /**
   * Asks the background to pick a control the selectors missed. Resolves null on
   * any failure, timeout, disabled setting, or when no candidate is a safe match.
   */
  pageAssist?(query: PageAssistQuery): Promise<PageAssistAnswer | null>;
  /**
   * Asks the background which saved answer each differently worded question is
   * asking for. Resolves null on any failure, timeout or disabled setting.
   */
  answerAssist?(questions: AnswerAssistQuery): Promise<AnswerAssistMatch[] | null>;
  /**
   * Asks the background to write answers the bank could not supply, for
   * questions that do not depend on a personal fact. Resolves null on failure.
   */
  answerWrite?(questions: AnswerAssistQuery): Promise<AnswerWriteResult[] | null>;
}
