import type { Answer, ApplyOptions, QuestionDescriptor } from '@/core/contracts';
import {
  isStructuredFieldLabel,
  looksEeoLabel,
  looksPersonalFactLabel,
  looksSensitiveLabel,
} from './answerDraft';

export type AnswerSafetyOptions = Pick<
  ApplyOptions,
  'allowSensitiveAutoSubmit' | 'allowEeoAutoFill' | 'allowFreeTextAutoFill'
>;

export function requiresFreeText(question: Pick<QuestionDescriptor, 'label' | 'type'>): boolean {
  return (
    (question.type === 'text' || question.type === 'textarea') &&
    !isStructuredFieldLabel(question.label)
  );
}

/**
 * Per-answer permission and every applicable global opt-in must allow submission.
 * Explicit per-job answers may fill for review, but never bypass this policy.
 */
export function answerApprovalReason(
  answer: Answer,
  options: AnswerSafetyOptions,
  question: Pick<QuestionDescriptor, 'label' | 'type' | 'section'> = answer,
): string | undefined {
  if (!answer.autoSubmitAllowed) return 'This answer needs your approval for autopilot';
  const label = `${question.section ?? ''} ${question.label}`;
  const eeo = answer.category === 'eeo' || looksEeoLabel(label) || looksEeoLabel(answer.label);
  const sensitive =
    eeo || answer.sensitive || looksSensitiveLabel(label) || looksSensitiveLabel(answer.label);
  if (eeo && !options.allowEeoAutoFill) return 'EEO answers need the global EEO opt-in';
  if (sensitive && !options.allowSensitiveAutoSubmit) {
    return 'Sensitive answers need the global sensitive-answer opt-in';
  }
  if (requiresFreeText(question) && !options.allowFreeTextAutoFill) {
    return 'Free-text answers need the global free-text opt-in';
  }
  return undefined;
}

/** Question types AI may write: text, or one choice. Dates and numbers are facts. */
const AI_WRITABLE_TYPES: ReadonlySet<QuestionDescriptor['type']> = new Set([
  'text',
  'textarea',
  'select',
  'radio',
  'combobox',
]);

/**
 * True when AI may attempt to write this question at all. Sensitive, EEO and
 * personal-fact questions never qualify: only a saved answer or the user can
 * answer them. Free-text questions also need the free-text switch.
 */
export function aiMayWrite(
  question: Pick<QuestionDescriptor, 'label' | 'type' | 'section'>,
  allowFreeText: boolean,
): boolean {
  const label = `${question.section ?? ''} ${question.label}`;
  if (!AI_WRITABLE_TYPES.has(question.type)) return false;
  if (looksSensitiveLabel(label) || looksEeoLabel(label) || looksPersonalFactLabel(label))
    return false;
  return allowFreeText || !requiresFreeText(question);
}
