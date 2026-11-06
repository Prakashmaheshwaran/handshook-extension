import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appError,
  type ApplyOptions,
  type Job,
  type MessageResponse,
  type QueueItem,
} from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { saveAnswer, saveJobAnswerOverride } from '@/core/storage/answers';
import { resetDb } from '@/core/storage/db';
import { createSubmission, getSubmissionsForJob } from '@/core/storage/submissions';
import { saveEngineState, saveSettings } from '@/core/storage/settings';
import { makeEngineState, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { getTodayCount } from '@/core/storage/db';

type FakeResponse = MessageResponse<unknown>;

// Keep failure/resume tests on a deterministic clock.
const daytimeClock = {
  now: () => new Date(2026, 9, 25, 12, 0, 0).getTime(),
  sleep: async () => undefined,
  random: () => 0.5,
};

function fakeTabs(
  send: (request: { type: string; requestId: string }) => FakeResponse,
): RunnerTabManager {
  return {
    ensure: async () => 1,
    cancel: async () => undefined,
    id: 1,
    send: async (request: { type: string; requestId: string }) => send(request),
  } as unknown as RunnerTabManager;
}

async function seedRunningEngine(job = makeJob({}, 1), queueItem?: QueueItem): Promise<void> {
  await saveSettings(
    makeSettings({
      onboardingComplete: true,
      mode: 'autopilot',
      pacing: { minDelayMs: 10_000, maxDelayMs: 10_000 },
    }),
  );
  await saveEngineState(
    makeEngineState({
      status: 'running',
      mode: 'autopilot',
      scanComplete: true,
      todayCount: 0,
    }),
  );
  await putJob(job);
  await putQueueItem(queueItem ?? makeQueueItem({ jobId: job.id, status: 'queued' }));
}

beforeEach(async () => {
  localStorage.clear();
  await resetDb();
  (globalThis as unknown as { browser: unknown }).browser = {
    alarms: {
      clear: async () => undefined,
      create: async () => undefined,
    },
  };
});

afterEach(async () => {
  delete (globalThis as unknown as { browser?: unknown }).browser;
  localStorage.clear();
  await resetDb();
});

describe('engine failure handling', () => {
  it('pauses with ui_changed instead of retrying when the apply control is missing', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await seedRunningEngine(job);
    const engine = new Engine({
      clock: daytimeClock,
      tabs: fakeTabs((request) => ({
        requestId: request.requestId,
        ok: false,
        error: appError('UI_CHANGED', 'Could not find an Apply button on the job page'),
      })),
    });
    await engine.load();

    await engine.tick();

    const state = engine.getState();
    expect(state.status).toBe('paused');
    expect(state.pauseReason).toBe('ui_changed');
    expect(state.message).toMatch(/apply button/i);
    const item = await getQueueItem(job.id);
    expect(item?.status).toBe('blocked');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError?.code).toBe('UI_CHANGED');
  });
});

describe('engine resume', () => {
  it('refreshes the mode from settings when resuming', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'review' }));
    await saveEngineState(
      makeEngineState({
        status: 'paused',
        mode: 'autopilot',
        scanComplete: true,
        runId: 'existing-run',
      }),
    );
    await putJob(job);
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    let appliedMode: string | undefined;
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          appliedMode = (request as { options?: { mode?: string } }).options?.mode;
          return {
            requestId: request.requestId,
            ok: true,
            data: { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    const state = await engine.resume();

    expect(state.mode).toBe('review');
    expect(state.runId).toBe('existing-run');
    await expect.poll(async () => appliedMode).toBe('review');
    await engine.stop();
  });

  it('resumes after the user answered the last pending question', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'autopilot' }));
    await saveEngineState(
      makeEngineState({ status: 'needs_user', mode: 'autopilot', scanComplete: true }),
    );
    await putJob(job);
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    const applied: string[] = [];
    const engine = new Engine({
      clock: daytimeClock,
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          applied.push(job.id);
          return {
            requestId: request.requestId,
            ok: true,
            data: { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    const state = await engine.resume();

    expect(state.status).toBe('running');
    expect(state.runId).toBeTruthy();
    await expect.poll(async () => applied.length).toBe(1);
    await expect.poll(async () => (await getQueueItem(job.id))?.status).toBe('applied');
    expect((await getSubmissionsForJob(job.id))[0]?.runId).toBe(state.runId);
    await engine.stop();
  });

  it('keeps an unresolved submission blocked before assigning a missing run identity', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'autopilot' }));
    await saveEngineState(
      makeEngineState({ status: 'needs_user', mode: 'autopilot', scanComplete: true }),
    );
    await putJob(job);
    const attempt = await createSubmission({
      runId: 'unresolved-run',
      jobId: job.id,
      host: job.host,
      startedAt: Date.now(),
      status: 'ambiguous',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });
    // A ready review remains a barrier even if its original run ID was lost.
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'ready_for_review', submissionAttemptId: attempt.id }),
    );
    const requests: string[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        requests.push(request.type);
        return { requestId: request.requestId, ok: true, data: { applied: false } };
      }),
    });

    const state = await engine.resume();

    expect(state.status).toBe('needs_user');
    expect(state.runId).toBeUndefined();
    expect(requests).not.toContain('content.apply');
    expect(await getSubmissionsForJob(job.id)).toEqual([attempt]);
  });
});

describe('engine scheduling', () => {
  it('schedules the next tick after a non-retryable UNKNOWN failure', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putJob(job);
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    const engine = new Engine({
      tabs: fakeTabs((request) =>
        request.type === 'content.apply'
          ? {
              requestId: request.requestId,
              ok: true,
              data: {
                jobId: job.id,
                outcome: 'failed',
                error: appError('UNKNOWN', 'The form could not be read', { retryable: false }),
              },
            }
          : { requestId: request.requestId, ok: true, data: job },
      ),
    });
    await engine.load();

    await engine.tick();

    const state = engine.getState();
    expect(state.status).toBe('running');
    expect(state.pauseReason).toBeUndefined();
    expect(state.nextActionAt).toEqual(expect.any(Number));
    expect((await getQueueItem(job.id))?.status).toBe('failed');
  });

  it('continues applying at night with a legacy active-hours setting', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        pacing: { activeHours: { start: '08:00', end: '22:00' } },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true }),
    );
    await putJob(job);
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    let applies = 0;
    const engine = new Engine({
      clock: {
        now: () => new Date('2026-10-25T23:30:00').getTime(),
        sleep: async () => undefined,
        random: () => 0.5,
      },
      tabs: fakeTabs((request) => {
        if (request.type === 'content.apply') applies += 1;
        return { requestId: request.requestId, ok: true, data: job };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(applies).toBe(1);
    expect(engine.getState().pauseReason).toBeUndefined();
  });
});

describe('engine reconciliation', () => {
  it.each(['started', 'submitted'] as const)(
    'reconciles an unresolved %s submission and counts it once',
    async (status) => {
      const job = makeJob({ id: '900001' }, 1);
      await saveEngineState(
        makeEngineState({ status: 'paused', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
      );
      await saveSettings(
        makeSettings({
          onboardingComplete: true,
          mode: 'autopilot',
          pacing: { minDelayMs: 10_000, maxDelayMs: 10_000 },
        }),
      );
      await putJob(job);
      const attempt = await createSubmission({
        runId: 'run-recovery',
        jobId: job.id,
        host: job.host,
        startedAt: Date.now(),
        status,
        applyType: 'quick_apply',
        documents: [],
        questionIds: [],
      });
      await putQueueItem(
        makeQueueItem({ jobId: job.id, status: 'opening', submissionAttemptId: attempt.id }),
      );
      const ensured: string[] = [];
      const tabs = fakeTabs((request) => {
        if (request.type === 'content.verifySubmission') {
          return {
            requestId: request.requestId,
            ok: true,
            data: { applied: true, status: 'applied', jobId: job.id, host: job.host },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      });
      tabs.ensure = async (url: string) => {
        ensured.push(url);
        return 1;
      };
      const engine = new Engine({ tabs });
      await engine.load();

      await engine.reconcile();

      expect(ensured).toEqual([job.url]);
      expect(engine.getState().todayCount).toBe(1);
      expect(await getTodayCount()).toBe(1);
      expect((await getQueueItem(job.id))?.status).toBe('applied');
      const submission = (await getSubmissionsForJob(attempt.jobId)).find(
        (entry) => entry.id === attempt.id,
      );
      expect(submission?.status).toBe('applied');
      expect(submission?.reconciliationNote).toMatch(/verified applied/i);

      // A second reconcile must not double-count an already-recovered submission.
      await engine.reconcile();
      expect(engine.getState().todayCount).toBe(1);
      expect(await getSubmissionsForJob(job.id)).toHaveLength(1);
    },
  );

  it('keeps the submission ambiguous for a skipped row without resurrecting the row', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'autopilot' }));
    await saveEngineState(
      makeEngineState({ status: 'needs_user', mode: 'autopilot', scanComplete: true }),
    );
    await putJob(job);
    const attempt = await createSubmission({
      runId: 'run-skip',
      jobId: job.id,
      host: job.host,
      startedAt: Date.now(),
      status: 'started',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'skipped', submissionAttemptId: attempt.id }),
    );
    const engine = new Engine({
      tabs: fakeTabs(() => ({ requestId: 'noop', ok: true, data: {} })),
    });
    await engine.load();

    const blocked = await engine.reconcile();

    expect(blocked).toBe(false);
    expect((await getQueueItem(job.id))?.status).toBe('skipped');
    const submission = (await getSubmissionsForJob(job.id)).find(
      (entry) => entry.id === attempt.id,
    );
    expect(submission?.status).toBe('ambiguous');
    expect(submission?.reconciliationNote).toMatch(/skipped/i);
  });

  it('does not auto-apply an unresolved submission it cannot verify', async () => {
    const job = makeJob({ id: '900001' }, 1);
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'autopilot' }));
    await saveEngineState(
      makeEngineState({ status: 'paused', mode: 'autopilot', scanComplete: true }),
    );
    await putJob(job);
    const attempt = await createSubmission({
      runId: 'run-recovery',
      jobId: job.id,
      host: job.host,
      startedAt: Date.now(),
      status: 'started',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'opening', submissionAttemptId: attempt.id }),
    );
    const engine = new Engine({
      tabs: fakeTabs((request) => ({
        requestId: request.requestId,
        ok: true,
        data: { applied: false, status: 'verifying' },
      })),
    });
    await engine.load();

    await engine.reconcile();

    expect(engine.getState().status).toBe('needs_user');
    expect(engine.getState().todayCount).toBe(1);
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
    expect(
      (await getSubmissionsForJob(attempt.jobId)).find((entry) => entry.id === attempt.id)?.status,
    ).toBe('ambiguous');
  });
});

describe('autopilot scoring and mode', () => {
  it('recomputes the fit score after inspectJob and submits a good fit', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await putJob({ ...job, fitScore: 0.9, fitReasons: ['strong match'], source: 'search' });
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0.55 },
        documents: { defaultResumeId: 'only-resume' },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    // DOM inspection returns no fit metadata; the engine must recompute it.
    const inspected: Job = { ...job };
    delete inspected.fitScore;
    delete inspected.fitReasons;
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: inspected };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data: options.reviewBeforeSubmit
              ? { jobId: job.id, outcome: 'ready_for_review' }
              : { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.reviewBeforeSubmit).toBe(false);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
  });

  it('uses inspected details instead of a stale low discovery score', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await putJob({ ...job, fitScore: 0.2, fitReasons: ['weak match'], source: 'search' });
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0.55 },
        documents: { defaultResumeId: 'only-resume' },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data: options.reviewBeforeSubmit
              ? { jobId: job.id, outcome: 'ready_for_review' }
              : { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(calls[0]?.reviewBeforeSubmit).toBe(false);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
    expect(await getTodayCount()).toBe(1);
  });

  it('turns a mid-run switch to Review into a review-only apply', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0 },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putJob({ ...job, fitScore: 0.9 });
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data:
              options.mode === 'review' || options.reviewBeforeSubmit
                ? { jobId: job.id, outcome: 'ready_for_review' }
                : { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();
    // Simulate the router handling a Settings update mid-run.
    await saveSettings(makeSettings({ onboardingComplete: true, mode: 'review' }));
    await engine.load();

    await engine.tick();

    expect(engine.getState().mode).toBe('review');
    expect(calls[0]?.mode).toBe('review');
    expect(calls[0]?.reviewBeforeSubmit).toBe(true);
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
    expect(await getTodayCount()).toBe(0);
  });
});

describe('explicit Needs You answers', () => {
  const answer = {
    id: 'q-work-auth',
    label: 'Are you authorized to work in the United States?',
    aliases: [],
    type: 'select' as const,
    value: 'yes',
    options: { Yes: 'yes' },
    category: 'work' as const,
    autoSubmitAllowed: false,
    sensitive: true,
    updatedAt: 1,
  };

  it('fills the user-supplied answer and stops at review without the sensitive opt-in', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false, allowSensitiveAutoSubmit: false },
        search: { minFitScore: 0 },
        documents: { defaultResumeId: 'only-resume' },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putJob({ ...job, fitScore: 0.9 });
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    await saveJobAnswerOverride(job.id, answer);
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data: options.reviewBeforeSubmit
              ? { jobId: job.id, outcome: 'ready_for_review' }
              : { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(calls[0]?.reviewBeforeSubmit).toBe(true);
    expect(calls[0]?.explicitAnswerIds).toEqual([answer.id]);
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
    expect(await getTodayCount()).toBe(0);
  });

  it('prefers a newer bank answer over a stale job override', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false, allowSensitiveAutoSubmit: true },
        search: { minFitScore: 0 },
        documents: { defaultResumeId: 'only-resume' },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putJob({ ...job, fitScore: 0.9 });
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    await saveJobAnswerOverride(job.id, { ...answer, value: 'no', updatedAt: 1 });
    // saveAnswer stamps updatedAt=now, so the bank edit is newer than the override.
    await saveAnswer({ ...answer, value: 'yes', updatedAt: 1 });
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data: { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(calls[0]?.answers.find((entry) => entry.id === answer.id)?.value).toBe('yes');
    expect(calls[0]?.answers.filter((entry) => entry.id === answer.id)).toHaveLength(1);
  });

  it('auto-submits an explicit answer only when per-answer and global opt-ins are on', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false, allowSensitiveAutoSubmit: true },
        search: { minFitScore: 0 },
        documents: { defaultResumeId: 'only-resume' },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putJob({ ...job, fitScore: 0.9 });
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    await saveJobAnswerOverride(job.id, { ...answer, autoSubmitAllowed: true });
    const calls: ApplyOptions[] = [];
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') {
          const options = (request as unknown as { options: ApplyOptions }).options;
          calls.push(options);
          return {
            requestId: request.requestId,
            ok: true,
            data: options.reviewBeforeSubmit
              ? { jobId: job.id, outcome: 'ready_for_review' }
              : { jobId: job.id, outcome: 'applied', confirmationText: 'Application submitted' },
          };
        }
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(calls[0]?.reviewBeforeSubmit).toBe(false);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
  });
});

describe('skipping an in-flight apply', () => {
  async function runSkippedApply(outcome: 'applied' | 'verifying') {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await putJob({ ...job, fitScore: 0.9 });
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0 },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelled = 0;
    const engine = new Engine({
      tabs: {
        ensure: async () => 1,
        cancel: async () => {
          cancelled += 1;
        },
        id: 1,
        send: async (request: { type: string; requestId: string }) => {
          if (request.type === 'content.inspectJob') {
            return { requestId: request.requestId, ok: true, data: job };
          }
          if (request.type === 'content.apply') {
            started?.();
            await applyReleased;
            return {
              requestId: request.requestId,
              ok: true,
              data: {
                jobId: job.id,
                outcome,
                ...(outcome === 'applied'
                  ? { confirmationText: 'Application submitted' }
                  : { error: appError('CANCELLED', 'Stopped after clicking Submit') }),
              },
            };
          }
          return { requestId: request.requestId, ok: true, data: {} };
        },
      } as unknown as RunnerTabManager,
    });
    await engine.load();

    const ticking = engine.tick();
    await applyStarted;
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'skipped' }));
    expect(await engine.cancelActiveJob(job.id)).toBe(true);
    release?.();
    await ticking;
    return { engine, job, cancelled };
  }

  it('marks a late applied result applied and immutable', async () => {
    const { engine, job, cancelled } = await runSkippedApply('applied');

    expect(cancelled).toBe(1);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
    expect(await getTodayCount()).toBe(1);
    const submission = (await getSubmissionsForJob(job.id))[0];
    expect(submission?.status).toBe('applied');
    expect(engine.getState().status).toBe('running');
    expect(engine.getState().nextActionAt).toEqual(expect.any(Number));
  });

  it('records an ambiguous submission for a late verifying result and keeps retry blocked', async () => {
    const { engine, job, cancelled } = await runSkippedApply('verifying');

    expect(cancelled).toBe(1);
    // The row stays skipped, but the journal must not say "failed": retry has
    // to route through reconciliation first.
    expect((await getQueueItem(job.id))?.status).toBe('skipped');
    const submission = (await getSubmissionsForJob(job.id))[0];
    expect(submission?.status).toBe('ambiguous');
    expect(await getTodayCount()).toBe(1);
    expect(engine.getState().status).toBe('running');
    expect(engine.getState().nextActionAt).toEqual(expect.any(Number));
  });
});

describe('submission replay defense', () => {
  it('refuses to apply when the journal already has an applied submission', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await putJob({ ...job, fitScore: 0.9 });
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0 },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
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
    let applies = 0;
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') applies += 1;
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(applies).toBe(0);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
  });

  it('routes an ambiguous journal entry to Needs instead of applying', async () => {
    const job = makeJob({ id: '900001', requiredDocumentTypes: [] }, 1);
    await putJob({ ...job, fitScore: 0.9 });
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        mode: 'autopilot',
        safety: { reviewBeforeSubmit: false },
        search: { minFitScore: 0 },
        pacing: { activeHours: null, minDelayMs: 60_000, maxDelayMs: 60_000 },
      }),
    );
    await saveEngineState(
      makeEngineState({ status: 'running', mode: 'autopilot', scanComplete: true, todayCount: 0 }),
    );
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    await createSubmission({
      runId: 'run-ambiguous',
      jobId: job.id,
      host: job.host,
      startedAt: 1,
      status: 'ambiguous',
      applyType: 'quick_apply',
      documents: [],
      questionIds: [],
    });
    let applies = 0;
    const engine = new Engine({
      tabs: fakeTabs((request) => {
        if (request.type === 'content.inspectJob') {
          return { requestId: request.requestId, ok: true, data: job };
        }
        if (request.type === 'content.apply') applies += 1;
        return { requestId: request.requestId, ok: true, data: {} };
      }),
    });
    await engine.load();

    await engine.tick();

    expect(applies).toBe(0);
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
    expect(engine.getState().status).toBe('needs_user');
  });
});
