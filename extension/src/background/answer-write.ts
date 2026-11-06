/**
 * Background handler for AI-written answers, the step after the answer bank.
 *
 * Fail-closed: the setting, a usable key/model and the OpenRouter permission
 * must all be present. Sensitive, EEO and personal-fact questions are vetoed
 * before any call and never reach the model; free-text questions also need the
 * free-text switch. The model receives the job posting and the applicant's
 * NON-sensitive saved answers as facts. Sensitive answers never leave the
 * device. Events record counts, model and cost; the written answers are kept
 * only in this device's Activity.
 */
import type { Answer, EventLevel, JobEvent } from '@/core/contracts';
import type { AnswerWriteRequest, AnswerWriteResult } from '@/core/contracts/answerWrite';
import { looksEeoLabel, looksSensitiveLabel } from '@/core/answers/answerDraft';
import { aiMayWrite } from '@/core/answers/policy';
import { log } from '@/core/logging/logger';
import { listAnswers } from '@/core/storage/answers';
import { setMeta } from '@/core/storage/db';
import { getJob } from '@/core/storage/jobs';
import { loadAiKeys, loadSettings } from '@/core/storage/settings';
import { ANSWER_WRITE_MIN_CONFIDENCE, writeAnswers, type AnswerWriteFact } from '@/ai/answer-write';
import { hasOpenRouterHostPermission } from '@/ai/permissions';

export const ANSWER_WRITE_REQUEST_TIMEOUT_MS = 20_000;
export const ANSWER_WRITE_MAX_FACTS = 30;

export type AnswerWriteEmit = (event: JobEvent) => void;

export interface RunAnswerWriteOptions {
  emit?: AnswerWriteEmit;
  write?: typeof writeAnswers;
  hasPermission?: () => Promise<boolean>;
  answers?: () => Promise<Answer[]>;
}

function displayValue(answer: Answer): string | undefined {
  const value = answer.value;
  if (value === null || value === undefined) return undefined;
  const label = (raw: string) =>
    Object.entries(answer.options ?? {}).find(([, optionValue]) => optionValue === raw)?.[0] ?? raw;
  if (Array.isArray(value)) return value.length > 0 ? value.map(label).join(', ') : undefined;
  const text = typeof value === 'string' ? label(value).trim() : String(value);
  return text || undefined;
}

/** Saved answers that may be described to the model: never sensitive or EEO ones. */
export function shareableFacts(answers: readonly Answer[]): AnswerWriteFact[] {
  return answers
    .filter(
      (answer) =>
        !answer.sensitive &&
        answer.category !== 'eeo' &&
        !looksSensitiveLabel(answer.label) &&
        !looksEeoLabel(answer.label),
    )
    .flatMap((answer) => {
      const value = displayValue(answer);
      return value ? [{ label: answer.label, value }] : [];
    })
    .slice(0, ANSWER_WRITE_MAX_FACTS);
}

async function emitWrite(
  level: EventLevel,
  type: 'answer_write.ai' | 'answer_write.none' | 'answer_write.error',
  message: string,
  jobId: string,
  data: Record<string, unknown>,
  emit?: AnswerWriteEmit,
): Promise<void> {
  try {
    const event = await log(level, type, message, { jobId, data });
    emit?.(event);
  } catch {
    // Diagnostics must never break the application path.
  }
}

/** Resolves a write request. Never throws; any failure writes nothing. */
export async function runAnswerWrite(
  request: AnswerWriteRequest,
  options: RunAnswerWriteOptions = {},
): Promise<AnswerWriteResult[]> {
  try {
    const settings = await loadSettings();
    if (!settings.ai.enabled || !settings.ai.answerWrite) return [];
    const questions = request.questions.filter((question) =>
      aiMayWrite(question, settings.safety.allowFreeTextAutoFill),
    );
    if (questions.length === 0) return [];
    const model = settings.ai.openRouter.model;
    const apiKey = (await loadAiKeys()).openRouterApiKey?.trim();
    if (!model || !apiKey) return [];
    if (!(await (options.hasPermission ?? hasOpenRouterHostPermission)())) return [];
    const job = await getJob(request.jobId);
    if (!job) return [];

    const facts = shareableFacts(await (options.answers ?? listAnswers)());
    const selection = await (options.write ?? writeAnswers)(
      {
        questions,
        job: { title: job.title, employer: job.employer, description: job.description },
        facts,
      },
      { apiKey, settings: settings.ai.openRouter, timeoutMs: ANSWER_WRITE_REQUEST_TIMEOUT_MS },
    );
    const results: AnswerWriteResult[] = [];
    for (const written of selection.answers) {
      const question = questions.find((entry) => entry.id === written.questionId);
      if (!question || written.confidence < ANSWER_WRITE_MIN_CONFIDENCE) continue;
      const option = question.options?.find((entry) => entry.label === written.answer);
      if (question.options?.length && !option) continue;
      results.push({
        questionId: question.id,
        value: option ? option.value : written.answer,
        basis: written.basis,
        confidence: written.confidence,
      });
    }
    const cost = selection.costUsd === undefined ? {} : { cost: selection.costUsd };
    if (results.length === 0) {
      await emitWrite(
        'info',
        'answer_write.none',
        'AI could not answer these questions from the job or your saved answers',
        request.jobId,
        { questions: questions.length, written: 0, model: selection.model, ...cost },
        options.emit,
      );
      return [];
    }
    // The user's own record of what was written for this application.
    const record = results.map((result) => ({
      label: questions.find((question) => question.id === result.questionId)?.label ?? '',
      answer: String(
        questions
          .find((question) => question.id === result.questionId)
          ?.options?.find((option) => option.value === result.value)?.label ?? result.value,
      ),
      basis: result.basis,
    }));
    await setMeta(`aiAnswers:${request.jobId}`, record).catch(() => undefined);
    await emitWrite(
      'info',
      'answer_write.ai',
      `AI answered: ${record
        .map((entry) => `“${entry.label}” → ${entry.answer.slice(0, 120)}`)
        .join('; ')}`.slice(0, 1_000),
      request.jobId,
      { questions: questions.length, written: results.length, model: selection.model, ...cost },
      options.emit,
    );
    return results;
  } catch {
    await emitWrite(
      'warn',
      'answer_write.error',
      'AI answer writing failed',
      request.jobId,
      { questions: request.questions.length, written: 0 },
      options.emit,
    );
    return [];
  }
}
