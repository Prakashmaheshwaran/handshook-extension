import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentType, Job } from '@/core/contracts';
import { enqueueJobs, getQueueItem, putQueueItem } from '@/core/orchestrator/queue';
import { handleUi, registerBackground } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { resetDb } from '@/core/storage/db';
import { createSubmission, getSubmissionsForJob } from '@/core/storage/submissions';
import { makeAppError, makeEngineState, makeJob, makeSettings } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const JOB_ID = '900001';

function evaluator(fitScore = 0.9) {
  return () => ({ pass: true, reasons: [], fitScore, fitReasons: [] });
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

describe('enqueueJobs — P1-6 re-scan does not reset work in progress', () => {
  it('preserves status, attempts, errors, backoff, and needs on an existing item', async () => {
    const job = makeJob({ id: JOB_ID }, 1);
    const lastError = makeAppError('TIMEOUT', { retryable: true });
    await putQueueItem({
      jobId: JOB_ID,
      status: 'failed',
      priority: 12,
      attempts: 2,
      addedAt: 1_000,
      updatedAt: 2_000,
      nextAttemptAt: 99_000,
      lastError,
      pendingQuestionIds: ['q1'],
      missingDocumentTypes: ['transcript' as DocumentType],
      skipReason: 'not this one',
    });

    await enqueueJobs([job], makeSettings(), evaluator(0.95));

    const item = await getQueueItem(JOB_ID);
    expect(item).toMatchObject({
      status: 'failed',
      attempts: 2,
      addedAt: 1_000,
      nextAttemptAt: 99_000,
      pendingQuestionIds: ['q1'],
      missingDocumentTypes: ['transcript'],
      lastError,
      skipReason: 'not this one',
      priority: 95,
    });
    expect(item?.updatedAt).toBeGreaterThan(2_000);
  });

  it('still inserts new jobs and leaves terminal entries alone', async () => {
    const applied = makeJob({ id: '900002' }, 2);
    const fresh = makeJob({ id: '900003' }, 3);
    await putQueueItem({
      jobId: applied.id,
      status: 'applied',
      priority: 1,
      attempts: 1,
      addedAt: 500,
      updatedAt: 600,
    });

    const result = await enqueueJobs([applied, fresh], makeSettings(), evaluator(0.8));

    expect(result.queued).toBe(1);
    expect(await getQueueItem(applied.id)).toMatchObject({ status: 'applied', priority: 1 });
    expect(await getQueueItem(fresh.id)).toMatchObject({ status: 'queued', priority: 80 });
  });

  it('filters a genuinely new job that fails the evaluator', async () => {
    const job = makeJob({ id: '900004' }, 4);
    const result = await enqueueJobs([job], makeSettings(), () => ({
      pass: false,
      reasons: ['excluded'],
      fitScore: 0.1,
      fitReasons: [],
    }));
    expect(result.filtered).toBe(1);
    expect(await getQueueItem(job.id)).toMatchObject({ status: 'filtered' });
  });
});

describe('queue actions — P2 skipReason and apply-now priority', () => {
  async function seedItem(): Promise<Job> {
    const job = makeJob({ id: JOB_ID }, 1);
    await putQueueItem({
      jobId: JOB_ID,
      status: 'failed',
      priority: 10,
      attempts: 1,
      addedAt: 1,
      updatedAt: 2,
      lastError: makeAppError('UNKNOWN', { message: 'failed' }),
    });
    return job;
  }

  it('stores the skip reason separately from an error', async () => {
    await seedItem();
    const cancel = vi.spyOn(engine, 'cancelActiveJob').mockResolvedValue(false);

    const result = await handleUi({
      type: 'ui.queue.skip',
      requestId: 'skip-1',
      jobId: JOB_ID,
      reason: 'Not interested',
    });

    expect(result.ok).toBe(true);
    const item = await getQueueItem(JOB_ID);
    expect(item?.status).toBe('skipped');
    expect(item?.skipReason).toBe('Not interested');
    expect(item?.lastError).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(JOB_ID);
  });

  it('keeps an uncertain submission blocked from replay when a job is skipped', async () => {
    const job = await seedItem();
    const attempt = await createSubmission({
      runId: 'run-skip',
      jobId: job.id,
      host: job.host,
      startedAt: 1,
      status: 'ambiguous',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });

    const result = await handleUi({
      type: 'ui.queue.skip',
      requestId: 'skip-2',
      jobId: JOB_ID,
      reason: 'Not interested',
    });

    expect(result.ok).toBe(true);
    const submission = (await getSubmissionsForJob(JOB_ID)).find(
      (entry) => entry.id === attempt.id,
    );
    expect(submission?.status).toBe('ambiguous');
    expect(submission?.reconciliationNote).toMatch(/skip/i);
    expect((await getQueueItem(JOB_ID))?.status).toBe('skipped');
    const retry = await handleUi({
      type: 'ui.queue.retry',
      requestId: 'retry-after-skip',
      jobId: JOB_ID,
    });
    expect(retry.ok).toBe(false);
    expect((await getSubmissionsForJob(JOB_ID))[0]?.status).toBe('ambiguous');
  });

  it.each(['ambiguous', 'submitted'] as const)(
    'never retries a job whose submission journal is %s',
    async (status) => {
      const job = await seedItem();
      await createSubmission({
        runId: 'run-ambiguous',
        jobId: job.id,
        host: job.host,
        startedAt: 1,
        status,
        applyType: 'quick_apply',
        documents: [],
        questionIds: [],
      });

      const result = await handleUi({
        type: 'ui.queue.retry',
        requestId: 'retry-ambiguous',
        jobId: JOB_ID,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/needs verification/i);
      expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
    },
  );

  it('never retries or applies-now when the journal says applied', async () => {
    const job = await seedItem();
    await createSubmission({
      runId: 'run-applied',
      jobId: job.id,
      host: job.host,
      startedAt: 1,
      status: 'applied',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });

    const retry = await handleUi({
      type: 'ui.queue.retry',
      requestId: 'retry-applied',
      jobId: JOB_ID,
    });
    expect(retry.ok).toBe(false);
    expect((await getQueueItem(JOB_ID))?.status).toBe('applied');

    const applyNow = await handleUi({
      type: 'ui.queue.applyNow',
      requestId: 'apply-now-applied',
      jobId: JOB_ID,
    });
    expect(applyNow.ok).toBe(false);
  });

  it('never applies-now a job whose submission journal is ambiguous', async () => {
    const job = await seedItem();
    await createSubmission({
      runId: 'run-ambiguous-now',
      jobId: job.id,
      host: job.host,
      startedAt: 1,
      status: 'ambiguous',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });

    const result = await handleUi({
      type: 'ui.queue.applyNow',
      requestId: 'apply-now-ambiguous',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(false);
    expect((await getQueueItem(JOB_ID))?.status).toBe('needs_input');
  });

  it('raises priority for apply-now', async () => {
    await seedItem();
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());

    const result = await handleUi({
      type: 'ui.queue.applyNow',
      requestId: 'apply-1',
      jobId: JOB_ID,
    });

    expect(result.ok).toBe(true);
    const item = await getQueueItem(JOB_ID);
    expect(item?.status).toBe('queued');
    expect(item?.priority).toBe(999);
    expect(item?.nextAttemptAt).toBeUndefined();
  });

  it('clears a stale skip reason when retried', async () => {
    await seedItem();
    await putQueueItem({
      jobId: JOB_ID,
      status: 'skipped',
      priority: 10,
      attempts: 1,
      addedAt: 1,
      updatedAt: 2,
      skipReason: 'Not interested',
    });
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());

    await handleUi({ type: 'ui.queue.retry', requestId: 'retry-1', jobId: JOB_ID });

    expect(await getQueueItem(JOB_ID)).toMatchObject({
      status: 'queued',
      skipReason: undefined,
      lastError: undefined,
    });
  });
});

describe('pruning — P2 runs on alarms', () => {
  it('removes stale terminal jobs when the tick alarm fires', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    registerBackground();
    const alarmListener = fake.alarms.onAlarm.addListener.mock.calls[0]?.[0] as (alarm: {
      name: string;
    }) => void;
    await putQueueItem({
      jobId: '900099',
      status: 'external',
      priority: 0,
      attempts: 0,
      addedAt: 1,
      updatedAt: Date.now() - 100 * 86_400_000,
    });

    alarmListener({ name: 'handshook.prune' });

    await vi.waitFor(async () => {
      expect(await getQueueItem('900099')).toBeUndefined();
    });
  });
});

describe('H4 — final queue rows are immutable', () => {
  const FINAL = ['applied', 'external', 'already_applied', 'filtered', 'blocked'] as const;

  it('rejects retry, skip, and apply-now for every final status', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    for (const status of FINAL) {
      await putQueueItem({
        jobId: JOB_ID,
        status,
        priority: 10,
        attempts: 1,
        addedAt: 1_000,
        updatedAt: 2_000,
      });

      for (const request of [
        { type: 'ui.queue.retry' as const, requestId: 'r' },
        { type: 'ui.queue.skip' as const, requestId: 's', reason: 'no' },
        { type: 'ui.queue.applyNow' as const, requestId: 'a' },
      ]) {
        const result = await handleUi({ ...request, jobId: JOB_ID });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
      }

      expect((await getQueueItem(JOB_ID))?.status).toBe(status);
    }
  });

  it('still allows retrying a skipped row', async () => {
    vi.spyOn(engine, 'resume').mockResolvedValue(makeEngineState());
    await putQueueItem({
      jobId: JOB_ID,
      status: 'skipped',
      priority: 1,
      attempts: 0,
      addedAt: 1_000,
      updatedAt: 2_000,
    });

    const result = await handleUi({ type: 'ui.queue.retry', requestId: 'retry', jobId: JOB_ID });

    expect(result.ok).toBe(true);
    expect((await getQueueItem(JOB_ID))?.status).toBe('queued');
  });
});
