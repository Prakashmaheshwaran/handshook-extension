import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type ContentRequest, type Job, type SettingsPatch } from '@/core/contracts';
import { evaluateJob } from '@/core/filters';
import { Engine } from '@/core/orchestrator/engine';
import {
  enqueueJobs,
  getJob,
  getNextQueued,
  getNextQueueWakeAt,
  getQueueItem,
  putJob,
  putQueueItem,
} from '@/core/orchestrator/queue';
import { RunnerTabManager, runnerTabs } from '@/core/orchestrator/tabs';
import { PACING_SESSION_KEY, RUNNER_SESSION_KEY } from '@/core/orchestrator/session';
import { scoreFit } from '@/core/scoring';
import { incrementTodayCount, resetDb } from '@/core/storage/db';
import { createSubmission } from '@/core/storage/submissions';
import { loadEngineState, saveEngineState, saveSettings } from '@/core/storage/settings';
import { makeEngineState, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const START = new Date('2026-10-27T12:00:00').getTime();
const clock = { now: () => Date.now(), sleep: async () => {}, random: () => 0.5 };
let fake: ReturnType<typeof createFakeBrowser>['fake'];
let session: Map<string, unknown>;

function discardWorkerTimers(): void {
  const at = Date.now();
  // Vitest clears timers via clock.reset(), which also restores the wall-clock
  // time captured when fake timers were installed. Suspension keeps time intact.
  vi.clearAllTimers();
  vi.setSystemTime(at);
}

function installBrowser() {
  ({ fake } = createFakeBrowser());
  session = new Map();
  const area = {
    get: async (key: string) => ({ [key]: session.get(key) }),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) session.set(key, value);
    },
  };
  vi.stubGlobal('browser', { ...fake, storage: { ...fake.storage, session: area } });
}

async function seed(patch: SettingsPatch = {}) {
  await saveSettings(
    makeSettings({
      onboardingComplete: true,
      mode: 'autopilot',
      search: { minFitScore: 0 },
      safety: { reviewBeforeSubmit: false },
      pacing: { activeHours: null, minDelayMs: 10_000, maxDelayMs: 10_000, jitterPercent: 0 },
      ...patch,
    }),
  );
  await saveEngineState(
    makeEngineState({
      runId: 'test-run',
      status: 'running',
      mode: 'autopilot',
      scanComplete: true,
    }),
  );
}

function content(job: Job, outcome = 'would_apply') {
  const send = vi.fn(async (request: ContentRequest) => ({
    requestId: request.requestId,
    ok: true,
    data:
      request.type === 'content.inspectJob'
        ? job
        : { jobId: job.id, outcome, confirmationText: 'Application submitted' },
  }));
  const tabs = {
    id: 7,
    ensure: vi.fn(async () => 7),
    send,
    cancel: vi.fn(async () => {}),
  } as unknown as RunnerTabManager;
  return { tabs, send };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  localStorage.clear();
  installBrowser();
  await resetDb();
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await resetDb();
});

describe('full detail filtering', () => {
  it('defers description-only include and score decisions until inspection', async () => {
    const settings = makeSettings({ search: { includeKeywords: ['python'], minFitScore: 0.3 } });
    const card = makeJob({ title: 'Developer', description: '' });
    expect(await enqueueJobs([card], settings, evaluateJob, START)).toEqual({
      queued: 1,
      filtered: 0,
    });
    expect((await getJob(card.id))?.fitReasons).toContain('Posted over three months ago');
    expect(evaluateJob({ ...card, description: 'Python development' }, settings, START).pass).toBe(
      false,
    );
    expect(
      evaluateJob(
        { ...card, description: 'Python development' },
        makeSettings({ search: { includeKeywords: ['python'], minFitScore: 0 } }),
        START,
      ).pass,
    ).toBe(true);
  });

  it('rejects only definitive known discovery fields and preserves the reason', async () => {
    const card = makeJob({ title: 'Senior Developer', description: '' });
    const settings = makeSettings({ search: { excludeKeywords: ['senior'] } });
    expect((await enqueueJobs([card], settings, evaluateJob, START)).filtered).toBe(1);
    expect((await getQueueItem(card.id))?.skipReason).toMatch(/excluded keyword: senior/i);
    expect(
      evaluateJob(
        { ...card, title: 'Developer', description: 'Senior team' },
        settings,
        START,
        'discovery',
      ).pass,
    ).toBe(true);
  });

  it.each([
    [
      'exclude',
      { excludeKeywords: ['clearance'] },
      { description: 'Security clearance required' },
      /excluded keyword/i,
    ],
    [
      'include',
      { includeKeywords: ['python'] },
      { description: 'Write Java services' },
      /no include keyword/i,
    ],
    ['location', { locations: ['New York'] }, { location: 'Austin' }, /location not in your list/i],
    [
      'type',
      { employmentTypes: ['Internship'] },
      { employmentType: 'Full-time' },
      /employment type/i,
    ],
  ] as [string, NonNullable<SettingsPatch['search']>, Partial<Job>, RegExp][])(
    'filters a post-inspection %s mismatch before dispatch',
    async (_name, search, details, reason) => {
      await seed({ search: { ...search, minFitScore: 0 } });
      const card = makeJob({
        title: 'Developer',
        description: '',
        location: undefined,
        employmentType: undefined,
      });
      await enqueueJobs(
        [card],
        makeSettings({ search: { ...search, minFitScore: 0 } }),
        evaluateJob,
        START,
      );
      const { tabs, send } = content({ ...card, ...details });
      const engine = new Engine({ tabs, clock });
      await engine.load();
      await engine.tick();
      expect((await getQueueItem(card.id))?.status).toBe('filtered');
      expect((await getQueueItem(card.id))?.skipReason).toMatch(reason);
      expect(send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(false);
      expect((await getJob(card.id))?.description).toBe(details.description ?? '');
    },
  );

  it('accepts a description-only include after inspection and recomputes fit', async () => {
    await seed({ search: { includeKeywords: ['python'], minFitScore: 0 } });
    const card = makeJob({ title: 'Developer', description: '', fitScore: 0.99 });
    await putJob(card);
    await putQueueItem(makeQueueItem());
    const { tabs, send } = content({ ...card, description: 'Python services' });
    const engine = new Engine({ tabs, clock });
    await engine.load();
    await engine.tick();
    expect(send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(true);
    expect((await getQueueItem(card.id))?.status).toBe('would_apply');
    expect((await getJob(card.id))?.fitScore).toBe(0.265);
  });
});

describe('due queue scheduling', () => {
  it('promotes only due waiting and explicitly retryable failed jobs', async () => {
    await putQueueItem(makeQueueItem({ status: 'waiting', nextAttemptAt: START + 1_000 }));
    await putQueueItem(
      makeQueueItem(
        {
          status: 'failed',
          attempts: 1,
          nextAttemptAt: START,
          lastError: appError('TIMEOUT', 'retry', { retryable: true }),
        },
        2,
      ),
    );
    await putQueueItem(
      makeQueueItem(
        {
          status: 'failed',
          attempts: 2,
          nextAttemptAt: START,
          lastError: appError('TIMEOUT', 'exhausted', { retryable: true }),
        },
        3,
      ),
    );
    await putQueueItem(makeQueueItem({ status: 'needs_input', nextAttemptAt: START }, 4));
    expect((await getNextQueued(START, 2))?.jobId).toBe('900002');
    expect((await getQueueItem('900001'))?.status).toBe('waiting');
    expect((await getQueueItem('900003'))?.status).toBe('failed');
    expect((await getQueueItem('900004'))?.status).toBe('needs_input');
    await getNextQueued(START + 1_000, 2);
    expect((await getQueueItem('900001'))?.status).toBe('queued');
  });

  it('keeps a run alive and schedules the earliest waiting or queued retry', async () => {
    await seed();
    await putQueueItem(makeQueueItem({ status: 'waiting', nextAttemptAt: START + 90_000 }));
    await putQueueItem(makeQueueItem({ nextAttemptAt: START + 45_000 }, 2));
    const engine = new Engine({ tabs: content(makeJob()).tabs, clock });
    await engine.load();
    await engine.tick();
    expect(await getNextQueueWakeAt(START, 2)).toBe(START + 45_000);
    expect(engine.getState()).toMatchObject({ status: 'running', nextActionAt: START + 45_000 });
    expect(fake.alarms.create).toHaveBeenLastCalledWith('handshook.tick', { when: START + 45_000 });
  });

  it('retries a waiting job after 22:00 without deferring it until morning', async () => {
    vi.setSystemTime(new Date('2026-10-27T21:59:00').getTime());
    await seed({ pacing: { activeHours: { start: '08:00', end: '22:00' } } });
    const job = makeJob({ requiredDocumentTypes: [] });
    await putJob(job);
    await putQueueItem(makeQueueItem({ status: 'waiting', nextAttemptAt: Date.now() + 120_000 }));
    const { tabs, send } = content(job);
    const engine = new Engine({ tabs, clock });
    await engine.load();
    await engine.tick();
    const retry = new Date('2026-10-27T22:01:00').getTime();
    expect(engine.getState().nextActionAt).toBe(retry);
    vi.setSystemTime(retry);
    await engine.onAlarm('handshook.tick');
    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(1);
  });

  it('releases an obsolete active-hours wait and requires an explicit resume', async () => {
    vi.setSystemTime(new Date('2026-10-27T23:00:00').getTime());
    await seed({ pacing: { activeHours: { start: '08:00', end: '22:00' } } });
    const job = makeJob({ requiredDocumentTypes: [] });
    await putJob(job);
    await putQueueItem(makeQueueItem());
    const { tabs, send } = content(job);
    await saveEngineState(
      makeEngineState({
        status: 'paused',
        mode: 'autopilot',
        scanComplete: true,
        pauseReason: 'active_hours',
        nextActionAt: new Date('2026-10-28T08:00:00').getTime(),
      }),
    );
    const engine = new Engine({ tabs, clock });
    await engine.load();
    expect(engine.getState()).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      nextActionAt: undefined,
      message: 'Active hours were removed. Resume when ready.',
    });
    await engine.onAlarm('handshook.tick');
    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(0);
    await engine.resume();
    await vi.waitFor(() =>
      expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(
        1,
      ),
    );
    expect(engine.getState().pauseReason).toBeUndefined();
    await engine.pause('user');
    vi.setSystemTime(new Date('2026-10-28T09:00:00').getTime());
    await engine.onAlarm('handshook.tick');
    expect(engine.getState()).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      nextActionAt: undefined,
    });
  });
});

describe('daily cap', () => {
  async function seedCapped(dailyCap: number) {
    await seed({
      pacing: {
        activeHours: null,
        minDelayMs: 10_000,
        maxDelayMs: 10_000,
        jitterPercent: 0,
        dailyCap,
      },
    });
    const first = makeJob({ requiredDocumentTypes: [] }, 1);
    const second = makeJob({ requiredDocumentTypes: [] }, 2);
    await putJob(first);
    await putJob(second);
    await putQueueItem(makeQueueItem({}, 1));
    await putQueueItem(makeQueueItem({}, 2));
    const jobs = new Map([first, second].map((job) => [job.id, job]));
    const send = vi.fn(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data:
        request.type === 'content.inspectJob'
          ? jobs.get(request.jobId)
          : request.type === 'content.apply'
            ? {
                jobId: request.job.id,
                outcome: 'applied',
                confirmationText: 'Application submitted',
              }
            : {},
    }));
    const tabs = {
      id: 7,
      ensure: vi.fn(async () => 7),
      send,
      cancel: vi.fn(async () => {}),
    } as unknown as RunnerTabManager;
    const applies = () => send.mock.calls.filter(([request]) => request.type === 'content.apply');
    return { tabs, applies };
  }

  it('ends the run like Stop once the daily cap is used, with nothing left to resume', async () => {
    const { tabs, applies } = await seedCapped(1);
    const engine = new Engine({ tabs, clock });
    await engine.load();
    await engine.tick();
    await vi.waitFor(() => expect(applies()).toHaveLength(1));
    await vi.waitFor(() => expect(engine.getState().todayCount).toBe(1));
    vi.setSystemTime(Date.now() + 60_000);
    await engine.onAlarm('handshook.tick');
    await engine.tick();
    expect(engine.getState()).toMatchObject({
      status: 'idle',
      pauseReason: undefined,
      nextActionAt: undefined,
      currentJobId: undefined,
    });
    expect(engine.getState().message).toContain('Daily cap reached (1/1). Run finished');
    expect(fake.alarms.clear).toHaveBeenLastCalledWith('handshook.tick');
    expect(await loadEngineState()).toMatchObject({ status: 'idle', pauseReason: undefined });
    // A late alarm after the run finished does nothing.
    vi.setSystemTime(Date.now() + 3_600_000);
    await engine.onAlarm('handshook.tick');
    expect(applies()).toHaveLength(1);
    expect(await getQueueItem(makeJob({}, 2).id)).toMatchObject({ status: 'queued' });
  });

  it('keeps Start idle with an explanation when the cap is already used', async () => {
    const { tabs, applies } = await seedCapped(1);
    await saveEngineState(makeEngineState({ status: 'idle', mode: 'autopilot' }));
    await incrementTodayCount();
    const engine = new Engine({ tabs, clock });
    const state = await engine.start('autopilot');
    expect(state.status).toBe('idle');
    expect(state.pauseReason).toBeUndefined();
    expect(state.message).toContain('Daily cap reached (1/1)');
    expect(applies()).toHaveLength(0);
  });

  it('turns a run that an older version parked in Paused at the cap into a finished run', async () => {
    await seed();
    await saveEngineState(
      makeEngineState({
        status: 'paused',
        mode: 'autopilot',
        pauseReason: 'cap_reached',
        pausedAt: START,
        message: 'Daily cap reached (15/15).',
      }),
    );
    expect(await loadEngineState()).toMatchObject({
      status: 'idle',
      pauseReason: undefined,
      pausedAt: undefined,
      nextActionAt: undefined,
    });
    expect((await loadEngineState()).message).toContain('Run finished');
  });
});

describe('MV3 recovery', () => {
  it('reconciles an uncertain submission before any automatic worker recovery', async () => {
    await seed();
    const job = makeJob({ requiredDocumentTypes: [] });
    await putJob(job);
    await putQueueItem(makeQueueItem());
    await createSubmission({
      runId: 'test-run',
      jobId: job.id,
      host: job.host,
      startedAt: START,
      status: 'started',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });
    const { tabs, send } = content(job);
    const engine = new Engine({ tabs, clock });
    await engine.recoverScheduledRun();
    expect(engine.getState().status).toBe('needs_user');
    expect(send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(false);
  });

  it('preserves a manual-review form if suspension preceded the engine-state write', async () => {
    await seed();
    await putQueueItem(makeQueueItem({ status: 'ready_for_review' }));
    const { tabs, send } = content(makeJob());
    const engine = new Engine({ tabs, clock });
    await engine.recoverScheduledRun();
    expect(engine.getState().status).toBe('needs_user');
    expect(send).not.toHaveBeenCalled();
  });

  it('restores a short delay after suspension and consumes alarm/timer once', async () => {
    await seed();
    const job = makeJob({ requiredDocumentTypes: [] });
    await putJob(job);
    await putQueueItem(makeQueueItem({ nextAttemptAt: START + 1_500 }));
    const { tabs, send } = content(job);
    const first = new Engine({ tabs, clock });
    await first.load();
    await first.tick();
    expect((await loadEngineState()).nextActionAt).toBe(START + 1_500);
    expect(fake.alarms.create).toHaveBeenLastCalledWith('handshook.tick', { when: START + 30_000 });
    discardWorkerTimers(); // MV3 discards the old worker's timer, not the clock.
    const restored = new Engine({ tabs, clock });
    await restored.recoverScheduledRun();
    expect(send).not.toHaveBeenCalled();
    vi.setSystemTime(START + 2_000);
    await Promise.all([restored.recoverScheduledRun(), restored.onAlarm('handshook.tick')]);
    await restored.onAlarm('handshook.tick');
    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(1);
  });

  it('reuses the pinned session-owned runner after a worker restart', async () => {
    const first = new RunnerTabManager();
    await first.ensure('https://app.joinhandshake.com/job-search');
    const restored = new RunnerTabManager();
    await restored.ensure('https://app.joinhandshake.com/jobs/900001');
    expect(restored.id).toBe(7);
    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
    expect(session.get(RUNNER_SESSION_KEY)).toEqual({ tabId: 7 });
  });

  it('serializes concurrent cold runner creation', async () => {
    const tabs = new RunnerTabManager();
    await Promise.all([
      tabs.ensure('https://app.joinhandshake.com/job-search'),
      tabs.ensure('https://app.joinhandshake.com/jobs/900001'),
    ]);
    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('retains ownership after a focus error while the runner is still alive', async () => {
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/job-search');
    fake.windows.update.mockRejectedValueOnce(new Error('Window focus unavailable'));
    expect(await tabs.focus()).toBe(false);
    expect(tabs.id).toBe(7);
    await tabs.ensure('https://app.joinhandshake.com/jobs/900001');
    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('pauses with a clear reason and forgets ownership when the runner closes', async () => {
    await seed();
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/job-search');
    const engine = new Engine({ tabs, clock });
    await engine.load();
    await engine.onRunnerRemoved(7);
    expect(engine.getState()).toMatchObject({
      status: 'paused',
      pauseReason: 'tab_closed',
      nextActionAt: undefined,
    });
    expect(engine.getState().message).toMatch(/runner tab was closed/i);
    expect(tabs.id).toBeNull();
    expect(session.get(RUNNER_SESSION_KEY)).toEqual({ tabId: null });
    await engine.onAlarm('handshook.tick');
    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('detects a runner removed while the worker was suspended', async () => {
    await seed();
    session.set(RUNNER_SESSION_KEY, { tabId: 99 });
    const tabs = new RunnerTabManager();
    const engine = new Engine({ tabs, clock });
    await engine.recoverScheduledRun();
    expect(engine.getState().pauseReason).toBe('tab_closed');
    expect(fake.tabs.create).not.toHaveBeenCalled();
  });

  it('uses the shared production runner manager', async () => {
    await seed();
    const engine = new Engine({ clock });
    await engine.load();
    await runnerTabs.ensure('https://app.joinhandshake.com/job-search');
    expect(engine.getRunnerTabId()).toBe(runnerTabs.id);
    await engine.onRunnerRemoved(7);
  });

  it('restores batch counts and an in-progress break across worker restarts', async () => {
    await seed({
      pacing: {
        activeHours: null,
        minDelayMs: 10_000,
        maxDelayMs: 10_000,
        jitterPercent: 0,
        sessionBatchSize: 2,
        useAdvanced: true,
        sessionBreakMinMs: 300_000,
        sessionBreakMaxMs: 300_000,
      },
    });
    const jobs = [1, 2, 3].map((index) => makeJob({ requiredDocumentTypes: [] }, index));
    for (const job of jobs) {
      await putJob(job);
      await putQueueItem(makeQueueItem({}, Number(job.id) - 900_000));
    }
    const { tabs, send } = content(jobs[0] as Job, 'applied');
    send.mockImplementation(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data:
        request.type === 'content.inspectJob'
          ? (jobs.find((job) => job.id === request.jobId) ?? makeJob())
          : {
              jobId: request.type === 'content.apply' ? request.job.id : '',
              outcome: 'applied',
              confirmationText: 'Application submitted',
            },
    }));
    const first = new Engine({ tabs, clock });
    await first.load();
    await first.tick();
    expect(session.get(PACING_SESSION_KEY)).toMatchObject({ applications: 1 });
    discardWorkerTimers();
    vi.setSystemTime(START + 10_000);
    const second = new Engine({ tabs, clock });
    await second.recoverScheduledRun();
    expect(session.get(PACING_SESSION_KEY)).toMatchObject({
      applications: 2,
      breakUntil: START + 310_000,
    });
    expect(second.getState().message).toMatch(/session batch complete/i);
    discardWorkerTimers();
    const third = new Engine({ tabs, clock });
    await third.recoverScheduledRun();
    vi.setSystemTime(START + 309_000);
    await third.onAlarm('handshook.tick');
    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(2);
    vi.setSystemTime(START + 310_000);
    await third.onAlarm('handshook.tick');
    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(3);
  });
});

describe('posting freshness', () => {
  it('prefers postedAt over a recent discovery and falls back for invalid dates', () => {
    const input = { title: 'Engineer', description: 'Engineer', discoveredAt: START, now: START };
    expect(
      scoreFit({ ...input, postedAt: new Date(START - 100 * 86_400_000).toISOString() }).breakdown
        .freshness,
    ).toBe(0.1);
    expect(scoreFit({ ...input, postedAt: 'invalid' }).breakdown.freshness).toBe(1);
  });
});
