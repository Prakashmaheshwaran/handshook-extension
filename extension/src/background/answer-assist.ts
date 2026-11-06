/**
 * Background handler for AI answer assist.
 *
 * Gate order is fail-closed: the setting, a usable key/model, and the explicit
 * OpenRouter permission must all be present. The saved answers come from this
 * worker's own storage, never from the content script, and only their ids,
 * labels, aliases, types and categories are described to the model. A learned
 * mapping is tried before any network call. Events carry only counts,
 * confidence, model and cost — never question or answer text.
 */
import { z } from 'zod';
import type { Answer, EventLevel, JobEvent, QuestionDescriptor } from '@/core/contracts';
import type {
  AnswerAssistMatch,
  AnswerAssistQuestion,
  AnswerAssistRequest,
} from '@/core/contracts/answerAssist';
import { looksEeoLabel, looksSensitiveLabel } from '@/core/answers/answerDraft';
import { log } from '@/core/logging/logger';
import { listAnswers } from '@/core/storage/answers';
import { getMeta, setMeta } from '@/core/storage/db';
import { loadAiKeys, loadSettings } from '@/core/storage/settings';
import { answerFitsQuestion } from '@/handshake/answerMatcher';
import { normalizeText } from '@/handshake/text';
import {
  ANSWER_ASSIST_MIN_CONFIDENCE,
  ANSWER_ASSIST_SENSITIVE_MIN_CONFIDENCE,
  chooseAnswerMappings,
} from '@/ai/answer-assist';
import { hasOpenRouterHostPermission } from '@/ai/permissions';

/** Leave headroom inside the content script's 25 s fallback timeout. */
export const ANSWER_ASSIST_REQUEST_TIMEOUT_MS = 20_000;
/** Most recent question→answer mappings kept locally, so repeats need no AI. */
export const ANSWER_ASSIST_MAX_LEARNED = 200;
export const ANSWER_ASSIST_LEARNED_KEY = 'answerAssist.learned';

const learnedSchema = z
  .array(z.object({ key: z.string().min(1).max(400), answerId: z.string().min(1).max(200) }))
  .max(ANSWER_ASSIST_MAX_LEARNED);

type Learned = z.infer<typeof learnedSchema>;

const MESSAGES = {
  'answer_assist.learned': 'Answer assist reused saved-answer mappings',
  'answer_assist.ai': 'Answer assist matched questions to saved answers',
  'answer_assist.none': 'Answer assist found no saved answer for these questions',
  'answer_assist.error': 'Answer assist failed',
} as const;

type AnswerAssistEventType = keyof typeof MESSAGES;

interface AnswerAssistEventData {
  questions: number;
  mapped: number;
  model?: string;
  cost?: number;
}

export type AnswerAssistEmit = (event: JobEvent) => void;

export interface RunAnswerAssistOptions {
  emit?: AnswerAssistEmit;
  choose?: typeof chooseAnswerMappings;
  hasPermission?: () => Promise<boolean>;
  answers?: () => Promise<Answer[]>;
}

/** The same question wording and type maps to the same saved answer next time. */
export function answerAssistLearnedKey(question: Pick<AnswerAssistQuestion, 'label' | 'type'>) {
  return `${question.type}|${normalizeText(question.label)}`;
}

function hasValue(answer: Answer): boolean {
  const value = answer.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function descriptor(question: AnswerAssistQuestion): QuestionDescriptor {
  return {
    id: question.id,
    label: question.label,
    type: question.type,
    required: question.required,
    ...(question.section ? { section: question.section } : {}),
    ...(question.options ? { options: question.options } : {}),
    fingerprint: '',
  };
}

function isSensitive(question: AnswerAssistQuestion, answer: Answer): boolean {
  const label = `${question.section ?? ''} ${question.label}`;
  return (
    answer.sensitive ||
    answer.category === 'eeo' ||
    looksSensitiveLabel(label) ||
    looksEeoLabel(label)
  );
}

async function readLearned(): Promise<Learned> {
  try {
    const parsed = learnedSchema.safeParse(await getMeta(ANSWER_ASSIST_LEARNED_KEY));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

async function remember(present: Learned, additions: Learned): Promise<void> {
  if (additions.length === 0) return;
  const keys = new Set(additions.map((entry) => entry.key));
  const next = [...additions, ...present.filter((entry) => !keys.has(entry.key))].slice(
    0,
    ANSWER_ASSIST_MAX_LEARNED,
  );
  try {
    await setMeta(ANSWER_ASSIST_LEARNED_KEY, next);
  } catch {
    // Learning is an optimisation; storage failures must not break the apply.
  }
}

async function emitAnswerAssist(
  level: EventLevel,
  type: AnswerAssistEventType,
  jobId: string,
  data: AnswerAssistEventData,
  emit?: AnswerAssistEmit,
): Promise<void> {
  try {
    const event = await log(level, type, MESSAGES[type], { jobId, data: { ...data } });
    emit?.(event);
  } catch {
    // Diagnostics must never break the application path.
  }
}

/**
 * Resolves an answer-assist request. Always returns one entry per question and
 * never throws: any failure degrades to `answerId: null, source: 'none'`.
 */
export async function runAnswerAssist(
  request: AnswerAssistRequest,
  options: RunAnswerAssistOptions = {},
): Promise<AnswerAssistMatch[]> {
  const results = new Map<string, AnswerAssistMatch>(
    request.questions.map((question) => [
      question.id,
      { questionId: question.id, answerId: null, source: 'none', confidence: 0 },
    ]),
  );
  const finish = () => request.questions.map((question) => results.get(question.id)!);
  const count = { questions: request.questions.length };
  try {
    const settings = await loadSettings();
    if (!settings.ai.enabled || !settings.ai.answerAssist) return finish();
    const bank = (await (options.answers ?? listAnswers)()).filter(hasValue);
    if (bank.length === 0) return finish();
    const byId = new Map(bank.map((answer) => [answer.id, answer]));
    const usable = (question: AnswerAssistQuestion, answerId: string | null) => {
      const answer = answerId ? byId.get(answerId) : undefined;
      return answer && answerFitsQuestion(descriptor(question), answer) ? answer : undefined;
    };

    // Learned mappings are local; only a model call needs a key and permission.
    const learned = await readLearned();
    const learnedByKey = new Map(learned.map((entry) => [entry.key, entry.answerId]));
    let learnedHits = 0;
    const pending: AnswerAssistQuestion[] = [];
    for (const question of request.questions) {
      const answer = usable(question, learnedByKey.get(answerAssistLearnedKey(question)) ?? null);
      if (answer) {
        results.set(question.id, {
          questionId: question.id,
          answerId: answer.id,
          source: 'learned',
          confidence: 1,
        });
        learnedHits += 1;
      } else {
        pending.push(question);
      }
    }
    if (learnedHits > 0) {
      await emitAnswerAssist(
        'info',
        'answer_assist.learned',
        request.jobId,
        { ...count, mapped: learnedHits },
        options.emit,
      );
    }
    if (pending.length === 0) return finish();

    const model = settings.ai.openRouter.model;
    const apiKey = (await loadAiKeys()).openRouterApiKey?.trim();
    if (!model || !apiKey) return finish();
    if (!(await (options.hasPermission ?? hasOpenRouterHostPermission)())) return finish();

    const choose = options.choose ?? chooseAnswerMappings;
    const selection = await choose(
      {
        questions: pending,
        answers: bank.map((answer) => ({
          id: answer.id,
          label: answer.label,
          aliases: answer.aliases,
          type: answer.type,
          ...(answer.category ? { category: answer.category } : {}),
        })),
      },
      { apiKey, settings: settings.ai.openRouter, timeoutMs: ANSWER_ASSIST_REQUEST_TIMEOUT_MS },
    );
    const additions: Learned = [];
    for (const match of selection.matches) {
      const question = pending.find((entry) => entry.id === match.questionId);
      if (!question) continue;
      const answer = usable(question, match.answerId);
      if (!answer) continue;
      const floor = isSensitive(question, answer)
        ? ANSWER_ASSIST_SENSITIVE_MIN_CONFIDENCE
        : ANSWER_ASSIST_MIN_CONFIDENCE;
      if (match.confidence < floor) continue;
      results.set(question.id, {
        questionId: question.id,
        answerId: answer.id,
        source: 'ai',
        confidence: match.confidence,
      });
      additions.push({ key: answerAssistLearnedKey(question), answerId: answer.id });
    }
    await remember(learned, additions);
    await emitAnswerAssist(
      'info',
      additions.length > 0 ? 'answer_assist.ai' : 'answer_assist.none',
      request.jobId,
      {
        ...count,
        mapped: additions.length,
        model: selection.model,
        ...(selection.costUsd === undefined ? {} : { cost: selection.costUsd }),
      },
      options.emit,
    );
    return finish();
  } catch {
    await emitAnswerAssist(
      'warn',
      'answer_assist.error',
      request.jobId,
      { ...count, mapped: 0 },
      options.emit,
    );
    // Learned mappings found before the failure are still the user's own choices.
    return finish();
  }
}
