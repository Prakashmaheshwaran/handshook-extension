/**
 * Builds a reusable `Answer` from a pending `QuestionDescriptor`.
 *
 * The Needs-You flow must never invent metadata for a saved answer: the
 * question the user answered supplies the label, type, options, and category,
 * and sensitivity is derived from the same shared heuristic the UI shows. A
 * sensitive or EEO answer is only allowed to auto-submit when the user has
 * opted in. All answers still need their applicable global opt-ins at submit.
 */

import {
  appError,
  err,
  ok,
  parseAnswer,
  type Answer,
  type AnswerValue,
  type QuestionDescriptor,
  type Result,
} from '@/core/contracts';

/** Labels that map to sensitive categories, shared by UI copy and background. */
const SENSITIVE_PATTERN =
  /authoriz|sponsor|felony|background|veteran|disab|gender|race|ethnic|birth|ssn|salary|compensation|eeo/i;

/** EEO self-identification needs its own opt-in on top of the sensitive one. */
const EEO_PATTERN =
  /eeo|equal employment|veteran|disab|gender|race|ethnic|sexual orientation|transgender|pronoun/i;

/**
 * Identifiable structured fields. These are safe to fill without opting into
 * free-text answers because the value is factual, not prose. Everything else
 * (why do you want this job, describe a project) needs `allowFreeTextAutoFill`.
 */
const STRUCTURED_FIELD_PATTERN =
  /first name|last name|full name|preferred name|middle name|e-?mail|phone|mobile|address|street|city|state|province|zip|postal|country|linkedin|github|portfolio|website|url/i;

const IDENTITY_PATTERN = /first name|last name|full name|email|phone|address|linkedin|portfolio/i;
const WORK_PATTERN =
  /authoriz|sponsor|employment|salary|compensation|available|relocat|start date|work/i;
const EDUCATION_PATTERN = /degree|school|university|college|gpa|major|graduat|education/i;
const PREFERENCES_PATTERN = /remote|onsite|hybrid|preferred|shift|interest/i;

export type AnswerCategory = NonNullable<Answer['category']>;

/**
 * Questions about the applicant's own facts — experience, skills, eligibility,
 * history, availability, contact details, demographics. AI never writes these;
 * only a saved answer or the user can answer them.
 */
const PERSONAL_FACT_PATTERN =
  /experience|years?\b|proficien|skill|familiar|knowledge of|certif|licen[cs]|degree|gpa|grade|major|minor|graduat|enrol|student|class standing|school|university|college|\bage\b|\b1[6-9]\b|older|convict|felon|criminal|arrest|background|drug|citizen|clearance|relocat|commut|travel|start|availab|schedule|hours|shift|weekend|notice|worked|employ|previous|former|refer|related|family|relative|phone|e-?mail|address|linkedin|github|portfolio|website|\bname\b|transport|vehicle|driv|language|speak|fluent|describe|tell us|project|accomplish|example|achiev|lead|award|reference|salary|pay|wage|rate|located|live|reside|zip|state|city|country|date|when/i;

export function looksPersonalFactLabel(label: string): boolean {
  return PERSONAL_FACT_PATTERN.test(label);
}

export function looksSensitiveLabel(label: string): boolean {
  return SENSITIVE_PATTERN.test(label);
}

export function looksEeoLabel(label: string): boolean {
  return EEO_PATTERN.test(label);
}

export function isStructuredFieldLabel(label: string): boolean {
  return STRUCTURED_FIELD_PATTERN.test(label);
}

export function deriveCategoryFromLabel(label: string): AnswerCategory {
  if (EEO_PATTERN.test(label)) return 'eeo';
  if (IDENTITY_PATTERN.test(label)) return 'identity';
  if (WORK_PATTERN.test(label)) return 'work';
  if (EDUCATION_PATTERN.test(label)) return 'education';
  if (PREFERENCES_PATTERN.test(label)) return 'preferences';
  return 'custom';
}

/** Category is inferred from the question's own label/section, not the answer. */
export function deriveAnswerCategory(question: QuestionDescriptor): AnswerCategory {
  return deriveCategoryFromLabel(`${question.section ?? ''} ${question.label}`);
}

export interface AnswerDraftOptions {
  /** Mirrors `settings.safety.allowSensitiveAutoSubmit`. */
  allowSensitiveAutoSubmit: boolean;
  /** Editing a saved answer must retain its existing per-answer permission. */
  autoSubmitAllowed?: boolean;
}

export function answerFromQuestion(
  question: QuestionDescriptor,
  value: AnswerValue,
  options: AnswerDraftOptions,
): Result<Answer> {
  const category = deriveAnswerCategory(question);
  const sensitive =
    category === 'eeo' || looksSensitiveLabel(question.label) || looksEeoLabel(question.label);
  const answer: Answer = {
    id: question.id,
    label: question.label,
    aliases: [],
    type: question.type,
    value,
    options: question.options
      ? Object.fromEntries(question.options.map((option) => [option.label, option.value]))
      : undefined,
    category,
    // A sensitive answer is only auto-submittable after the explicit opt-in.
    autoSubmitAllowed:
      options.autoSubmitAllowed ?? (sensitive ? options.allowSensitiveAutoSubmit : true),
    sensitive,
    updatedAt: Date.now(),
  };
  const parsed = parseAnswer(answer);
  if (!parsed.ok) return err(parsed.error);
  if (question.required && (value === null || value === undefined || value === '')) {
    return err(appError('INVALID_INPUT', `“${question.label}” needs an answer before continuing.`));
  }
  return ok(parsed.value);
}

/**
 * A stored `sensitive: false` flag is never trusted over the label itself.
 * Imports and older answers may carry stale metadata; the shared heuristic
 * keeps the answer bank honest at the boundary where it is saved or imported.
 */
export function normalizeAnswerSafety<T extends Answer>(answer: T): T {
  const sensitive =
    answer.sensitive || looksSensitiveLabel(answer.label) || looksEeoLabel(answer.label);
  const category =
    answer.category && answer.category !== 'custom'
      ? answer.category
      : deriveCategoryFromLabel(answer.label);
  return { ...answer, sensitive, category };
}
