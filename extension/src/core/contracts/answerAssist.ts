import { z } from 'zod';

/**
 * AI answer assist: when a form question's wording differs from every saved
 * answer, the content script describes the question (the form's own label,
 * type and option labels — never the user's answers) and the background asks
 * which saved answer it is asking for. The model sees saved-answer labels and
 * aliases only, never their values; the content script fills the saved value
 * itself and re-runs every approval and option check before using it.
 */
export const ANSWER_ASSIST_MAX_QUESTIONS = 20;
export const ANSWER_ASSIST_MAX_OPTIONS = 40;
export const ANSWER_ASSIST_TEXT_MAX = 300;
export const ANSWER_ASSIST_OPTION_MAX = 120;

const QUESTION_TYPES = [
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'date',
  'number',
  'combobox',
  'unknown',
] as const;

export const answerAssistQuestionSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(ANSWER_ASSIST_TEXT_MAX),
  type: z.enum(QUESTION_TYPES),
  required: z.boolean(),
  section: z.string().max(ANSWER_ASSIST_OPTION_MAX).optional(),
  options: z
    .array(
      z.object({
        label: z.string().max(ANSWER_ASSIST_OPTION_MAX),
        value: z.string().max(ANSWER_ASSIST_OPTION_MAX),
      }),
    )
    .max(ANSWER_ASSIST_MAX_OPTIONS)
    .optional(),
});

export type AnswerAssistQuestion = z.infer<typeof answerAssistQuestionSchema>;

/** Content → background, bound to the exact in-flight apply request. */
export const answerAssistRequestSchema = z.object({
  type: z.literal('engine.answerAssist'),
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  applyRequestId: z.string().min(1),
  questions: z.array(answerAssistQuestionSchema).min(1).max(ANSWER_ASSIST_MAX_QUESTIONS),
});

export type AnswerAssistRequest = z.infer<typeof answerAssistRequestSchema>;

export const answerAssistMatchSchema = z.object({
  questionId: z.string().min(1),
  /** Saved answer id, or null when no saved answer is what the question asks. */
  answerId: z.string().min(1).nullable(),
  source: z.enum(['learned', 'ai', 'none']),
  confidence: z.number().min(0).max(1),
});

export type AnswerAssistMatch = z.infer<typeof answerAssistMatchSchema>;

export const answerAssistResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.literal(true),
  data: z.object({ matches: z.array(answerAssistMatchSchema).max(ANSWER_ASSIST_MAX_QUESTIONS) }),
});

/** What the content router binds into `ApplyControl.answerAssist`. */
export type AnswerAssistQuery = AnswerAssistQuestion[];
