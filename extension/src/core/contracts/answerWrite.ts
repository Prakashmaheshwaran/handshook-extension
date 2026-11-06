import { z } from 'zod';
import { ANSWER_ASSIST_MAX_QUESTIONS, answerAssistQuestionSchema } from './answerAssist';

/**
 * AI answer writing, the step after the answer bank. The content script sends
 * the questions the bank could not answer (the form's own text only); the
 * background adds the job posting and the user's non-sensitive saved facts and
 * returns a value only for questions that do not depend on a personal fact.
 */
export const answerWriteRequestSchema = z.object({
  type: z.literal('engine.answerWrite'),
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  applyRequestId: z.string().min(1),
  questions: z.array(answerAssistQuestionSchema).min(1).max(ANSWER_ASSIST_MAX_QUESTIONS),
});

export type AnswerWriteRequest = z.infer<typeof answerWriteRequestSchema>;

export const answerWriteResultSchema = z.object({
  questionId: z.string().min(1),
  /** Text, or the form's own option value for a choice question. */
  value: z.string().min(1).max(1_500),
  basis: z.enum(['job', 'facts', 'general']),
  confidence: z.number().min(0).max(1),
});

export type AnswerWriteResult = z.infer<typeof answerWriteResultSchema>;

export const answerWriteResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.literal(true),
  data: z.object({
    answers: z.array(answerWriteResultSchema).max(ANSWER_ASSIST_MAX_QUESTIONS),
  }),
});
