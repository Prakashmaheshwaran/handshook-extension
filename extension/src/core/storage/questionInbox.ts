import type { Answer, InboxQuestion, QuestionDescriptor } from '@/core/contracts';
import { getMeta, setMeta } from '@/core/storage/db';
import { listAnswers } from '@/core/storage/answers';
import { normalizeText } from '@/handshake/text';

/**
 * Questions Handshook met on application forms and could not answer from the
 * answer bank. The user answers each one once in Settings → Answers; the saved
 * answer then fills every later form that asks it, and waiting jobs are
 * released. Only the form's own question text and choices are stored.
 */
export const QUESTION_INBOX_KEY = 'questionInbox';
export const QUESTION_INBOX_MAX = 200;
const MAX_JOB_IDS = 5;

export type { InboxQuestion };

interface InboxState {
  entries: InboxQuestion[];
  dismissed: string[];
}

export function inboxKey(question: Pick<QuestionDescriptor, 'label' | 'type'>): string {
  return `${question.type}|${normalizeText(question.label)}`;
}

function hasValue(answer: Answer): boolean {
  const value = answer.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Normalized labels and aliases of saved answers that have a value. */
export function answeredLabels(answers: readonly Answer[]): Set<string> {
  const labels = new Set<string>();
  for (const answer of answers) {
    if (!hasValue(answer)) continue;
    for (const label of [answer.label, ...answer.aliases]) {
      const normalized = normalizeText(label);
      if (normalized) labels.add(normalized);
    }
  }
  return labels;
}

async function readState(): Promise<InboxState> {
  const stored = await getMeta<Partial<InboxState>>(QUESTION_INBOX_KEY);
  return {
    entries: Array.isArray(stored?.entries) ? stored.entries : [],
    dismissed: Array.isArray(stored?.dismissed) ? stored.dismissed : [],
  };
}

/**
 * Adds the questions a form asked that no saved answer covers. Questions the
 * user dismissed, unlabelled or unknown-type controls, and wording already in
 * the bank are skipped. Never throws: the inbox is a convenience.
 */
export async function recordInboxQuestions(
  questions: readonly QuestionDescriptor[],
  jobId: string,
  source: InboxQuestion['source'] = 'run',
  at = Date.now(),
): Promise<void> {
  try {
    if (questions.length === 0) return;
    const [state, answers] = await Promise.all([readState(), listAnswers()]);
    const answered = answeredLabels(answers);
    const dismissed = new Set(state.dismissed);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry]));
    let changed = false;
    for (const question of questions) {
      const label = normalizeText(question.label);
      if (!label || question.type === 'unknown' || answered.has(label)) continue;
      const key = inboxKey(question);
      if (dismissed.has(key)) continue;
      const existing = byKey.get(key);
      byKey.set(key, {
        key,
        label: question.label,
        type: question.type,
        required: (existing?.required ?? false) || question.required,
        ...(question.options?.length ? { options: question.options } : {}),
        ...(question.section ? { section: question.section } : {}),
        source: existing?.source === 'run' ? 'run' : source,
        firstSeenAt: existing?.firstSeenAt ?? at,
        lastSeenAt: at,
        seenCount: (existing?.seenCount ?? 0) + 1,
        jobIds: [jobId, ...(existing?.jobIds ?? []).filter((id) => id !== jobId)].slice(
          0,
          MAX_JOB_IDS,
        ),
      });
      changed = true;
    }
    if (!changed) return;
    const entries = [...byKey.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, QUESTION_INBOX_MAX);
    await setMeta(QUESTION_INBOX_KEY, { ...state, entries });
  } catch {
    // Collecting questions must never break an application run.
  }
}

/** Unanswered, undismissed questions: most often asked and required first. */
export async function listInboxQuestions(): Promise<InboxQuestion[]> {
  const [state, answers] = await Promise.all([readState(), listAnswers()]);
  const answered = answeredLabels(answers);
  const dismissed = new Set(state.dismissed);
  return state.entries
    .filter((entry) => !dismissed.has(entry.key) && !answered.has(normalizeText(entry.label)))
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        b.seenCount - a.seenCount ||
        b.lastSeenAt - a.lastSeenAt,
    );
}

/** "Don't ask again": the question stays out of the inbox until data is reset. */
export async function dismissInboxQuestion(key: string): Promise<void> {
  const state = await readState();
  await setMeta(QUESTION_INBOX_KEY, {
    entries: state.entries.filter((entry) => entry.key !== key),
    dismissed: [...new Set([key, ...state.dismissed])].slice(0, QUESTION_INBOX_MAX),
  });
}
