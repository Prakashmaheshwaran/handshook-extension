import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { runnerTabs } from '@/core/orchestrator/tabs';
import { resetDb, setMeta } from '@/core/storage/db';
import { createSubmission } from '@/core/storage/submissions';
import { appError, type SubmissionAttempt, type UiRequest } from '@/core/contracts';
import { makeEngineState, makeJob, makeQuestion, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

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

describe('shared runner ownership', () => {
  it('rejects a session check while a manual review form is open', async () => {
    await putQueueItem(makeQueueItem({ status: 'ready_for_review' }));
    await expect(handleUi({ type: 'ui.session.check', requestId: 'session' })).rejects.toThrow(
      /pending review/i,
    );
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('allows missing-document resolution when needs_user has no live form', async () => {
    await putQueueItem(
      makeQueueItem({ status: 'needs_input', missingDocumentTypes: ['transcript'] }),
    );
    await setMeta('needs:900001', {
      reason: 'documents',
      questions: [],
      missingDocumentTypes: ['transcript'],
    });
    const resume = vi
      .spyOn(engine, 'resume')
      .mockResolvedValue(makeEngineState({ status: 'running' }));
    const result = await handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'resolved',
      jobId: '900001',
      documents: { transcriptId: 'doc-transcript' },
    });
    expect(result.ok).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    // Document resolution uses the entered IDs only; it never reads a runner tab.
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('rejects navigation while a paused engine still has an in-flight operation', async () => {
    vi.spyOn(engine, 'load').mockResolvedValue(makeEngineState({ status: 'paused' }));
    vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(true);
    await expect(handleUi({ type: 'ui.session.check', requestId: 'session' })).rejects.toThrow(
      /stop the run/i,
    );
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('checks the session from a freshly loaded shared runner after login', async () => {
    vi.spyOn(runnerTabs, 'send').mockResolvedValue({
      requestId: 'session',
      ok: true,
      data: { status: 'logged_in', host: 'app.joinhandshake.com' },
    });
    expect((await handleUi({ type: 'ui.session.check', requestId: 'login' })).ok).toBe(true);
    expect(runnerTabs.ensure).toHaveBeenCalledWith('https://app.joinhandshake.com/', true, {
      fresh: true,
    });
  });

  it('allows read-only reconciliation on Resume while an uncertain send is verifying', async () => {
    await putQueueItem(makeQueueItem({ status: 'verifying' }));
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState({ status: 'needs_user' }));
    const result = await handleUi({ type: 'ui.engine.resume', requestId: 'verify' });
    expect(result.ok).toBe(true);
    expect(engine.resume).toHaveBeenCalledOnce();
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
  });

  it('rechecks availability after a concurrent document resolution resumes the engine', async () => {
    await putQueueItem(
      makeQueueItem({ status: 'needs_input', missingDocumentTypes: ['transcript'] }),
    );
    await setMeta('needs:900001', {
      reason: 'documents',
      questions: [],
      missingDocumentTypes: ['transcript'],
    });
    const resume = vi.spyOn(engine, 'resume').mockImplementation(async () => {
      const running = makeEngineState({ status: 'running' });
      vi.mocked(engine.load).mockResolvedValue(running);
      return running;
    });
    const request = {
      type: 'ui.needs.documentsResolved',
      requestId: 'docs',
      jobId: '900001',
      documents: { transcriptId: 'doc-transcript' },
    } as const;
    const first = handleUi(request);
    const second = handleUi(request);
    expect((await first).ok).toBe(true);
    // The first call resumed the run and requeued the job; the second must not
    // requeue it again while the run may already be applying to it.
    const repeated = await second;
    expect(repeated.ok).toBe(false);
    expect(repeated.ok ? '' : repeated.error.message).toMatch(/already back in the queue/i);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('Stop cancels a queued start behind an in-flight document resolution', async () => {
    await putQueueItem(
      makeQueueItem({ status: 'needs_input', missingDocumentTypes: ['transcript'] }),
    );
    await setMeta('needs:900001', {
      reason: 'documents',
      questions: [],
      missingDocumentTypes: ['transcript'],
    });
    let finishResume = (): void => {};
    const pendingResume = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    const resume = vi.spyOn(engine, 'resume').mockImplementation(async () => {
      await pendingResume;
      return makeEngineState({ status: 'running' });
    });
    const start = vi.spyOn(engine, 'start');
    vi.spyOn(engine, 'stop').mockResolvedValue(makeEngineState({ status: 'idle' }));
    const documentResolution = handleUi({
      type: 'ui.needs.documentsResolved',
      requestId: 'docs',
      jobId: '900001',
      documents: { transcriptId: 'doc-transcript' },
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    const queuedStart = handleUi({ type: 'ui.engine.start', requestId: 'start' });
    expect((await handleUi({ type: 'ui.engine.stop', requestId: 'stop' })).ok).toBe(true);
    finishResume();
    // The document resolution already passed its guards and has no submit; the
    // queued start must not run after Stop bumped the generation.
    expect(await documentResolution).toMatchObject({ ok: true });
    expect(await queuedStart).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('explicit UI_CHANGED retry', () => {
  async function seedBlocked(code: 'UI_CHANGED' | 'JOB_CLOSED' | 'FORBIDDEN' = 'UI_CHANGED') {
    await putJob(makeJob());
    await putQueueItem(
      makeQueueItem({ status: 'blocked', lastError: appError(code, 'Page unavailable') }),
    );
  }

  async function attempt(patch: Partial<SubmissionAttempt> = {}) {
    return createSubmission({
      jobId: '900001',
      runId: 'old-run',
      host: 'app.joinhandshake.com',
      startedAt: 1,
      finishedAt: 2,
      status: 'failed',
      applyType: 'handshake_form',
      documents: [],
      questionIds: [],
      ...patch,
    });
  }

  async function retry() {
    return handleUi({ type: 'ui.queue.retry', requestId: 'changed-page', jobId: '900001' });
  }

  it.each([false, true])(
    'requeues only an explicit safe UI_CHANGED retry, journal present: %s',
    async (journal) => {
      await seedBlocked();
      if (journal) await attempt();
      vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState({ status: 'running' }));
      expect((await retry()).ok).toBe(true);
      expect(await getQueueItem('900001')).toMatchObject({
        status: 'queued',
        lastError: undefined,
      });
      expect(engine.resume).toHaveBeenCalledOnce();
    },
  );

  it.each(['started', 'submitted', 'ambiguous', 'applied'] as const)(
    'refuses a %s journal before retry',
    async (status) => {
      await seedBlocked();
      await attempt({ status });
      const resume = vi.spyOn(engine, 'resume');
      expect((await retry()).ok).toBe(false);
      expect(resume).not.toHaveBeenCalled();
      expect(runnerTabs.ensure).not.toHaveBeenCalled();
    },
  );

  it.each([
    { finishedAt: undefined },
    { capCountedAt: 2 },
    { confirmationText: 'Application submitted' },
  ])('refuses a failed journal without positive non-submission evidence: %s', async (patch) => {
    await seedBlocked();
    await attempt(patch);
    const resume = vi.spyOn(engine, 'resume');
    expect((await retry()).ok).toBe(false);
    expect((await getQueueItem('900001'))?.status).toBe('blocked');
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(['JOB_CLOSED', 'FORBIDDEN'] as const)(
    'keeps other blocked reasons immutable: %s',
    async (code) => {
      await seedBlocked(code);
      await attempt();
      expect((await retry()).ok).toBe(false);
      expect((await getQueueItem('900001'))?.status).toBe('blocked');
    },
  );

  it('surfaces UI_CHANGED in Needs You with its dedicated recovery reason', async () => {
    await seedBlocked();
    const result = await handleUi({ type: 'ui.needs.list', requestId: 'changed-needs' });
    expect(result).toMatchObject({ ok: true, data: [{ reason: 'ui_changed', jobId: '900001' }] });
  });
});

const resolutions: UiRequest[] = [
  { type: 'ui.needs.documentsResolved', requestId: 'docs', jobId: '900001' },
  {
    type: 'ui.job.answer',
    requestId: 'answer',
    jobId: '900001',
    questionId: 'q1',
    value: 'A saved answer',
    remember: false,
  },
  { type: 'ui.queue.retry', requestId: 'ui-changed', jobId: '900001' },
  { type: 'ui.queue.applyNow', requestId: 'apply-now', jobId: '900001' },
  {
    type: 'ui.queue.documents',
    requestId: 'choose-documents',
    jobId: '900001',
    documents: { resumeId: 'resume' },
  },
  { type: 'ui.engine.resume', requestId: 'login-resume' },
  { type: 'ui.engine.start', requestId: 'new-run' },
];

async function seedResolution(): Promise<void> {
  await putQueueItem(makeQueueItem({ status: 'needs_input' }));
  await setMeta('needs:900001', {
    reason: 'questions',
    questions: [makeQuestion({ id: 'q1', label: 'Why this role?' })],
    missingDocumentTypes: [],
  });
}

describe('Needs You resolution safety', () => {
  it.each(['verifying', 'needs_input'] as const)(
    'explains an uncertain %s submission without instructing another submit',
    async (status) => {
      await putJob(makeJob());
      await putQueueItem(makeQueueItem({ status }));
      await setMeta('needs:900001', {
        reason: 'review',
        message: 'Application filled. Review it, then submit.',
      });
      const result = await handleUi({ type: 'ui.needs.list', requestId: 'uncertain' });
      expect(result).toMatchObject({
        ok: true,
        data: [{ message: expect.stringContaining('may already have been submitted') }],
      });
      expect(JSON.stringify(result)).not.toContain('Review it, then submit');
      expect(runnerTabs.ensure).not.toHaveBeenCalled();
    },
  );

  it.each(resolutions)('refuses $type while another Review form is open', async (request) => {
    await seedResolution();
    await putQueueItem(makeQueueItem({ jobId: '900002', status: 'ready_for_review' }));
    const resume = vi.spyOn(engine, 'resume');
    await expect(handleUi(request)).rejects.toThrow(/pending review/i);
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(resolutions)('refuses $type while apply is still in flight', async (request) => {
    await seedResolution();
    vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(true);
    const resume = vi.spyOn(engine, 'resume');
    await expect(handleUi(request)).rejects.toThrow(/stop the run/i);
    expect(runnerTabs.ensure).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  for (const status of ['started', 'submitted', 'ambiguous', 'applied'] as const) {
    it.each(resolutions.slice(0, 5))(
      `blocks $type before refreshing/requeueing a ${status} journal entry`,
      async (request) => {
        await seedResolution();
        await createSubmission({
          jobId: '900001',
          runId: 'old-run',
          host: 'app.joinhandshake.com',
          status,
          startedAt: 1,
          applyType: 'handshake_form',
          documents: [],
          questionIds: [],
        });
        const resume = vi.spyOn(engine, 'resume');
        const result = await handleUi(request);
        expect(result.ok).toBe(false);
        expect(runnerTabs.ensure).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
      },
    );
  }
});
