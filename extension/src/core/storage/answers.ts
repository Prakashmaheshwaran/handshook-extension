import { DB_STORES, type Answer } from '@/core/contracts';
import { normalizeAnswerSafety } from '@/core/answers/answerDraft';
import {
  ANSWERS_DEFAULTS_KEY,
  ANSWERS_DEFAULTS_REVISION,
  getDb,
  getMeta,
  setMeta,
} from '@/core/storage/db';

export { ANSWERS_DEFAULTS_KEY, ANSWERS_DEFAULTS_REVISION };

function hasValue(answer: Answer): boolean {
  const value = answer.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Revision 1, applied once: full automation uses the answers the user entered.
 * Saved answers with a value that were left not-automatic (the old setup
 * default, which offered no switch for non-sensitive answers) become automatic.
 * Blank answers are untouched, sensitive and EEO answers still need their
 * global switches, and later edits in Settings keep the user's choice.
 */
async function upgradeAnswerDefaults(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([DB_STORES.answers, DB_STORES.meta], 'readwrite');
  const meta = tx.objectStore(DB_STORES.meta);
  const revision = (await meta.get(ANSWERS_DEFAULTS_KEY))?.value;
  if (typeof revision === 'number' && revision >= ANSWERS_DEFAULTS_REVISION) {
    await tx.done;
    return;
  }
  const store = tx.objectStore(DB_STORES.answers);
  for (const answer of await store.getAll()) {
    if (!answer.autoSubmitAllowed && hasValue(answer)) {
      await store.put({ ...answer, autoSubmitAllowed: true });
    }
  }
  await meta.put({ key: ANSWERS_DEFAULTS_KEY, value: ANSWERS_DEFAULTS_REVISION });
  await tx.done;
}

export async function listAnswers(): Promise<Answer[]> {
  await upgradeAnswerDefaults();
  const db = await getDb();
  const all = await db.getAllFromIndex(DB_STORES.answers, 'byUpdatedAt');
  return all.reverse();
}

export async function saveAnswer(answer: Answer): Promise<Answer> {
  const db = await getDb();
  // M9: the label is authoritative for sensitivity/category at every write.
  const next = { ...normalizeAnswerSafety(answer), updatedAt: Date.now() };
  await db.put(DB_STORES.answers, next);
  return next;
}

export async function deleteAnswer(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(DB_STORES.answers, id);
}

export const DEFAULT_ANSWERS: Answer[] = [
  {
    id: 'work_authorization',
    label: 'Are you legally authorized to work in the United States?',
    aliases: ['legally authorized', 'work authorization', 'authorized to work', 'eligible to work'],
    type: 'radio',
    value: null,
    options: { yes: 'true', no: 'false' },
    category: 'work',
    autoSubmitAllowed: true,
    sensitive: true,
    updatedAt: 0,
  },
  {
    id: 'visa_sponsorship',
    label: 'Will you now or in the future require visa sponsorship?',
    aliases: ['require sponsorship', 'visa sponsorship', 'sponsorship', 'immigration sponsorship'],
    type: 'radio',
    value: null,
    options: { yes: 'true', no: 'false' },
    category: 'work',
    autoSubmitAllowed: true,
    sensitive: true,
    updatedAt: 0,
  },
  {
    id: 'graduation_date',
    label: 'Graduation date',
    aliases: ['anticipated graduation', 'expected graduation', 'graduation year', 'degree date'],
    type: 'date',
    value: null,
    category: 'education',
    autoSubmitAllowed: true,
    sensitive: false,
    updatedAt: 0,
  },
  {
    id: 'gpa',
    label: 'Cumulative GPA',
    aliases: ['gpa', 'grade point average'],
    type: 'number',
    value: null,
    category: 'education',
    autoSubmitAllowed: true,
    sensitive: false,
    updatedAt: 0,
  },
  {
    id: 'preferred_location',
    label: 'Preferred location',
    aliases: ['location preference', 'preferred location', 'where are you located'],
    type: 'text',
    value: null,
    category: 'preferences',
    autoSubmitAllowed: true,
    sensitive: false,
    updatedAt: 0,
  },
];

export async function listJobAnswers(jobId: string): Promise<Answer[]> {
  return (await getMeta<Answer[]>(`jobAnswers:${jobId}`)) ?? [];
}

export async function saveJobAnswerOverride(jobId: string, answer: Answer): Promise<void> {
  const current = await listJobAnswers(jobId);
  const next = [...current.filter((entry) => entry.id !== answer.id), answer];
  await setMeta(`jobAnswers:${jobId}`, next);
}

/**
 * Apply a reusable-bank edit/delete to every same-id per-job override.
 *
 * A remembered Needs You answer is intentionally stored both in the bank and as
 * a per-job override. Without this sync an older override would shadow a later
 * Settings edit forever (and could auto-submit a stale sensitive value).
 */
export async function syncBankAnswerToJobOverrides(
  answerId: string,
  answer: Answer | null,
): Promise<number> {
  const db = await getDb();
  const entries = await db.getAll(DB_STORES.meta);
  const tx = db.transaction(DB_STORES.meta, 'readwrite');
  let changed = 0;
  for (const entry of entries) {
    if (typeof entry.key !== 'string' || !entry.key.startsWith('jobAnswers:')) continue;
    const overrides = entry.value as Answer[] | undefined;
    if (!Array.isArray(overrides) || !overrides.some((item) => item.id === answerId)) continue;
    const next = answer
      ? overrides.map((item) => (item.id === answerId ? { ...answer } : item))
      : overrides.filter((item) => item.id !== answerId);
    await tx.store.put({ key: entry.key, value: next });
    changed += 1;
  }
  await tx.done;
  return changed;
}
