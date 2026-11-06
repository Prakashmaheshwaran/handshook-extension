import type { Answer, AnswerMatch, AnswerValue, QuestionDescriptor } from '@/core/contracts';
import { answerApprovalReason } from '@/core/answers/policy';
import { normalizeText } from '@/handshake/text';

export { requiresFreeText } from '@/core/answers/policy';

export interface MatchOptions {
  allowFreeText?: boolean;
  allowSensitive?: boolean;
  /** EEO/self-identification answers need their own opt-in. */
  allowEeo?: boolean;
  /**
   * Answers the user explicitly supplied for this job/question. They are
   * approved to fill (the user already made the choice) but not necessarily to
   * auto-submit; the caller gates submission separately.
   */
  explicitAnswerIds?: ReadonlySet<string>;
  threshold?: number;
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function overlap(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i]![0] = i;
  for (let j = 0; j < cols; j += 1) dp[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

function similarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const edit = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  return Math.max(overlap(left, right), edit * 0.85);
}

/** Resolve an option once; the filler consumes only the resulting DOM value. */
function optionValue(
  question: QuestionDescriptor,
  answer: Answer,
  raw: string,
): string | undefined {
  const normalized = normalizeText(raw);
  if (!normalized) return undefined;
  const mapped = Object.entries(answer.options ?? {}).find(
    ([label]) => normalizeText(label) === normalized,
  )?.[1];
  const needles = [
    mapped,
    raw,
    normalized === 'true' ? 'yes' : normalized === 'false' ? 'no' : raw,
  ];
  for (const needle of needles) {
    if (!needle) continue;
    const options = question.options ?? [];
    const byValue = options.filter((option) => option.value.toLowerCase() === needle.toLowerCase());
    if (byValue.length === 1) return byValue[0]?.value;
    if (byValue.length > 1) return undefined;
    const target = normalizeText(needle);
    const exact = options.filter((option) => normalizeText(option.label) === target);
    if (exact.length === 1) return exact[0]?.value;
    if (exact.length > 1) return undefined;
    const partial = options.filter((option) =>
      ` ${normalizeText(option.label)} `.includes(` ${target} `),
    );
    if (partial.length === 1) return partial[0]?.value;
    if (partial.length > 1) return undefined;
  }
  return numericRangeOption(question, raw);
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const RANGE = new RegExp(String.raw`${NUMBER}\s*(?:-|–|—|to)\s*${NUMBER}`, 'i');
const AT_LEAST = new RegExp(
  String.raw`(?:${NUMBER}\s*(?:\+|or (?:above|higher|more|greater))|(?:above|over|at least|minimum)\s*${NUMBER})`,
  'i',
);
const BELOW = new RegExp(String.raw`(?:below|under|less than)\s*${NUMBER}`, 'i');

/**
 * A saved number (e.g. a GPA of 3.8) picks the one option whose label is a
 * range containing it ("3.5 - 4.0", "3.5+", "Below 3.0"). Ambiguity resolves
 * to nothing, so the question waits for the user instead of guessing.
 */
function numericRangeOption(question: QuestionDescriptor, raw: string): string | undefined {
  const text = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  const fits = (question.options ?? []).filter((option) => {
    const label = option.label;
    const range = RANGE.exec(label);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      return number >= Math.min(low, high) && number <= Math.max(low, high);
    }
    const atLeast = AT_LEAST.exec(label);
    if (atLeast) return number >= Number(atLeast[1] ?? atLeast[2]);
    const below = BELOW.exec(label);
    if (below) return number < Number(below[1]);
    return false;
  });
  return fits.length === 1 ? fits[0]?.value : undefined;
}

function isBlank(value: AnswerValue): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function resolvedValue(question: QuestionDescriptor, answer: Answer): AnswerValue | undefined {
  const value = answer.value;
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return undefined;
  }
  if (question.type === 'checkbox') {
    if (typeof value === 'boolean' && question.options?.length === 1) {
      const option = question.options[0];
      return value && option ? [option.value] : question.required ? undefined : [];
    }
    if (!Array.isArray(value) || (question.required && value.length === 0)) return undefined;
    const values = value.map((entry) => optionValue(question, answer, String(entry)));
    return values.every((entry): entry is string => entry !== undefined) ? values : undefined;
  }
  if (question.type === 'radio' || question.type === 'select' || question.type === 'combobox') {
    if (Array.isArray(value)) return undefined;
    const raw = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
    return optionValue(question, answer, raw);
  }
  return question.type === 'unknown' || Array.isArray(value) ? undefined : value;
}

export function matchAnswer(
  question: QuestionDescriptor,
  answers: Answer[],
  options: MatchOptions = {},
): AnswerMatch {
  const threshold = options.threshold ?? 0.6;
  const target = normalizeText(question.label);
  const scored = answers
    .map((answer) => {
      const labels = [answer.label, ...answer.aliases].map((label) => normalizeText(label));
      const score = Math.max(...labels.map((label) => similarity(target, label)));
      // Approval for one job question must not spread via fuzzy aliases to another.
      const explicit =
        (options.explicitAnswerIds?.has(answer.id) ?? false) &&
        (answer.id === question.id || normalizeText(answer.label) === target);
      return { answer, score: explicit && answer.id === question.id ? 2 : score, explicit };
    })
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || Number(b.explicit) - Number(a.explicit));
  // A blank saved answer cannot fill anything; it must not tie with one that has a
  // value. An answer whose value does not fit the choices still counts, so a
  // weaker match never replaces an exact one.
  const filled = scored.filter((entry) => !isBlank(entry.answer.value));
  const candidates = filled.length > 0 ? filled : scored;
  const best = candidates[0];
  const tied = candidates[1];
  if (!best || (tied && best.score === tied.score && best.explicit === tied.explicit)) {
    return {
      questionId: question.id,
      confidence: Math.min(1, best?.score ?? 0),
      source: 'none',
      reason: best
        ? 'Multiple answers match this question; choose an answer'
        : 'No matching answer',
    };
  }
  // Select before checking approval: an unapproved exact match must never fall
  // back to a weaker, approved answer with a different value.
  const approvalReason = answerApprovalReason(
    best.answer,
    {
      allowFreeTextAutoFill: options.allowFreeText ?? false,
      allowSensitiveAutoSubmit: options.allowSensitive ?? false,
      allowEeoAutoFill: options.allowEeo ?? false,
    },
    question,
  );
  const value = resolvedValue(question, best.answer);
  if ((!best.explicit && approvalReason) || value === undefined) {
    return {
      questionId: question.id,
      answerId: best.answer.id,
      value,
      confidence: Math.min(1, best.score),
      source: 'none',
      reason: approvalReason ?? 'Answer has no usable value or matches ambiguous options',
    };
  }
  return {
    questionId: question.id,
    answerId: best.answer.id,
    value,
    confidence: Math.min(1, best.score),
    source: best.explicit ? 'job' : 'bank',
    reason: approvalReason ?? 'Matched',
  };
}

/**
 * Uses one saved answer chosen outside the label matcher (AI answer assist or a
 * learned mapping). The same approval and option checks as `matchAnswer` run,
 * so a choice can only fill the user's own saved value, never a new one.
 */
export function matchChosenAnswer(
  question: QuestionDescriptor,
  answer: Answer,
  confidence: number,
  options: MatchOptions = {},
): AnswerMatch {
  const approvalReason = answerApprovalReason(
    answer,
    {
      allowFreeTextAutoFill: options.allowFreeText ?? false,
      allowSensitiveAutoSubmit: options.allowSensitive ?? false,
      allowEeoAutoFill: options.allowEeo ?? false,
    },
    question,
  );
  const value = resolvedValue(question, answer);
  const clamped = Math.max(0, Math.min(1, confidence));
  if (approvalReason || value === undefined) {
    return {
      questionId: question.id,
      answerId: answer.id,
      value,
      confidence: clamped,
      source: 'none',
      reason: approvalReason ?? 'Saved answer does not fit this question’s choices',
    };
  }
  return {
    questionId: question.id,
    answerId: answer.id,
    value,
    confidence: clamped,
    source: 'bank',
    reason: 'Matched by AI to a saved answer',
  };
}

/** True when the saved answer has a value this question can actually use. */
export function answerFitsQuestion(question: QuestionDescriptor, answer: Answer): boolean {
  return resolvedValue(question, answer) !== undefined;
}

export function matchAllAnswers(
  questions: QuestionDescriptor[],
  answers: Answer[],
  options: MatchOptions = {},
): AnswerMatch[] {
  return questions.map((question) =>
    questions.filter((entry) => entry.id === question.id).length > 1
      ? {
          questionId: question.id,
          confidence: 0,
          source: 'none',
          reason: 'Question identity is ambiguous',
        }
      : matchAnswer(question, answers, options),
  );
}
