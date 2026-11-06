import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { runnerTabs } from '@/core/orchestrator/tabs';
import { resetDb, setMeta } from '@/core/storage/db';
import { loadSettings, updateSettings } from '@/core/storage/settings';
import { makeEngineState, makeJob, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const JOB_ID = '900001';

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  await resetDb();
  vi.spyOn(engine, 'load').mockResolvedValue(makeEngineState({ status: 'needs_user' }));
  vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(false);
  vi.spyOn(runnerTabs, 'allowRecreate').mockResolvedValue();
  vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await resetDb();
});

async function seedNeeds(missing: string[]): Promise<void> {
  await putJob(makeJob({ id: JOB_ID }));
  await putQueueItem(
    makeQueueItem({ jobId: JOB_ID, status: 'needs_input', missingDocumentTypes: missing as never }),
  );
  await setMeta(`needs:${JOB_ID}`, {
    questions: [],
    missingDocumentTypes: missing,
    reason: 'documents',
  });
}

describe('configured document validation', () => {
  it('asks for a link or ID instead of reading a document inventory', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeeds(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'missing',
      jobId: JOB_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
    if (!result.ok)
      expect(result.error.message).toContain(
        'This job needs a transcript. Add its Handshake document link or ID.',
      );
    expect((await getQueueItem(JOB_ID))?.missingDocumentTypes).toEqual(['transcript']);
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('accepts a per-job ID that is only entered for this job', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeeds(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'resolve',
      jobId: JOB_ID,
      documents: { transcriptId: 'doc-transcript' },
    });

    expect(result.ok).toBe(true);
    expect((await getQueueItem(JOB_ID))?.documentSelection?.transcriptId).toBe('doc-transcript');
    expect((await loadSettings()).documents.transcriptId).toBeUndefined();
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('accepts a transcript configured in settings', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await updateSettings({ documents: { transcriptId: 'saved-transcript' } });
    await seedNeeds(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'settings',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(true);
    expect((await getQueueItem(JOB_ID))?.status).toBe('queued');
  });

  it('rejects an ID that is not a valid Handshake document ID', async () => {
    await updateSettings({ documents: { transcriptId: 'not a document' } });
    await seedNeeds(['transcript']);

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'invalid',
      jobId: JOB_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
    if (!result.ok) expect(result.error.message).toMatch(/not a valid Handshake document/i);
  });

  it('saves exact per-job choices without changing defaults or starting the engine', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await updateSettings({
      documents: { defaultResumeId: 'default', coverLetterId: 'global-cover' },
    });
    await putQueueItem(makeQueueItem({ jobId: JOB_ID, status: 'queued' }));

    const result = await handleUi({
      type: 'ui.queue.documents',
      requestId: 'save-job',
      jobId: JOB_ID,
      documents: { resumeId: 'for-job', coverLetterId: '' },
    });

    expect(result.ok).toBe(true);
    expect((await getQueueItem(JOB_ID))?.documentSelection).toMatchObject({
      resumeId: 'for-job',
      coverLetterId: '',
    });
    expect((await loadSettings()).documents).toMatchObject({
      defaultResumeId: 'default',
      coverLetterId: 'global-cover',
    });
    expect(engine.resume).not.toHaveBeenCalled();
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('rejects an invalid per-job resume ID before persisting it', async () => {
    await putQueueItem(makeQueueItem({ jobId: JOB_ID, status: 'queued' }));

    const result = await handleUi({
      type: 'ui.queue.documents',
      requestId: 'save-bad',
      jobId: JOB_ID,
      documents: { resumeId: 'bad id' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
    expect((await getQueueItem(JOB_ID))?.documentSelection).toBeUndefined();
  });
});

describe('documents guards', () => {
  it('leaves a final row alone', async () => {
    await putJob(makeJob({ id: JOB_ID }));
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
      requestId: 'final',
      jobId: JOB_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((await getQueueItem(JOB_ID))?.status).toBe('applied');
  });

  it('refuses document resolution while another Review form is open', async () => {
    await seedNeeds(['transcript']);
    await putQueueItem(makeQueueItem({ jobId: '900002', status: 'ready_for_review' }));

    await expect(
      handleUi({
        type: 'ui.needs.documentsResolved',
        requestId: 'review-open',
        jobId: JOB_ID,
        documents: { transcriptId: 'doc-transcript' },
      }),
    ).rejects.toThrow(/pending review/i);
    expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
  });

  it('does not requeue while questions are still pending', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await seedNeeds(['transcript']);
    await setMeta(`needs:${JOB_ID}`, {
      questions: [{ id: 'q1', label: 'Why us?' }],
      missingDocumentTypes: ['transcript'],
      reason: 'documents',
    });

    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'questions',
      jobId: JOB_ID,
      documents: { transcriptId: 'doc-transcript' },
    });

    expect(result.ok).toBe(true);
    expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
    expect(engine.resume).not.toHaveBeenCalled();
  });
});

describe('diagnostics use the configured documents', () => {
  it('counts only the user-entered documents', async () => {
    await updateSettings({
      documents: {
        defaultResumeId: 'resume-1',
        transcriptId: 'transcript-1',
      },
    });

    const result = await handleUi({ type: 'ui.diagnostics.get', requestId: 'diag' });

    expect(result).toMatchObject({ ok: true, data: { counts: { documents: 2 } } });
  });
});
