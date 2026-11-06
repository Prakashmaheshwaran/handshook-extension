import { z } from 'zod';

/**
 * AI page assist: when a known control cannot be found by the deterministic
 * selectors, the content script describes the page's candidate controls (labels,
 * roles and allow-listed attributes only — never field values, answers or
 * document contents) and the background picks one, from a learned locator or
 * the OpenRouter model. The content script still applies its own safety checks
 * before acting on the answer.
 */
export const PAGE_ASSIST_TARGETS = [
  'applyButton',
  'submitButton',
  'resumeField',
  'coverLetterField',
  'transcriptField',
  'otherDocumentField',
] as const;

export type PageAssistTarget = (typeof PAGE_ASSIST_TARGETS)[number];

/** Where the candidates came from: the job page or the open application dialog. */
export type PageAssistScope = 'job' | 'dialog';

export const PAGE_ASSIST_MAX_CANDIDATES = 80;
export const PAGE_ASSIST_TEXT_MAX = 120;
/** Only these attribute names may be described to the background or the model. */
export const PAGE_ASSIST_ATTRIBUTES = [
  'aria-haspopup',
  'aria-expanded',
  'aria-label',
  'data-hook',
  'data-testid',
  'data-kind',
  'data-variant',
  'data-size',
  'name',
] as const;

const text = z.string().max(PAGE_ASSIST_TEXT_MAX);

export const pageAssistCandidateSchema = z.object({
  index: z.number().int().min(0),
  tag: z.string().min(1).max(32),
  role: text.optional(),
  type: text.optional(),
  name: text,
  text: text.optional(),
  placeholder: text.optional(),
  /** Nearest label, legend or heading text, for context. */
  context: text.optional(),
  attributes: z.partialRecord(z.enum(PAGE_ASSIST_ATTRIBUTES), text),
  inDialog: z.boolean(),
  disabled: z.boolean(),
});

export type PageAssistCandidate = z.infer<typeof pageAssistCandidateSchema>;

/** Content → background, bound to the exact in-flight apply request. */
export const pageAssistRequestSchema = z.object({
  type: z.literal('engine.pageAssist'),
  requestId: z.string().min(1),
  jobId: z.string().min(1),
  applyRequestId: z.string().min(1),
  target: z.enum(PAGE_ASSIST_TARGETS),
  scope: z.enum(['job', 'dialog']),
  candidates: z.array(pageAssistCandidateSchema).min(1).max(PAGE_ASSIST_MAX_CANDIDATES),
});

export type PageAssistRequest = z.infer<typeof pageAssistRequestSchema>;

export const pageAssistAnswerSchema = z.object({
  /** Candidate index, or null when nothing safely matches. */
  index: z.number().int().min(0).nullable(),
  source: z.enum(['learned', 'ai', 'none']),
  confidence: z.number().min(0).max(1).optional(),
});

export type PageAssistAnswer = z.infer<typeof pageAssistAnswerSchema>;

export const pageAssistResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.literal(true),
  data: pageAssistAnswerSchema,
});

/** What the content router binds into `ApplyControl.pageAssist`. */
export type PageAssistQuery = Pick<PageAssistRequest, 'target' | 'scope' | 'candidates'>;
