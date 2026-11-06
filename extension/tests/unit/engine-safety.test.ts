import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  DEFAULT_SETTINGS,
  mergeSettings,
  type ApplyOptions,
  type ApplyResult,
  type ContentRequest,
  type Job,
  type QueueItem,
  type Settings,
} from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putQueueItem } from '@/core/orchestrator/queue';
import { getMeta, resetDb, setMeta } from '@/core/storage/db';
import { putJob } from '@/core/storage/jobs';
import { createSubmission, getSubmissionsForJob } from '@/core/storage/submissions';
import { saveAnswer } from '@/core/storage/answers';
import { saveSettings } from '@/core/storage/settings';
import { makeAnswer, makeJob, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const JOB_ID = '900001';
const ITEM: QueueItem = makeQueueItem({ jobId: JOB_ID, status: 'queued' }, 1);

function settings(): Settings {
  return mergeSettings(DEFAULT_SETTINGS, {
    onboardingComplete: true,
    mode: 'autopilot',
    pacing: { activeHours: null, minDelayMs: 10_000, maxDelayMs: 10_000 },
    safety: { reviewBeforeSubmit: false },
    search: { minFitScore: 0, savedSearches: [] },
  });
}

function tabManager(
  inspect: Job,
  apply: (request: Extract<ContentRequest, { type: 'content.apply' }>) => Promise<unknown>,
) {
  const send = vi.fn(async (request: ContentRequest) => {
    if (request.type === 'content.inspectJob') {
      return { requestId: request.requestId, ok: true, data: inspect };
    }
    if (request.type === 'content.apply') return apply(request);
    return { requestId: request.requestId, ok: true, data: null };
  });
  const tabs = {
    ensure: vi.fn(async () => 1),
    send,
    cancel: vi.fn(async () => undefined),
    id: 1,
    focus: vi.fn(async () => true),
  } as unknown as RunnerTabManager;
  return { tabs, send };
}

async function makeEngine(tabs: RunnerTabManager): Promise<Engine> {
  await saveSettings(settings());
  const job = makeJob({ id: JOB_ID, fitScore: 0.9, requiredDocumentTypes: [] }, 1);
  await putJob(job);
  await putQueueItem(ITEM);
  const engine = new Engine({
    tabs,
    broadcast: vi.fn(),
    clock: { now: () => 1_700_000_000_000, sleep: async () => {}, random: () => 0.5 },
  });
  await engine.load();
  engine.getState().status = 'running';
  return engine;
}

async function runApply(engine: Engine, item: QueueItem = ITEM): Promise<void> {
  await (engine as unknown as { apply(item: QueueItem, token: number): Promise<void> }).apply(
    item,
    0,
  );
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

describe('H1 — pause/stop cancels an in-flight apply', () => {
  it('sends content.cancel and returns the job to the queue without counting an attempt', async () => {
    let startApply: (() => void) | undefined;
    let resolveApply: ((value: unknown) => void) | undefined;
    const started = new Promise<void>((resolve) => (startApply = resolve));
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    const { tabs } = tabManager(
      job,
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
          startApply?.();
        }),
    );
    const engine = await makeEngine(tabs);

    const applying = runApply(engine);
    await started;
    await engine.pause();
    expect(tabs.cancel).toHaveBeenCalledWith(JOB_ID);

    resolveApply?.({
      requestId: (await getSubmissionsForJob(JOB_ID))[0]?.id,
      ok: false,
      error: appError('CANCELLED', 'Application cancelled', { retryable: false }),
    });
    await applying;

    expect(await getQueueItem(JOB_ID)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await getSubmissionsForJob(JOB_ID)).toEqual([]);
    expect(engine.getState().status).toBe('paused');
  });
});

describe('H2 — a lost apply response is never retried', () => {
  it('marks the row verifying instead of retrying or applying again', async () => {
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    const { tabs, send } = tabManager(job, async (request) => ({
      requestId: request.requestId,
      ok: false,
      error: appError('TIMEOUT', 'The page did not confirm the action', { retryable: false }),
    }));
    const engine = await makeEngine(tabs);

    await runApply(engine);

    expect(send.mock.calls.filter(([request]) => request.type === 'content.apply')).toHaveLength(1);
    expect(await getQueueItem(JOB_ID)).toMatchObject({ status: 'verifying' });
    expect(await getMeta(`needs:${JOB_ID}`)).toMatchObject({ reason: 'review' });
    const [attempt] = await getSubmissionsForJob(JOB_ID);
    expect(attempt?.status).toBe('ambiguous');
  });
});

describe('H3 — pause during a scan is not undone', () => {
  it('does not enqueue jobs or overwrite the paused state when the scan returns later', async () => {
    let startScan: (() => void) | undefined;
    let resolveScan: ((value: unknown) => void) | undefined;
    const started = new Promise<void>((resolve) => (startScan = resolve));
    const scannedJob = makeJob({ id: '900002' }, 1);
    const { tabs, send } = tabManager(scannedJob, async () => ({
      requestId: 'unused',
      ok: true,
      data: null,
    }));
    send.mockImplementation(async (request: ContentRequest) => {
      if (request.type === 'content.scan') {
        return new Promise((resolve) => {
          resolveScan = resolve;
          startScan?.();
        });
      }
      return { requestId: request.requestId, ok: true, data: null };
    });
    const engine = await makeEngine(tabs);

    const scanning = engine.scan();
    await started;
    await engine.pause();
    resolveScan?.({ ok: true, data: { jobs: [scannedJob], nextPageUrl: null, empty: false } });
    await scanning;

    expect(await getQueueItem('900002')).toBeUndefined();
    expect(engine.getState().status).toBe('paused');
    expect(engine.getState().scanComplete).toBeFalsy();
  });
});

describe('H4 — final rows are never applied', () => {
  it('skips an applied queue row even if a stale item is passed to apply', async () => {
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    const { tabs, send } = tabManager(job, async () => ({
      requestId: 'apply',
      ok: true,
      data: { jobId: JOB_ID, outcome: 'applied' } satisfies ApplyResult,
    }));
    const engine = await makeEngine(tabs);
    await putQueueItem({ ...ITEM, status: 'applied' });

    await runApply(engine);

    expect(send).not.toHaveBeenCalled();
  });
});

describe('L17 — waiting jobs get a retry time', () => {
  it('sets nextAttemptAt when the content result is waiting', async () => {
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    const { tabs } = tabManager(job, async (request) => ({
      requestId: request.requestId,
      ok: true,
      data: { jobId: JOB_ID, outcome: 'waiting' } satisfies ApplyResult,
    }));
    const engine = await makeEngine(tabs);

    await runApply(engine);

    const item = await getQueueItem(JOB_ID);
    expect(item?.status).toBe('waiting');
    expect(item?.nextAttemptAt).toBe(1_700_000_000_000 + 6 * 60 * 60_000);
  });
});

describe('L18 — reconcile resolves submissions for applied rows', () => {
  it('marks the write-ahead submission applied instead of leaving it unresolved', async () => {
    const job = makeJob({ id: JOB_ID }, 1);
    const { tabs } = tabManager(job, async () => ({ requestId: 'x', ok: true, data: null }));
    const engine = await makeEngine(tabs);
    await putQueueItem({ ...ITEM, status: 'applied' });
    const attempt = await createSubmission({
      runId: 'run-1',
      jobId: JOB_ID,
      host: job.host,
      startedAt: 1,
      status: 'ambiguous',
      applyType: job.applyType,
      documents: [],
      questionIds: [],
    });

    const blocked = await engine.reconcile();

    expect(blocked).toBe(false);
    const [resolved] = await getSubmissionsForJob(JOB_ID);
    expect(resolved).toMatchObject({ id: attempt.id, status: 'applied' });
    expect(resolved?.reconciledAt).toBeTypeOf('number');
  });
});

describe('M10 — job-specific answers precede the reusable bank', () => {
  it('passes the job answer first so an equal match wins', async () => {
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    let captured: ApplyOptions | undefined;
    const { tabs } = tabManager(job, async (request) => {
      captured = request.options;
      return {
        requestId: request.requestId,
        ok: true,
        data: { jobId: JOB_ID, outcome: 'ready_for_review' } satisfies ApplyResult,
      };
    });
    const engine = await makeEngine(tabs);
    await saveAnswer(
      makeAnswer(
        { id: 'bank-location', label: 'Preferred location', value: 'Remote', updatedAt: 1 },
        1,
      ),
    );
    await setMeta(`jobAnswers:${JOB_ID}`, [
      makeAnswer(
        { id: 'job-location', label: 'Preferred location', value: 'New York', updatedAt: 2 },
        2,
      ),
    ]);

    await runApply(engine);

    expect(captured?.answers[0]).toMatchObject({
      id: 'job-location',
      value: 'New York',
    });
  });
});

describe('M13 — an in-flight apply is drained before reset', () => {
  it('stop waits for the apply promise before reporting idle', async () => {
    let resolveApply: ((value: unknown) => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const job = makeJob({ id: JOB_ID, requiredDocumentTypes: [] }, 1);
    const { tabs } = tabManager(
      job,
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
          started?.();
        }),
    );
    const engine = await makeEngine(tabs);
    const applying = runApply(engine);
    await startedPromise;

    const stopping = engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveApply?.({
      requestId: (await getSubmissionsForJob(JOB_ID))[0]?.id,
      ok: false,
      error: appError('CANCELLED', 'cancelled', { retryable: false }),
    });
    await Promise.all([applying, stopping]);

    expect(engine.getState().status).toBe('idle');
    expect(await getQueueItem(JOB_ID)).toMatchObject({ status: 'queued' });
  });
});
