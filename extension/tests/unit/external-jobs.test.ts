import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  type ContentRequest,
  type Job,
  type QueuePayload,
  type JobEvent,
} from '@/core/contracts';
import { handleUi } from '@/background/router';
import { settleReviewResult } from '@/background/review-results';
import { settleReconciledSubmission } from '@/core/storage/submission-settlement';
import { Engine, isTransportDrop } from '@/core/orchestrator/engine';
import {
  enqueueJobs,
  getJob,
  getNextQueued,
  getNextQueueWakeAt,
  getQueueItem,
  getQueueSummary,
  listQueue,
  putJob,
  putQueueItem,
} from '@/core/orchestrator/queue';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getMeta, getTodayCount, resetDb, setMeta } from '@/core/storage/db';
import { getQueueSummary as trackerSummary, trackApplied } from '@/core/storage/tracker';
import { countAttemptTowardCapOnce, createSubmission } from '@/core/storage/submissions';
import { saveSettings, saveEngineState } from '@/core/storage/settings';
import { logEvent, makeEvent } from '@/core/logging/logger';
import { listEvents } from '@/core/logging/eventStore';
import { makeJob, makeSettings, makeQueueItem, makeEngineState } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';
import { todayKey } from '@/core/util/time';

const clock = { now: () => Date.now(), sleep: async () => {}, random: () => 0.5 };
const evaluate = vi.fn(() => ({ pass: true, reasons: [], fitScore: 0.9, fitReasons: [] }));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  localStorage.clear();
  vi.stubGlobal('browser', createFakeBrowser().fake);
  await resetDb();
  evaluate.mockClear();
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await resetDb();
});

async function queuePayload(externalOnly = false): Promise<QueuePayload> {
  const response = await handleUi({
    type: 'ui.queue.list',
    requestId: 'queue',
    ...(externalOnly ? { status: ['external'] } : {}),
  });
  expect(response.ok).toBe(true);
  return response.ok ? (response.data as QueuePayload) : Promise.reject(response.error);
}

async function running(
  job: Job,
  inspect: Job | ReturnType<typeof appError>,
  applyExternal = false,
) {
  await saveSettings(
    makeSettings({
      onboardingComplete: true,
      mode: 'autopilot',
      search: { minFitScore: 0 },
      pacing: { activeHours: null },
    }),
  );
  await saveEngineState(
    makeEngineState({
      status: 'running',
      mode: 'autopilot',
      scanComplete: true,
      runId: 'external-test',
    }),
  );
  await putJob(job);
  await putQueueItem(makeQueueItem({ jobId: job.id }));
  const send = vi.fn(async (request: ContentRequest) => {
    if (request.type === 'content.inspectJob')
      return 'code' in inspect
        ? { requestId: request.requestId, ok: false, error: inspect }
        : { requestId: request.requestId, ok: true, data: inspect };
    return {
      requestId: request.requestId,
      ok: true,
      data: { jobId: job.id, outcome: applyExternal ? 'external' : 'would_apply' },
    };
  });
  const ensure = vi.fn(async () => 7);
  const engine = new Engine({
    clock,
    tabs: { id: 7, ensure, send, cancel: vi.fn(async () => {}) } as unknown as RunnerTabManager,
  });
  await engine.load();
  await engine.tick();
  return { engine, send, ensure };
}

describe('external job discovery and scheduling', () => {
  it('does not store, score, enqueue or count discovered external jobs by default', async () => {
    const job = makeJob({ applyType: 'external' });
    expect(await enqueueJobs([job], makeSettings(), evaluate)).toEqual({ queued: 0, filtered: 0 });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await getJob(job.id)).toBeUndefined();
    expect(await getQueueItem(job.id)).toBeUndefined();
    expect((await getQueueSummary(makeSettings())).total).toBe(0);
  });

  it('collects beta links as terminal external rows without scoring or automation', async () => {
    const job = makeJob({ applyType: 'external', fitScore: 1 });
    const settings = makeSettings({ search: { collectExternalJobs: true } });
    await enqueueJobs([job], settings, evaluate);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await getQueueItem(job.id)).toMatchObject({ status: 'external', attempts: 0 });
    expect((await getJob(job.id))?.fitScore).toBeUndefined();
    expect(await getNextQueued()).toBeUndefined();
    expect(await getNextQueueWakeAt(Date.now(), 2)).toBeUndefined();
    expect(await listQueue()).toEqual([]);
    expect(await listQueue({ includeExternal: true })).toHaveLength(1);
    expect(await getQueueSummary(settings)).toMatchObject({
      counts: {},
      total: 0,
      todayCount: 0,
      remainingToday: settings.pacing.dailyCap,
    });
  });

  it.each(['queued', 'needs_input', 'ready_for_review', 'applied', 'waiting'] as const)(
    'hides an old external row with %s status without deleting it',
    async (status) => {
      const job = makeJob({ applyType: 'external' });
      await putJob(job);
      await putQueueItem(makeQueueItem({ status, nextAttemptAt: Date.now() }));
      const payload = await queuePayload();
      expect(payload).toMatchObject({
        items: [],
        jobs: [],
        needs: [],
        summary: { counts: {}, total: 0 },
      });
      expect(await getQueueItem(job.id)).toMatchObject({ status });
      expect(await getNextQueued()).toBeUndefined();
      expect(await getNextQueueWakeAt(Date.now(), 2)).toBeUndefined();
      expect((await trackerSummary(makeSettings())).total).toBe(0);
    },
  );

  it('never opens a previously known external job in the runner', async () => {
    const job = makeJob({ applyType: 'external' });
    const { ensure, send, engine } = await running(job, job);
    expect(ensure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // Nothing eligible is left, so the run schedules another scan for newly
    // posted jobs instead of going idle after the first pass.
    expect(engine.getState().status).not.toBe('idle');
    expect(engine.getState().message).toMatch(/scanning/i);
  });

  it.each(['inspection', 'inspection-error', 'apply-result'] as const)(
    'quietly removes a job detected external during %s without failure, pause, needs or cap',
    async (phase) => {
      const job = makeJob({ requiredDocumentTypes: [], applyType: 'handshake_form' });
      await setMeta(`needs:${job.id}`, { reason: 'review' });
      const details =
        phase === 'inspection-error'
          ? appError('EXTERNAL_APPLY', 'External')
          : phase === 'inspection'
            ? { ...job, applyType: 'external' as const }
            : job;
      const { engine, send } = await running(job, details, phase === 'apply-result');
      expect(await getQueueItem(job.id)).toMatchObject({
        status: 'external',
        lastError: undefined,
      });
      expect((await getJob(job.id))?.fitScore).toBeUndefined();
      expect(await getMeta(`needs:${job.id}`)).toBeNull();
      expect(engine.getState()).toMatchObject({
        status: 'running',
        todayCount: 0,
        consecutiveFailures: 0,
        nextActionAt: Date.now() + 7_000,
      });
      expect(await getTodayCount()).toBe(0);
      expect(await listQueue()).toEqual([]);
      const activity = await handleUi({ type: 'ui.events.list', requestId: 'activity' });
      expect(
        activity.ok && (activity.data as JobEvent[]).filter((event) => event.jobId === job.id),
      ).toEqual([]);
      if (phase !== 'apply-result')
        expect(send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(false);
    },
  );

  it('emits one aggregate scan line and external cards do not consume the job limit', async () => {
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        search: { maxJobsPerRun: 1, maxPagesPerRun: 2, minFitScore: 0 },
      }),
    );
    await saveEngineState(makeEngineState({ status: 'running', scanComplete: false }));
    const external = [1, 2, 3].map((n) => makeJob({ applyType: 'external' }, n));
    // A sparse new card must not undo a classification saved by an earlier run.
    const previouslyExternal = makeJob({ applyType: 'external' }, 3);
    await putJob(previouslyExternal);
    external[2] = { ...previouslyExternal, applyType: 'unknown' };
    const internal = makeJob({}, 4);
    let scans = 0;
    const engine = new Engine({
      clock,
      tabs: {
        id: 7,
        ensure: vi.fn(async () => 7),
        cancel: vi.fn(async () => {}),
        send: vi.fn(async (request: ContentRequest) => ({
          requestId: request.requestId,
          ok: true,
          data:
            ++scans === 1
              ? {
                  jobs: external,
                  nextPageUrl: 'https://app.joinhandshake.com/job-search?page=2',
                  empty: false,
                }
              : { jobs: [internal], nextPageUrl: null, empty: false },
        })),
      } as unknown as RunnerTabManager,
    });
    await engine.load();
    await engine.tick();
    expect(scans).toBe(1);
    await engine.tick();
    expect(scans).toBe(1);
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + 7_000);
    await engine.tick();
    expect(scans).toBe(2);
    expect(await getQueueItem(internal.id)).toMatchObject({ status: 'queued' });
    const events = await listEvents();
    expect(events.filter((event) => event.type === 'scan.external')).toMatchObject([
      { message: "Skipped 3 jobs that apply on the employer's site", jobId: undefined },
    ]);
    expect(events.some((event) => event.jobId)).toBe(false);
    expect(engine.getState().message).toMatch(/Found 1 jobs/);
  });
});

describe('beta queue and historical Activity', () => {
  it('lists external links only with opt-in, forbids automation, and dismisses without deleting', async () => {
    const settings = makeSettings({ search: { collectExternalJobs: true } });
    await saveSettings(settings);
    const job = makeJob({ applyType: 'external' });
    await enqueueJobs([job], settings, evaluate);
    expect((await queuePayload()).items).toHaveLength(0);
    expect((await queuePayload(true)).items).toHaveLength(1);
    for (const type of ['ui.queue.retry', 'ui.queue.applyNow'] as const) {
      expect((await handleUi({ type, requestId: type, jobId: job.id })).ok).toBe(false);
    }
    expect(
      (
        await handleUi({
          type: 'ui.queue.skip',
          requestId: 'dismiss',
          jobId: job.id,
          reason: 'Dismiss',
        })
      ).ok,
    ).toBe(true);
    expect((await queuePayload(true)).items).toEqual([]);
    expect(await getQueueItem(job.id)).toMatchObject({ status: 'external' });
    await enqueueJobs([job], settings, evaluate);
    expect((await queuePayload(true)).items).toEqual([]);
  });

  it('removes old per-job external noise and noninternal applied events but keeps scan aggregates', async () => {
    const job = makeJob({ applyType: 'external' });
    await putJob(job);
    await logEvent(makeEvent('info', 'job.failed', 'External job old failure', { jobId: job.id }));
    await logEvent(makeEvent('info', 'job.external', 'Old external notification'));
    await logEvent(makeEvent('info', 'job.applied', 'Unknown application', { jobId: 'missing' }));
    await logEvent(makeEvent('info', 'job.applied', 'Uncorrelated application'));
    await logEvent(makeEvent('info', 'scan.external', 'Skipped 3 jobs that apply externally'));
    const response = await handleUi({ type: 'ui.events.list', requestId: 'events', limit: 1 });
    expect(response.ok && (response.data as JobEvent[]).map((event) => event.type)).toEqual([
      'scan.external',
    ]);
    expect(await listEvents()).toHaveLength(5);
  });
});

describe('internal application counts', () => {
  it.each(['external', 'unknown', 'late-external'] as const)(
    'excludes a legacy %s cap marker while preserving internal uncertainty and unallocated reservations',
    async (path) => {
      const job = makeJob({ applyType: path === 'late-external' ? 'quick_apply' : path });
      await putJob(job);
      await putQueueItem(makeQueueItem({ status: 'external' }));
      const ignored = await createSubmission({
        runId: 'old-run',
        jobId: job.id,
        host: job.host,
        applyType: job.applyType,
        startedAt: Date.now(),
        capCountedAt: Date.now(),
        status: 'ambiguous',
        documents: [],
        questionIds: [],
      });
      const internal = makeJob({ applyType: 'handshake_form' }, 2);
      await putJob(internal);
      const reserved = await createSubmission({
        ...ignored,
        jobId: internal.id,
        applyType: internal.applyType,
      });
      await setMeta(`dailyCount:${todayKey()}`, 3);
      expect(await getTodayCount()).toBe(2);
      expect((await getQueueSummary(makeSettings())).todayCount).toBe(2);
      // Neither the raw counter nor the once-only marker is destructively migrated.
      expect(await getMeta(`dailyCount:${todayKey()}`)).toBe(3);
      expect(await countAttemptTowardCapOnce(reserved.id)).toBe(false);
      expect(await countAttemptTowardCapOnce(ignored.id)).toBe(false);
      const tomorrow = new Date(Date.now() + 86_400_000);
      await setMeta(`dailyCount:${todayKey(tomorrow)}`, 4);
      expect(await getTodayCount(tomorrow)).toBe(4);
    },
  );

  it('preserves an external tracker barrier even when the stored job type is stale', async () => {
    const job = makeJob({ applyType: 'quick_apply' });
    await putJob(job);
    await putQueueItem(makeQueueItem({ status: 'external' }));
    expect((await trackApplied(job.id)).status).toBe('external');
    expect((await trackerSummary(makeSettings())).total).toBe(0);
  });

  it.each(['external', 'unknown'] as const)(
    'refuses applied Review and reconciliation for a %s path',
    async (applyType) => {
      const job = makeJob({ applyType });
      await putJob(job);
      const attempt = await createSubmission({
        runId: 'run',
        jobId: job.id,
        host: job.host,
        applyType,
        startedAt: Date.now(),
        status: 'started',
        documents: [],
        questionIds: [],
      });
      await putQueueItem(
        makeQueueItem({ status: 'ready_for_review', submissionAttemptId: attempt.id }),
      );
      const review = await settleReviewResult(
        {
          type: 'content.event.result',
          requestId: attempt.id,
          jobId: job.id,
          result: { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
        },
        'run',
      );
      expect(review.ok).toBe(false);
      expect(
        (
          await settleReconciledSubmission(
            attempt.id,
            job.id,
            job.host,
            'Verified applied on job page after restart',
          )
        ).ok,
      ).toBe(false);
      expect(await getTodayCount()).toBe(0);
      expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
      expect(await listEvents()).toEqual([]);
    },
  );

  it.each(['quick_apply', 'handshake_form'] as const)(
    'counts a confirmed %s exactly once',
    async (applyType) => {
      const job = makeJob({ applyType });
      await putJob(job);
      const attempt = await createSubmission({
        runId: 'run',
        jobId: job.id,
        host: job.host,
        applyType,
        startedAt: Date.now(),
        status: 'started',
        documents: [],
        questionIds: [],
      });
      await putQueueItem(
        makeQueueItem({ status: 'ready_for_review', submissionAttemptId: attempt.id }),
      );
      const result = await settleReviewResult(
        {
          type: 'content.event.result',
          requestId: attempt.id,
          jobId: job.id,
          result: { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
        },
        'run',
      );
      expect(result.ok).toBe(true);
      expect(await countAttemptTowardCapOnce(attempt.id)).toBe(false);
      expect(await getTodayCount()).toBe(1);
      expect((await getQueueSummary(makeSettings())).counts.applied).toBe(1);
      expect((await listEvents()).map((event) => event.type)).toEqual(['job.applied']);
    },
  );

  it.each(['external', 'unknown'] as const)(
    'never counts a %s attempt or records an applied tracker row',
    async (applyType) => {
      const job = makeJob({ applyType });
      await putJob(job);
      const attempt = await createSubmission({
        runId: 'run',
        jobId: job.id,
        host: job.host,
        applyType,
        startedAt: Date.now(),
        status: 'started',
        documents: [],
        questionIds: [],
      });
      expect(await countAttemptTowardCapOnce(attempt.id)).toBe(false);
      expect(await getTodayCount()).toBe(0);
      expect((await trackApplied(job.id)).status).not.toBe('applied');
      expect((await getQueueSummary(makeSettings())).counts.applied ?? 0).toBe(0);
    },
  );
});

describe('isTransportDrop', () => {
  it.each([
    'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
    'The message port closed before a response was received.',
    'Could not establish connection. Receiving end does not exist.',
    'Extension context invalidated.',
  ])('treats a channel teardown as recoverable: %s', (message) => {
    expect(isTransportDrop(new Error(message))).toBe(true);
  });

  it('does not classify real failures as transport drops', () => {
    expect(isTransportDrop(new Error('Could not find an Apply button on the job page'))).toBe(
      false,
    );
    expect(isTransportDrop(undefined)).toBe(false);
  });
});
