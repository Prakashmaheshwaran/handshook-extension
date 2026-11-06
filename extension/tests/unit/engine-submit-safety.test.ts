import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type ApplyResult,
  type ContentRequest,
  type QueueItem,
  type MessageResponse,
} from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import * as queue from '@/core/orchestrator/queue';
import * as submissions from '@/core/storage/submissions';
import * as settingsStore from '@/core/storage/settings';
import * as logger from '@/core/logging/logger';
import { getMeta, getTodayCount, resetDb } from '@/core/storage/db';
import { makeAnswer, makeJob, makeQueueItem } from '@/test/factories';
import { saveAnswer } from '@/core/storage/answers';
import { createFakeBrowser } from './helpers/fakeBrowser';
import { settleReviewResult } from '@/background/review-results';
import { clearEvents, listEvents } from '@/core/logging/eventStore';
import { settleReconciledSubmission } from '@/core/storage/submission-settlement';

const JOB = makeJob({ id: '900001', requiredDocumentTypes: [], fitScore: 0.9 }, 1);
const ITEM = makeQueueItem({ jobId: JOB.id, status: 'queued' }, 1);
const SETTINGS = mergeSettings(DEFAULT_SETTINGS, {
  onboardingComplete: true,
  mode: 'autopilot',
  safety: { reviewBeforeSubmit: false },
  search: { minFitScore: 0 },
  documents: { defaultResumeId: 'only-resume', autoSelectResume: false },
  pacing: { activeHours: null },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(
  apply?: (request: Extract<ContentRequest, { type: 'content.apply' }>) => Promise<ApplyResult>,
) {
  await settingsStore.saveSettings(SETTINGS);
  await queue.putJob(JOB);
  await queue.putQueueItem(ITEM);
  const tabs = {
    id: 7,
    ensure: vi.fn(async () => 7),
    cancel: vi.fn(async () => undefined),
    send: vi.fn(async (request: ContentRequest): Promise<MessageResponse<unknown>> => ({
      requestId: request.requestId,
      ok: true,
      data:
        request.type === 'content.inspectJob'
          ? JOB
          : request.type === 'content.apply'
            ? ((await apply?.(request)) ?? { jobId: JOB.id, outcome: 'ready_for_review' })
            : null,
    })),
  };
  const engine = new Engine({ tabs: tabs as unknown as RunnerTabManager });
  await engine.load();
  engine.getState().status = 'running';
  const run = () =>
    (engine as unknown as { apply(item: QueueItem, token: number): Promise<void> }).apply(ITEM, 0);
  return { engine, tabs, run };
}

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dispatch cancellation checkpoints', () => {
  for (const action of ['pause', 'stop'] as const) {
    for (const checkpoint of [
      'journal',
      'state',
      'queue',
      'navigation',
      'logging',
      'gate-logging',
    ] as const) {
      it(`${action} while awaiting ${checkpoint} prevents apply and leaves no submission journal`, async () => {
        const { engine, tabs, run } = await setup();
        // Trip an Autopilot gate that survives post-inspection filtering (a fit
        // score below minFitScore is now filtered after inspection instead).
        if (checkpoint === 'gate-logging')
          engine.getState().consecutiveFailures =
            engine.getSettings().pacing.maxConsecutiveFailures;
        const reached = deferred<void>();
        const release = deferred<void>();
        const block = async () => {
          reached.resolve();
          await release.promise;
        };
        if (checkpoint === 'journal') {
          const original = submissions.createSubmission;
          vi.spyOn(submissions, 'createSubmission').mockImplementationOnce(async (attempt) => {
            const created = await original(attempt);
            await block();
            return created;
          });
        } else if (checkpoint === 'state') {
          const original = settingsStore.saveEngineState;
          let blocked = false;
          vi.spyOn(settingsStore, 'saveEngineState').mockImplementation(async (state) => {
            await original(state);
            if (!blocked && state.currentPhase === 'opening') {
              blocked = true;
              await block();
            }
          });
        } else if (checkpoint === 'queue') {
          const original = queue.updateQueueItem;
          vi.spyOn(queue, 'updateQueueItem').mockImplementation(async (jobId, patch) => {
            const result = await original(jobId, patch);
            if (patch.status === 'opening') await block();
            return result;
          });
        } else if (checkpoint === 'navigation') {
          tabs.ensure.mockResolvedValueOnce(7).mockImplementationOnce(async () => {
            await block();
            return 7;
          });
        } else {
          const original = logger.log;
          vi.spyOn(logger, 'log').mockImplementation(async (...args) => {
            const result = await original(...args);
            if (
              args[1] ===
              (checkpoint === 'gate-logging' ? 'autopilot.review_required' : 'job.opening')
            )
              await block();
            return result;
          });
        }
        const applying = run();
        await reached.promise;
        await engine[action]();
        expect(tabs.cancel).toHaveBeenCalledWith(JOB.id);
        release.resolve();
        await applying;
        expect(tabs.send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(
          false,
        );
        expect(await queue.getQueueItem(JOB.id)).toMatchObject({
          status: 'queued',
          attempts: 0,
          submissionAttemptId: undefined,
        });
        expect(await submissions.getSubmissionsForJob(JOB.id)).toEqual([]);
        expect(await getTodayCount()).toBe(0);
        expect(engine.getState().status).toBe(action === 'pause' ? 'paused' : 'idle');
      });
    }
  }
});

describe('last-moment submit authorization', () => {
  it('grants only the exact active job, persisted attempt and runner tab', async () => {
    const reached = deferred<Extract<ContentRequest, { type: 'content.apply' }>>();
    const finish = deferred<ApplyResult>();
    const { engine, run } = await setup(async (request) => {
      reached.resolve(request);
      return finish.promise;
    });
    expect(engine.getState().runId).toBeUndefined();
    const applying = run();
    const request = await reached.promise;
    const [attempt] = await submissions.getSubmissionsForJob(JOB.id);
    expect(request.requestId).toBe(attempt?.id);
    expect(engine.getState().runId).toBeTruthy();
    expect(attempt?.runId).toBe(engine.getState().runId);
    expect((await settingsStore.loadEngineState()).runId).toBe(attempt?.runId);
    expect(await engine.authorizeSubmit(JOB.id, request.requestId, 7)).toBe(true);
    expect(await engine.authorizeSubmit('other', request.requestId, 7)).toBe(false);
    expect(await engine.authorizeSubmit(JOB.id, 'stale-attempt', 7)).toBe(false);
    expect(await engine.authorizeSubmit(JOB.id, request.requestId, 8)).toBe(false);
    expect(await engine.authorizeSubmit(JOB.id, request.requestId, undefined)).toBe(false);
    finish.resolve({ jobId: JOB.id, outcome: 'ready_for_review' });
    await applying;
    expect(await engine.authorizeSubmit(JOB.id, request.requestId, 7)).toBe(false);
  });

  for (const change of ['review', 'reviewBeforeSubmit', 'pause', 'stop'] as const) {
    it(`${change} revokes an in-flight grant and never restores it for that request`, async () => {
      const reached = deferred<Extract<ContentRequest, { type: 'content.apply' }>>();
      const finish = deferred<ApplyResult>();
      const { engine, tabs, run } = await setup(async (request) => {
        reached.resolve(request);
        return finish.promise;
      });
      const applying = run();
      const request = await reached.promise;
      if (change === 'review' || change === 'reviewBeforeSubmit') {
        await settingsStore.saveSettings(
          mergeSettings(
            SETTINGS,
            change === 'review' ? { mode: 'review' } : { safety: { reviewBeforeSubmit: true } },
          ),
        );
      } else {
        await engine[change]();
      }
      expect(await engine.authorizeSubmit(JOB.id, request.requestId, 7)).toBe(false);
      if (change === 'review' || change === 'reviewBeforeSubmit') {
        expect(tabs.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'content.revokeSubmit',
            jobId: JOB.id,
            applyRequestId: request.requestId,
          }),
          2_000,
        );
        await settingsStore.saveSettings(SETTINGS);
        expect(await engine.authorizeSubmit(JOB.id, request.requestId, 7)).toBe(false);
      }
      finish.resolve({ jobId: JOB.id, outcome: 'ready_for_review' });
      await applying;
      expect(await queue.getQueueItem(JOB.id)).toMatchObject({ status: 'ready_for_review' });
    });
  }
});

describe('uncertain submissions', () => {
  it.each(['protocol', 'request', 'job', 'schema'] as const)(
    'keeps a corrupt %s reply ambiguous, counted, and blocked from replay',
    async (corruption) => {
      const { engine, tabs, run } = await setup();
      tabs.send.mockImplementation(
        async (request: ContentRequest): Promise<MessageResponse<unknown>> => {
          if (request.type === 'content.inspectJob')
            return { requestId: request.requestId, ok: true, data: JOB };
          if (request.type !== 'content.apply')
            return { requestId: request.requestId, ok: true, data: null };
          if (corruption === 'protocol')
            return {
              requestId: request.requestId,
              ok: false,
              error: {
                code: 'PROTOCOL_MISMATCH',
                message: 'Reload the Handshake tab after checking My Jobs.',
                retryable: false,
              },
            };
          return {
            requestId: corruption === 'request' ? 'stale' : request.requestId,
            ok: true,
            data: {
              jobId: corruption === 'job' ? 'other' : JOB.id,
              outcome: corruption === 'schema' ? 'not-an-outcome' : 'applied',
              confirmationText: 'Application submitted',
            },
          };
        },
      );
      await run();
      expect((await queue.getQueueItem(JOB.id))?.status).toBe('verifying');
      expect((await submissions.getSubmissionsForJob(JOB.id))[0]).toMatchObject({
        status: 'ambiguous',
        capCountedAt: expect.any(Number),
      });
      expect(await getTodayCount()).toBe(1);
      expect(engine.getState().status).toBe('needs_user');
    },
  );
  it('keeps the cap marker when a journal update races accounting', async () => {
    const attempt = await submissions.createSubmission({
      runId: 'run-atomic',
      jobId: JOB.id,
      host: JOB.host,
      startedAt: Date.now(),
      status: 'ambiguous',
      applyType: JOB.applyType,
      documents: [],
      questionIds: [],
    });
    await Promise.all([
      submissions.updateSubmission(attempt.id, { reconciliationNote: 'Concurrent update' }),
      submissions.countAttemptTowardCapOnce(attempt.id),
    ]);
    expect((await submissions.getSubmissionsForJob(JOB.id))[0]?.capCountedAt).toEqual(
      expect.any(Number),
    );
    expect(await submissions.countAttemptTowardCapOnce(attempt.id)).toBe(false);
    expect(await getTodayCount()).toBe(1);
  });
  it('reserves the daily cap atomically when two result handlers count the same attempt', async () => {
    const attempt = await submissions.createSubmission({
      runId: 'run-1',
      jobId: JOB.id,
      host: JOB.host,
      startedAt: Date.now(),
      status: 'ambiguous',
      applyType: JOB.applyType,
      documents: [],
      questionIds: [],
    });
    const counted = await Promise.all([
      submissions.countAttemptTowardCapOnce(attempt.id),
      submissions.countAttemptTowardCapOnce(attempt.id),
    ]);
    expect(counted.filter(Boolean)).toHaveLength(1);
    expect(await getTodayCount()).toBe(1);
  });

  for (const result of [
    { jobId: JOB.id, outcome: 'verifying' },
    { jobId: JOB.id, outcome: 'applied', submittedAt: 1 },
  ] satisfies ApplyResult[]) {
    it(`keeps ${result.outcome} without evidence non-final, counted and blocked from replay`, async () => {
      const { engine, tabs, run } = await setup(async () => result);
      await run();
      expect(await queue.getQueueItem(JOB.id)).toMatchObject({ status: 'verifying' });
      expect(await getMeta(`needs:${JOB.id}`)).toMatchObject({ reason: 'review' });
      expect(await getTodayCount()).toBe(1);
      const [attempt] = await submissions.getSubmissionsForJob(JOB.id);
      expect(attempt).toMatchObject({ status: 'ambiguous', capCountedAt: expect.any(Number) });
      // A skip followed by restart/reconciliation cannot erase the replay barrier.
      await queue.putQueueItem({ ...ITEM, status: 'skipped' });
      expect(await engine.reconcile()).toBe(false);
      expect((await submissions.getSubmissionsForJob(JOB.id))[0]?.status).toBe('ambiguous');
      // Even a stale/requeued row must be held by the journal guard.
      await queue.putQueueItem(ITEM);
      engine.getState().status = 'running';
      await run();
      expect(
        tabs.send.mock.calls.filter(([request]) => request.type === 'content.apply'),
      ).toHaveLength(1);
      expect(await queue.getQueueItem(JOB.id)).toMatchObject({ status: 'needs_input' });
      expect(await getTodayCount()).toBe(1);
    });
  }

  it('counts uncertain sends once across concurrent counting and later positive reconciliation', async () => {
    const { engine, tabs, run } = await setup(async () => ({
      jobId: JOB.id,
      outcome: 'verifying',
    }));
    await run();
    const [attempt] = await submissions.getSubmissionsForJob(JOB.id);
    if (!attempt) throw new Error('Missing uncertain submission');
    expect(
      await Promise.all([
        submissions.countAttemptTowardCapOnce(attempt.id),
        submissions.countAttemptTowardCapOnce(attempt.id),
      ]),
    ).toEqual([false, false]);
    tabs.send.mockImplementation(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: { applied: true, jobId: JOB.id, host: JOB.host },
    }));
    expect(await engine.reconcile()).toBe(false);
    expect(await queue.getQueueItem(JOB.id)).toMatchObject({ status: 'applied' });
    expect(await getTodayCount()).toBe(1);
    expect(await engine.reconcile()).toBe(false);
    expect(await getTodayCount()).toBe(1);
  });
});

describe('reconciled Activity settlement', () => {
  it('records and broadcasts one applied event across concurrent reconciliation and a late Review result', async () => {
    const { engine, tabs, run } = await setup(async () => ({
      jobId: JOB.id,
      outcome: 'verifying',
    }));
    await run();
    const attempt = (await submissions.getSubmissionsForJob(JOB.id))[0];
    if (!attempt) throw new Error('Missing submission');
    const broadcast = vi.fn();
    engine.setBroadcast(broadcast);
    tabs.send.mockImplementation(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: { applied: true, jobId: JOB.id, host: JOB.host },
    }));
    await Promise.all([engine.reconcile(), engine.reconcile()]);
    await engine.reconcile();
    const late = await settleReviewResult(
      {
        type: 'content.event.result',
        requestId: attempt.id,
        jobId: JOB.id,
        result: {
          jobId: JOB.id,
          outcome: 'applied',
          confirmationText: 'Application submitted',
          submittedAt: Date.now(),
        },
      },
      attempt.runId,
    );
    expect(late).toEqual({ ok: true, value: false });
    expect((await listEvents()).filter((event) => event.type === 'job.applied')).toEqual([
      expect.objectContaining({ id: attempt.id, jobId: JOB.id }),
    ]);
    expect(
      broadcast.mock.calls.filter(
        ([message]) => message.type === 'event.appended' && message.event.type === 'job.applied',
      ),
    ).toHaveLength(1);
    expect(await getTodayCount()).toBe(1);

    await clearEvents();
    expect(
      await settleReconciledSubmission(
        attempt.id,
        JOB.id,
        JOB.host,
        'Verified applied on job page after restart',
      ),
    ).toEqual({ ok: true, value: null });
    expect(await listEvents()).toEqual([]);
    expect(await getTodayCount()).toBe(1);
  });

  it('records an applied Activity event when the queue settled before a worker restart', async () => {
    const { engine, tabs, run } = await setup(async () => ({
      jobId: JOB.id,
      outcome: 'verifying',
    }));
    await run();
    await queue.updateQueueItem(JOB.id, { status: 'applied' });
    tabs.send.mockClear();
    await engine.reconcile();
    await engine.reconcile();
    expect((await listEvents()).filter((event) => event.type === 'job.applied')).toHaveLength(1);
    expect(tabs.send).not.toHaveBeenCalled();
    expect(await getTodayCount()).toBe(1);
  });

  it.each(['host', 'attempt'] as const)(
    'does not settle or log mismatched %s identity',
    async (mismatch) => {
      const { run } = await setup(async () => ({ jobId: JOB.id, outcome: 'verifying' }));
      await run();
      const attempt = (await submissions.getSubmissionsForJob(JOB.id))[0];
      if (!attempt) throw new Error('Missing submission');
      if (mismatch === 'attempt')
        await queue.updateQueueItem(JOB.id, { submissionAttemptId: 'another-attempt' });
      expect(
        await settleReconciledSubmission(
          attempt.id,
          JOB.id,
          mismatch === 'host' ? 'school.joinhandshake.com' : JOB.host,
          'Verified applied on job page after restart',
        ),
      ).toMatchObject({ ok: false });
      expect((await queue.getQueueItem(JOB.id))?.status).toBe('verifying');
      expect((await listEvents()).filter((event) => event.type === 'job.applied')).toHaveLength(0);
      expect(await getTodayCount()).toBe(1);
    },
  );
});

describe('adversarial run changes', () => {
  for (const command of ['start', 'resume'] as const) {
    for (const cancel of ['pause', 'stop'] as const) {
      it(`${cancel} supersedes ${command} while reconciliation is pending`, async () => {
        const { engine } = await setup();
        engine.getState().status = 'paused';
        const reached = deferred<void>();
        const release = deferred<boolean>();
        vi.spyOn(engine, 'reconcile').mockImplementationOnce(async () => {
          reached.resolve();
          return release.promise;
        });
        const tick = vi.spyOn(engine, 'tick').mockResolvedValue();
        const starting = engine[command]();
        await reached.promise;
        await engine[cancel]();
        release.resolve(false);
        await starting;
        expect(engine.getState().status).toBe(cancel === 'pause' ? 'paused' : 'idle');
        expect(tick).not.toHaveBeenCalled();
      });
    }
  }
  it('rejects inspection from a different Handshake school before dispatching an apply', async () => {
    const { engine, tabs, run } = await setup();
    tabs.send.mockImplementation(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: { ...JOB, host: 'school.joinhandshake.com' },
    }));
    await run();
    expect(tabs.send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(false);
    expect(engine.getState().status).toBe('paused');
    expect(engine.getState().message).toMatch(/school changed/);
  });

  it('rejects an applied indicator from a different school during reconciliation', async () => {
    const { engine, tabs, run } = await setup(async () => ({
      jobId: JOB.id,
      outcome: 'verifying',
    }));
    await run();
    tabs.send.mockImplementation(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: { applied: true, jobId: JOB.id, host: 'school.joinhandshake.com' },
    }));
    expect(await engine.reconcile()).toBe(true);
    expect((await queue.getQueueItem(JOB.id))?.status).toBe('needs_input');
    expect((await submissions.getSubmissionsForJob(JOB.id))[0]?.status).toBe('ambiguous');
  });
  it('catches a detached tick failure and revokes automation with actionable recovery copy', async () => {
    const { engine } = await setup();
    const broadcast = vi.fn();
    engine.setBroadcast(broadcast);
    engine.getState().status = 'paused';
    vi.spyOn(engine, 'tick').mockRejectedValue(new Error('Storage unavailable'));
    await engine.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getState()).toMatchObject({ status: 'error', nextActionAt: undefined });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toast',
        level: 'error',
        message: expect.stringMatching(/check My Jobs before resuming/),
      }),
    );
  });
  it.each(['dry_run', 'review'] as const)(
    'preserves an explicitly started %s across Resume',
    async (mode) => {
      const { engine } = await setup();
      engine.getState().mode = mode;
      engine.getState().status = 'paused';
      vi.spyOn(engine, 'tick').mockResolvedValue();
      expect((await engine.resume()).mode).toBe(mode);
    },
  );

  it('latches a switch to dry run even when Settings is later changed back', async () => {
    const { engine } = await setup();
    await settingsStore.saveSettings(mergeSettings(SETTINGS, { mode: 'dry_run' }));
    expect((await engine.load()).mode).toBe('dry_run');
    await settingsStore.saveSettings(SETTINGS);
    expect((await engine.load()).mode).toBe('dry_run');
  });

  it.each(['pause', 'stop'] as const)(
    'keeps %s effective when a late Needs Input result settles',
    async (action) => {
      const reached = deferred<void>();
      const finish = deferred<ApplyResult>();
      const { engine, run } = await setup(async () => {
        reached.resolve();
        return finish.promise;
      });
      const applying = run();
      await reached.promise;
      await engine[action]();
      finish.resolve({ jobId: JOB.id, outcome: 'needs_input', missingDocumentTypes: ['resume'] });
      await applying;
      expect(engine.getState().status).toBe(action === 'pause' ? 'paused' : 'idle');
      expect((await queue.getQueueItem(JOB.id))?.status).toBe('needs_input');
    },
  );

  it('keeps the filled Review form on Resume instead of navigating to another job', async () => {
    const { engine, tabs, run } = await setup();
    await run();
    tabs.ensure.mockClear();
    const tick = vi.spyOn(engine, 'tick').mockResolvedValue();
    expect((await engine.resume()).status).toBe('needs_user');
    expect(tabs.ensure).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect((await queue.getQueueItem(JOB.id))?.status).toBe('ready_for_review');
    expect(await getTodayCount()).toBe(0);
  });

  it.each(['settings', 'documents', 'answers'] as const)(
    'revokes a grant when %s changes during filling',
    async (change) => {
      const reached = deferred<Extract<ContentRequest, { type: 'content.apply' }>>();
      const finish = deferred<ApplyResult>();
      const { engine, run } = await setup(async (request) => {
        reached.resolve(request);
        return finish.promise;
      });
      if (change === 'answers')
        await saveAnswer(makeAnswer({ id: 'bank-approved', autoSubmitAllowed: true }));
      const applying = run();
      const request = await reached.promise;
      if (change === 'settings') {
        await settingsStore.saveSettings(
          mergeSettings(SETTINGS, { documents: { defaultResumeId: 'different' } }),
        );
      } else if (change === 'documents') {
        await settingsStore.saveSettings(
          mergeSettings(SETTINGS, { documents: { defaultResumeName: 'Renamed Resume' } }),
        );
      } else {
        await saveAnswer(makeAnswer({ id: 'bank-approved', autoSubmitAllowed: false }));
      }
      expect(await engine.authorizeSubmit(JOB.id, request.requestId, 7)).toBe(false);
      finish.resolve({ jobId: JOB.id, outcome: 'ready_for_review' });
      await applying;
    },
  );
});
