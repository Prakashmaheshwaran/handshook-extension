import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppError,
  type Job,
  type JobStatus,
  type QueueItem,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { getTodayCount, incrementTodayCount, resetDb, setMeta } from '@/core/storage/db';
import { createPacer } from '@/core/orchestrator/pacer';
import { countJobs, deleteJob, getJob, listJobs, putJob } from '@/core/storage/jobs';
import {
  getQueueItem,
  getQueueSummary,
  isRetryableStatus,
  isTerminalStatus,
  isTracked,
  listQueue,
  pruneTracker,
  trackAlreadyApplied,
  trackApplied,
  trackExternal,
  trackFailed,
  trackNeedsInput,
  trackStatus,
  trackWaiting,
  updateQueueItem,
  upsertQueueItem,
} from '@/core/storage/tracker';
import { todayKey } from '@/core/util/time';

const DAY_MS = 86_400_000;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '1001',
    host: 'app.joinhandshake.com',
    title: 'Software Engineer Intern',
    employer: 'Acme',
    url: 'https://app.joinhandshake.com/jobs/1001',
    description: 'Build things with TypeScript.',
    location: 'San Francisco, CA',
    employmentType: 'Internship',
    remote: false,
    applyType: 'quick_apply',
    requiredDocumentTypes: [],
    source: 'search',
    discoveredAt: 1_000,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    jobId: '1001',
    status: 'queued',
    priority: 0,
    attempts: 0,
    addedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(structuredClone(DEFAULT_SETTINGS), patch);
}

const seed = {
  host: 'app.joinhandshake.com',
  title: 'Backend Intern',
  employer: 'Acme',
  url: 'https://app.joinhandshake.com/jobs/1001',
};

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('job repository', () => {
  it('stores, reads, overwrites, and deletes jobs', async () => {
    await putJob(makeJob());
    await expect(getJob('1001')).resolves.toMatchObject({ title: 'Software Engineer Intern' });
    await expect(countJobs()).resolves.toBe(1);

    await putJob(makeJob({ title: 'Renamed role' }));
    await expect(getJob('1001')).resolves.toMatchObject({ title: 'Renamed role' });
    await expect(countJobs()).resolves.toBe(1);

    await deleteJob('1001');
    await expect(getJob('1001')).resolves.toBeUndefined();
    await expect(countJobs()).resolves.toBe(0);
  });

  it('lists jobs newest first and honours the limit', async () => {
    await putJob(makeJob({ id: '1', discoveredAt: 100 }));
    await putJob(makeJob({ id: '2', discoveredAt: 300 }));
    await putJob(makeJob({ id: '3', discoveredAt: 200 }));

    await expect(listJobs().then((jobs) => jobs.map((job) => job.id))).resolves.toEqual([
      '2',
      '3',
      '1',
    ]);
    await expect(listJobs(2).then((jobs) => jobs.map((job) => job.id))).resolves.toEqual([
      '2',
      '3',
    ]);
    await expect(listJobs(0)).resolves.toEqual([]);
  });

  it('breaks discoveredAt ties by id for deterministic ordering', async () => {
    await putJob(makeJob({ id: 'b', discoveredAt: 100 }));
    await putJob(makeJob({ id: 'a', discoveredAt: 100 }));

    await expect(listJobs().then((jobs) => jobs.map((job) => job.id))).resolves.toEqual(['a', 'b']);
  });
});

describe('queue tracking', () => {
  it('upserts and reads queue items', async () => {
    await upsertQueueItem(makeQueueItem());
    await expect(getQueueItem('1001')).resolves.toMatchObject({ status: 'queued' });

    await upsertQueueItem(makeQueueItem({ status: 'applied' }));
    await expect(getQueueItem('1001')).resolves.toMatchObject({ status: 'applied' });
    await expect(listQueue()).resolves.toHaveLength(1);
  });

  it('lists by priority descending then addedAt ascending with pagination', async () => {
    await upsertQueueItem(makeQueueItem({ jobId: 'a', priority: 5, addedAt: 100 }));
    await upsertQueueItem(makeQueueItem({ jobId: 'b', priority: 10, addedAt: 200 }));
    await upsertQueueItem(makeQueueItem({ jobId: 'c', priority: 10, addedAt: 50 }));

    await expect(listQueue().then((items) => items.map((item) => item.jobId))).resolves.toEqual([
      'c',
      'b',
      'a',
    ]);
    await expect(
      listQueue({ limit: 1, offset: 1 }).then((items) => items.map((item) => item.jobId)),
    ).resolves.toEqual(['b']);
  });

  it('filters the queue by status', async () => {
    await upsertQueueItem(makeQueueItem({ jobId: 'a', status: 'queued' }));
    await upsertQueueItem(makeQueueItem({ jobId: 'b', status: 'applied' }));
    await upsertQueueItem(makeQueueItem({ jobId: 'c', status: 'failed' }));

    const items = await listQueue({ status: ['applied', 'failed'] });
    await expect(Promise.resolve(items.map((item) => item.jobId).sort())).resolves.toEqual([
      'b',
      'c',
    ]);
    await expect(listQueue({ status: [] })).resolves.toHaveLength(3);
  });

  it('updates an item, bumping updatedAt but never jobId or addedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await upsertQueueItem(makeQueueItem({ addedAt: 1_000, updatedAt: 1_000 }));

    const updated = await updateQueueItem('1001', {
      status: 'failed',
      jobId: 'hijacked',
      addedAt: 9_999,
    });
    expect(updated).toMatchObject({
      jobId: '1001',
      addedAt: 1_000,
      status: 'failed',
      updatedAt: 5_000,
    });
    await expect(getQueueItem('1001')).resolves.toMatchObject({ status: 'failed' });
  });

  it('returns undefined when updating an untracked job', async () => {
    await expect(updateQueueItem('missing', { status: 'failed' })).resolves.toBeUndefined();
  });

  it('creates a queue item with defaults on first track', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_000);
    const item = await trackStatus('42', 'queued', { priority: 3 });
    expect(item).toEqual({
      jobId: '42',
      status: 'queued',
      priority: 3,
      attempts: 0,
      addedAt: 7_000,
      updatedAt: 7_000,
    });
  });

  it('treats terminal statuses as tracked and retryable ones as untracked', async () => {
    const terminal: JobStatus[] = [
      'applied',
      'external',
      'already_applied',
      'skipped',
      'blocked',
      'filtered',
    ];
    for (const [index, status] of terminal.entries()) {
      const jobId = `terminal-${index}`;
      await trackStatus(jobId, status);
      expect(isTerminalStatus(status)).toBe(true);
      await expect(isTracked(jobId)).resolves.toBe(status);
    }

    const retryable: JobStatus[] = ['queued', 'failed', 'waiting', 'needs_input', 'discovered'];
    for (const [index, status] of retryable.entries()) {
      const jobId = `retryable-${index}`;
      await trackStatus(jobId, status);
      expect(isRetryableStatus(status)).toBe(
        status === 'failed' || status === 'waiting' || status === 'needs_input',
      );
      await expect(isTracked(jobId)).resolves.toBeNull();
    }

    await expect(isTracked('never-seen')).resolves.toBeNull();
  });

  it('tracks an application once per job and creates the job record from a seed', async () => {
    const first = await trackApplied('1001', { ...seed, applyType: 'handshake_form' });
    const second = await trackApplied('1001', {
      ...seed,
      applyType: 'handshake_form',
      title: 'Ignored seed',
    });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    await expect(listQueue()).resolves.toHaveLength(1);
    await expect(getJob('1001')).resolves.toMatchObject({ title: 'Backend Intern' });
    await expect(countJobs()).resolves.toBe(1);
  });

  it('records retryable failures, waiting times, and needs-input details', async () => {
    const error: AppError = {
      code: 'NETWORK',
      message: 'Temporary network error',
      retryable: true,
    };
    await trackFailed('1001', error);
    const failed = await getQueueItem('1001');
    expect(failed).toMatchObject({ status: 'failed', lastError: error });

    await trackWaiting('1001', 42_000);
    await expect(getQueueItem('1001')).resolves.toMatchObject({
      status: 'waiting',
      nextAttemptAt: 42_000,
    });

    await trackNeedsInput('1001', {
      pendingQuestionIds: ['q1'],
      missingDocumentTypes: ['resume'],
    });
    await expect(getQueueItem('1001')).resolves.toMatchObject({
      status: 'needs_input',
      pendingQuestionIds: ['q1'],
      missingDocumentTypes: ['resume'],
    });
  });

  it('tracks external and already-applied jobs as terminal with seeded details', async () => {
    await trackExternal('2001', { ...seed, url: 'https://app.joinhandshake.com/jobs/2001' });
    await trackAlreadyApplied('2002', { ...seed, url: 'https://app.joinhandshake.com/jobs/2002' });

    await expect(isTracked('2001')).resolves.toBe('external');
    await expect(isTracked('2002')).resolves.toBe('already_applied');
    await expect(countJobs()).resolves.toBe(2);
  });

  it('prunes only old external/skipped/filtered items and never applied ones', async () => {
    const now = new Date(2026, 9, 25, 12, 0, 0).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const old = now - 40 * DAY_MS;
    const recent = now - 10 * DAY_MS;

    await upsertQueueItem(
      makeQueueItem({ jobId: 'old-external', status: 'external', updatedAt: old }),
    );
    await upsertQueueItem(
      makeQueueItem({ jobId: 'old-skipped', status: 'skipped', updatedAt: old }),
    );
    await upsertQueueItem(
      makeQueueItem({ jobId: 'old-filtered', status: 'filtered', updatedAt: old }),
    );
    await upsertQueueItem(
      makeQueueItem({ jobId: 'old-blocked', status: 'blocked', updatedAt: old }),
    );
    await upsertQueueItem(
      makeQueueItem({ jobId: 'recent-external', status: 'external', updatedAt: recent }),
    );
    await upsertQueueItem(
      makeQueueItem({ jobId: 'ancient-applied', status: 'applied', updatedAt: old }),
    );
    await upsertQueueItem(makeQueueItem({ jobId: 'old-failed', status: 'failed', updatedAt: old }));

    await expect(pruneTracker(30)).resolves.toBe(3);
    await expect(getQueueItem('old-external')).resolves.toBeUndefined();
    await expect(getQueueItem('old-skipped')).resolves.toBeUndefined();
    await expect(getQueueItem('old-filtered')).resolves.toBeUndefined();
    await expect(getQueueItem('old-blocked')).resolves.toBeDefined();
    await expect(getQueueItem('recent-external')).resolves.toBeDefined();
    await expect(getQueueItem('ancient-applied')).resolves.toBeDefined();
    await expect(getQueueItem('old-failed')).resolves.toBeDefined();
  });

  it('ignores invalid prune windows', async () => {
    await upsertQueueItem(makeQueueItem({ jobId: 'old', status: 'skipped', updatedAt: 0 }));
    await expect(pruneTracker(-1)).resolves.toBe(0);
    await expect(pruneTracker(Number.NaN)).resolves.toBe(0);
    await expect(getQueueItem('old')).resolves.toBeDefined();
  });

  it('summarizes counts, today count, remaining cap, and the current job', async () => {
    const today = new Date(2026, 9, 25, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(today);
    await setMeta(`dailyCount:${todayKey(today)}`, 5);
    const settings = makeSettings();

    await upsertQueueItem(makeQueueItem({ jobId: 'queued-1', status: 'queued', priority: 99 }));
    await upsertQueueItem(makeQueueItem({ jobId: 'running-1', status: 'filling', priority: 1 }));

    const summary = await getQueueSummary(settings);
    expect(summary.counts).toEqual({ queued: 1, filling: 1 });
    expect(summary.total).toBe(2);
    expect(summary.todayCount).toBe(5);
    expect(summary.dailyCap).toBe(settings.pacing.dailyCap);
    expect(summary.remainingToday).toBe(settings.pacing.dailyCap - 5);
    expect(summary.currentJobId).toBe('running-1');
  });

  it('never reports a negative remaining count', async () => {
    const today = new Date(2026, 9, 25, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(today);
    await setMeta(`dailyCount:${todayKey(today)}`, 500);

    const summary = await getQueueSummary(makeSettings());
    expect(summary.remainingToday).toBe(0);
    expect(summary.currentJobId).toBeUndefined();
  });

  it('resets the daily cap at local midnight and preserves the previous day count', async () => {
    const beforeMidnight = new Date(2026, 11, 31, 23, 59, 59, 999);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beforeMidnight);
    const settings = makeSettings({ pacing: { dailyCap: 1, hardCap: 1, activeHours: null } });
    const pacer = createPacer(settings, {
      now: () => Date.now(),
      sleep: async () => {},
      random: () => 0.5,
    });

    await incrementTodayCount();
    await expect(getQueueSummary(settings)).resolves.toMatchObject({
      todayCount: 1,
      remainingToday: 0,
    });
    expect(pacer.canApplyToday(await getTodayCount())).toBe(false);

    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 0, 0));
    await expect(getQueueSummary(settings)).resolves.toMatchObject({
      todayCount: 0,
      remainingToday: 1,
    });
    expect(pacer.canApplyToday(await getTodayCount())).toBe(true);
    await expect(incrementTodayCount()).resolves.toBe(1);
    await expect(getTodayCount(beforeMidnight)).resolves.toBe(1);
    expect(pacer.canApplyToday(await getTodayCount())).toBe(false);
  });
});
