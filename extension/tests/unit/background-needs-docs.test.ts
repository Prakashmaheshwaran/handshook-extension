import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionDescriptor } from '@/core/contracts';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getQueueItem, putQueueItem, updateQueueItem } from '@/core/orchestrator/queue';
import { putJob } from '@/core/storage/jobs';
import { getMeta, resetDb, setMeta } from '@/core/storage/db';
import { loadSettings, updateSettings } from '@/core/storage/settings';
import { makeEngineState, makeJob, makeQuestion, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const JOB_ID = '900001';

interface StoredNeed {
  questions: QuestionDescriptor[];
  missingDocumentTypes: string[];
  reason: string;
}

async function seed(missing: string[], questions: QuestionDescriptor[] = []): Promise<void> {
  await putJob(makeJob({ id: JOB_ID }, 1));
  await putQueueItem(
    makeQueueItem({
      jobId: JOB_ID,
      status: 'needs_input',
      missingDocumentTypes: missing as never,
      pendingQuestionIds: questions.map((question) => question.id),
    }),
  );
  await setMeta(`needs:${JOB_ID}`, {
    questions,
    missingDocumentTypes: missing,
    reason: missing.length > 0 ? 'documents' : 'questions',
  });
}

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  await resetDb();
  window.localStorage.clear();
  vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Needs You document requests — stored state', () => {
  it('surfaces the exact chosen-document failure recorded for the job', async () => {
    await seed(['resume']);
    const message = 'Your resume (Document 700055) is not offered in the application picker';
    await updateQueueItem(JOB_ID, {
      lastError: { code: 'MISSING_DOCUMENT', message, retryable: false },
    });
    const result = await handleUi({ type: 'ui.needs.list', requestId: 'needs-message' });
    expect(result).toMatchObject({ ok: true, data: [{ jobId: JOB_ID, message }] });
  });

  it('already-saved settings IDs resolve without user input', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await updateSettings({ documents: { transcriptId: 'doc-transcript' } });
    await seed(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'saved',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(true);
    expect(await getMeta(`needs:${JOB_ID}`)).toBeFalsy();
    expect((await getQueueItem(JOB_ID))?.status).toBe('queued');
    expect(engine.resume).toHaveBeenCalledOnce();
  });

  it('keeps a mistyped per-job ID unresolved and does not persist it', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seed(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'bad-id',
      jobId: JOB_ID,
      documents: { transcriptId: 'not-a-valid-id!' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
    expect((await getQueueItem(JOB_ID))?.documentSelection).toBeUndefined();
    expect((await getQueueItem(JOB_ID))?.missingDocumentTypes).toEqual(['transcript']);
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('clears the missing list, requeues, and resumes when the ID is entered', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seed(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'resolve-1',
      jobId: JOB_ID,
      documents: { transcriptId: 'doc-transcript' },
    });

    expect(result.ok).toBe(true);
    expect(await getMeta(`needs:${JOB_ID}`)).toBeFalsy();
    expect(await getQueueItem(JOB_ID)).toMatchObject({
      status: 'queued',
      missingDocumentTypes: [],
      pendingQuestionIds: [],
    });
    expect(engine.resume).toHaveBeenCalledOnce();
    expect((await getQueueItem(JOB_ID))?.documentSelection?.transcriptId).toBe('doc-transcript');
    expect((await loadSettings()).documents.transcriptId).toBeUndefined();
  });

  it('does not requeue while questions are still pending', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seed(['transcript'], [makeQuestion({ id: 'q1', label: 'Why us?' }, 1)]);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'resolve-2',
      jobId: JOB_ID,
      documents: { transcriptId: 'doc-transcript' },
    });

    expect(result.ok).toBe(true);
    const stored = await getMeta<StoredNeed>(`needs:${JOB_ID}`);
    expect(stored?.missingDocumentTypes).toEqual([]);
    expect(stored?.questions.map((question) => question.id)).toEqual(['q1']);
    expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('keeps the item needs_input when the required document is still missing', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seed(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'resolve-3',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_DOCUMENT');
      expect(result.error.retryable).toBe(false);
    }
    const stored = await getMeta<StoredNeed>(`needs:${JOB_ID}`);
    expect(stored?.missingDocumentTypes).toEqual(['transcript']);
    expect(await getQueueItem(JOB_ID)).toMatchObject({ status: 'needs_input' });
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('keeps required unchosen transcripts in Needs You even when other documents are configured', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await updateSettings({ documents: { defaultResumeId: 'doc-resume' } });
    await seed(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'none',
      jobId: JOB_ID,
      documents: { transcriptId: '' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
    expect(engine.resume).not.toHaveBeenCalled();
  });
});

describe('H4 — final rows reject the documents-resolved action', () => {
  it('leaves an applied row alone', async () => {
    await putJob(makeJob({ id: JOB_ID }, 1));
    await putQueueItem(
      makeQueueItem({ jobId: JOB_ID, status: 'applied', missingDocumentTypes: ['transcript'] }),
    );
    await setMeta(`needs:${JOB_ID}`, {
      questions: [],
      missingDocumentTypes: ['transcript'],
      reason: 'documents',
    });

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'docs-final',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect((await getQueueItem(JOB_ID))?.status).toBe('applied');
  });
});
