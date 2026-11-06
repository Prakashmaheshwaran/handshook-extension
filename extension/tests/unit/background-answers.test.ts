import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Answer,
  type QuestionDescriptor,
} from '@/core/contracts';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getQueueItem, putQueueItem } from '@/core/orchestrator/queue';
import { getMeta, resetDb, setMeta } from '@/core/storage/db';
import { listAnswers, listJobAnswers } from '@/core/storage/answers';
import { saveSettings } from '@/core/storage/settings';
import { makeEngineState, makeQuestion, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const JOB_ID = '900001';

interface StoredNeed {
  questions: QuestionDescriptor[];
  missingDocumentTypes: string[];
  reason: string;
}

async function seedNeed(
  questions: QuestionDescriptor[],
  missingDocumentTypes: string[] = [],
): Promise<void> {
  await putQueueItem(
    makeQueueItem({
      jobId: JOB_ID,
      status: 'needs_input',
      pendingQuestionIds: questions.map((question) => question.id),
      missingDocumentTypes: missingDocumentTypes as never,
    }),
  );
  await setMeta(`needs:${JOB_ID}`, { questions, missingDocumentTypes, reason: 'questions' });
}

async function answer(
  questionId: string,
  value: Answer['value'],
  remember = false,
): Promise<Awaited<ReturnType<typeof handleUi>>> {
  return handleUi({
    type: 'ui.job.answer',
    requestId: `answer-${questionId}`,
    jobId: JOB_ID,
    questionId,
    value,
    remember,
  });
}

beforeEach(async () => {
  const { fake } = createFakeBrowser();
  vi.stubGlobal('browser', fake);
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ui.job.answer — P0-1 keeps unanswered questions', () => {
  it('removes only the answered question and does not requeue or resume early', async () => {
    const resume = vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    const questions = [
      makeQuestion({ id: 'q1', label: 'Why this role?', required: true }, 1),
      makeQuestion({ id: 'q2', label: 'Preferred start date?', required: true }, 2),
    ];
    await seedNeed(questions);
    await putQueueItem(
      makeQueueItem({ jobId: JOB_ID, status: 'needs_input', attempts: 1, priority: 42 }),
    );

    const result = await answer('q1', 'Because I build things.');

    expect(result.ok).toBe(true);
    const stored = await getMeta<StoredNeed>(`needs:${JOB_ID}`);
    expect(stored?.questions.map((question) => question.id)).toEqual(['q2']);
    const item = await getQueueItem(JOB_ID);
    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestionIds).toEqual(['q2']);
    expect(item?.attempts).toBe(1);
    expect(item?.priority).toBe(42);
    expect(resume).not.toHaveBeenCalled();
  });

  it('clears the record, requeues, and resumes after the last question', async () => {
    const resume = vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    const questions = [
      makeQuestion({ id: 'q1', label: 'Why this role?', required: true }, 1),
      makeQuestion({ id: 'q2', label: 'Preferred start date?', required: true }, 2),
    ];
    await seedNeed(questions);

    await answer('q1', 'Because I build things.');
    await answer('q2', 'June 2027');

    expect(await getMeta(`needs:${JOB_ID}`)).toBeFalsy();
    const item = await getQueueItem(JOB_ID);
    expect(item?.status).toBe('queued');
    expect(item?.pendingQuestionIds).toEqual([]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing-document requirement even after every question is answered', async () => {
    const resume = vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([makeQuestion({ id: 'q1', label: 'Why this role?' }, 1)], ['transcript']);

    await answer('q1', 'Because I build things.');

    const stored = await getMeta<StoredNeed>(`needs:${JOB_ID}`);
    expect(stored?.questions).toEqual([]);
    expect(stored?.missingDocumentTypes).toEqual(['transcript']);
    expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
    expect(resume).not.toHaveBeenCalled();
  });

  it('rejects an answer to a question that is no longer pending', async () => {
    await seedNeed([makeQuestion({ id: 'q1', label: 'Why this role?' }, 1)]);

    const result = await answer('gone', 'x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('ui.job.answer — P0-2 derives real metadata and sensitivity', () => {
  it('uses the stored question for label/type/category and marks work authorization sensitive', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion(
        {
          id: 'authorized',
          label: 'Are you legally authorized to work in the United States?',
          type: 'radio',
          required: true,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        },
        1,
      ),
    ]);

    await answer('authorized', 'yes');

    const [saved] = await listJobAnswers(JOB_ID);
    expect(saved).toMatchObject({
      id: 'authorized',
      label: 'Are you legally authorized to work in the United States?',
      type: 'radio',
      category: 'work',
      sensitive: true,
      autoSubmitAllowed: true,
    });
  });

  it('keeps non-sensitive answers auto-submittable', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([makeQuestion({ id: 'why', label: 'Why this role?' }, 1)]);

    await answer('why', 'I like the mission.');

    const [saved] = await listJobAnswers(JOB_ID);
    expect(saved?.sensitive).toBe(false);
    expect(saved?.autoSubmitAllowed).toBe(true);
  });

  it('marks EEO questions as sensitive and eeo-category', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion(
        {
          id: 'veteran',
          label: 'Veteran status',
          section: 'EEO',
          type: 'select',
          required: true,
          options: [{ label: 'I am not a protected veteran', value: 'none' }],
        },
        1,
      ),
    ]);

    await answer('veteran', 'none');

    const [saved] = await listJobAnswers(JOB_ID);
    expect(saved?.category).toBe('eeo');
    expect(saved?.sensitive).toBe(true);
    expect(saved?.autoSubmitAllowed).toBe(true);
  });

  it('keeps a sensitive answer blocked when the explicit opt-in is off', async () => {
    await saveSettings(
      mergeSettings(DEFAULT_SETTINGS, { safety: { allowSensitiveAutoSubmit: false } }),
    );
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion(
        {
          id: 'veteran',
          label: 'Veteran status',
          section: 'EEO',
          type: 'select',
          required: true,
          options: [{ label: 'I am not a protected veteran', value: 'none' }],
        },
        1,
      ),
    ]);

    await answer('veteran', 'none');

    const [saved] = await listJobAnswers(JOB_ID);
    expect(saved?.sensitive).toBe(true);
    expect(saved?.autoSubmitAllowed).toBe(false);
  });

  it('also records a per-job override when the answer is remembered', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion(
        {
          id: 'authorized',
          label: 'Are you legally authorized to work in the United States?',
          type: 'radio',
          required: true,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        },
        1,
      ),
    ]);

    await answer('authorized', 'yes', true);

    const [jobAnswer] = await listJobAnswers(JOB_ID);
    expect(jobAnswer).toMatchObject({ id: 'authorized', value: 'yes' });
    expect((await listAnswers()).map((entry) => entry.id)).toContain('authorized');
  });

  it('refreshes same-id job overrides when the bank answer is edited or deleted', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion(
        {
          id: 'authorized',
          label: 'Are you legally authorized to work in the United States?',
          type: 'radio',
          required: true,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        },
        1,
      ),
    ]);
    await answer('authorized', 'yes', true);
    const bank = (await listAnswers()).find((entry) => entry.id === 'authorized');
    expect(bank).toBeDefined();

    const saved = await handleUi({
      type: 'ui.answer.save',
      requestId: 'edit-authorized',
      answer: { ...bank!, value: 'no' },
    });
    expect(saved.ok).toBe(true);
    const [afterEdit] = await listJobAnswers(JOB_ID);
    expect(afterEdit?.value).toBe('no');

    await handleUi({
      type: 'ui.answer.delete',
      requestId: 'delete-authorized',
      answerId: 'authorized',
    });
    expect(await listJobAnswers(JOB_ID)).toEqual([]);
  });

  it('honors the explicit sensitive auto-submit opt-in', async () => {
    await saveSettings(
      mergeSettings(DEFAULT_SETTINGS, { safety: { allowSensitiveAutoSubmit: true } }),
    );
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeed([
      makeQuestion({ id: 'sponsor', label: 'Will you require visa sponsorship?', type: 'text' }, 1),
    ]);

    await answer('sponsor', 'No');

    const [saved] = await listJobAnswers(JOB_ID);
    expect(saved?.sensitive).toBe(true);
    expect(saved?.autoSubmitAllowed).toBe(true);
  });
});

describe('H4 — final rows reject answers', () => {
  it('does not accept an answer for an applied job', async () => {
    await putQueueItem(
      makeQueueItem({ jobId: JOB_ID, status: 'applied', attempts: 1, priority: 10 }),
    );
    await setMeta(`needs:${JOB_ID}`, {
      questions: [makeQuestion({ id: 'q1', label: 'Why this role?' }, 1)],
      missingDocumentTypes: [],
      reason: 'questions',
    });

    const result = await answer('q1', 'Too late');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect((await getQueueItem(JOB_ID))?.status).toBe('applied');
  });
});
