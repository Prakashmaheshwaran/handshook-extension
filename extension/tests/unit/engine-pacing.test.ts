import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentRequest } from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { PACING_SESSION_KEY } from '@/core/orchestrator/session';
import { resetDb } from '@/core/storage/db';
import { saveEngineState, saveSettings } from '@/core/storage/settings';
import { putJob, putQueueItem, getQueueItem, getJob } from '@/core/orchestrator/queue';
import { listEvents } from '@/core/logging/eventStore';
import { makeEngineState, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const START = new Date(2026, 9, 27, 12).getTime();
const clock = { now: () => Date.now(), random: () => 0.5, sleep: async () => {} };
let session: Map<string, unknown>;
let fake: ReturnType<typeof createFakeBrowser>['fake'];

beforeEach(async () => {
  localStorage.clear();
  await resetDb();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  ({ fake } = createFakeBrowser());
  session = new Map();
  vi.stubGlobal('browser', {
    ...fake,
    storage: {
      ...fake.storage,
      session: {
        get: async (key: string) => ({ [key]: session.get(key) }),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        },
      },
    },
  });
  await saveSettings(
    makeSettings({
      onboardingComplete: true,
      pacing: { activeHours: null },
      search: { minFitScore: 0 },
    }),
  );
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await resetDb();
});

describe('engine pacing', () => {
  it.each([false, true])(
    'retains external evidence across paced scan suspension without consuming the job limit (beta=%s)',
    async (collectExternalJobs) => {
      await saveSettings(
        makeSettings({
          onboardingComplete: true,
          pacing: { activeHours: null },
          search: { collectExternalJobs, maxJobsPerRun: 1, maxPagesPerRun: 3, minFitScore: 0 },
        }),
      );
      await saveEngineState(
        makeEngineState({ runId: 'external-pacing', status: 'scanning', scanComplete: false }),
      );
      const external = makeJob({
        applyType: 'external',
        externalUrl: 'https://careers.example.test/apply',
      });
      const internal = makeJob({}, 2);
      let pages = 0;
      const send = vi.fn(async (request: ContentRequest) => {
        pages += 1;
        return {
          requestId: request.requestId,
          ok: true,
          data: {
            jobs:
              pages === 1
                ? [external]
                : pages === 2
                  ? [{ ...external, applyType: 'unknown', externalUrl: undefined }]
                  : [internal],
            empty: false,
            nextPageUrl:
              pages < 3 ? `https://app.joinhandshake.com/job-search?page=${pages + 1}` : null,
          },
        };
      });
      const ensure = vi.fn(async () => 7);
      const tabs = { ensure, send, id: 7, cancel: vi.fn() } as unknown as RunnerTabManager;
      const first = new Engine({ clock, tabs });
      await first.load();
      await first.tick();
      expect(pages).toBe(1);
      expect(first.getState()).toMatchObject({ scanComplete: false, nextActionAt: START + 7_000 });
      expect(session.get(PACING_SESSION_KEY)).toMatchObject({
        scan: { pages: 1, jobs: [], externalJobs: [external] },
      });
      expect(await getJob(external.id)).toBeUndefined();
      vi.clearAllTimers();
      vi.setSystemTime(START + 7_000);
      const restored = new Engine({ clock, tabs });
      await restored.recoverScheduledRun();
      expect(pages).toBe(2);
      expect(restored.getState()).toMatchObject({
        scanComplete: false,
        nextActionAt: START + 14_000,
      });
      expect(await getQueueItem(internal.id)).toBeUndefined();
      await restored.tick();
      expect(pages).toBe(2);
      vi.clearAllTimers();
      vi.setSystemTime(START + 14_000);
      const completed = new Engine({ clock, tabs });
      await completed.recoverScheduledRun();
      expect(pages).toBe(3);
      expect(send.mock.calls.every(([request]) => request.type === 'content.scan')).toBe(true);
      expect(await getQueueItem(internal.id)).toMatchObject({ status: 'queued' });
      expect(completed.getState()).toMatchObject({ scanComplete: true, todayCount: 0 });
      expect(completed.getState().message).toMatch(/Found 1 jobs/);
      if (collectExternalJobs) {
        expect(await getJob(external.id)).toMatchObject({
          applyType: 'external',
          externalUrl: external.externalUrl,
        });
        expect(await getQueueItem(external.id)).toMatchObject({ status: 'external' });
      } else {
        expect(await getJob(external.id)).toBeUndefined();
        expect(await getQueueItem(external.id)).toBeUndefined();
      }
      expect((await listEvents()).filter((event) => event.type === 'scan.external')).toMatchObject([
        {
          message: collectExternalJobs
            ? 'Collected 1 external links (beta)'
            : "Skipped 1 jobs that apply on the employer's site",
          jobId: undefined,
        },
      ]);
      await completed.stop();
    },
  );

  it('checkpoints each search page and restores the derived wait after suspension', async () => {
    await saveEngineState(
      makeEngineState({ runId: 'pacing', status: 'scanning', scanComplete: false }),
    );
    const job = makeJob({ requiredDocumentTypes: [] });
    let pages = 0;
    const send = vi.fn(async (request: ContentRequest) => {
      pages += 1;
      return {
        requestId: request.requestId,
        ok: true,
        data: {
          jobs: [job],
          empty: false,
          nextPageUrl: pages === 1 ? 'https://app.joinhandshake.com/job-search?page=2' : null,
        },
      };
    });
    const ensure = vi.fn(async () => 7);
    const tabs = { ensure, send, id: 7, cancel: vi.fn() } as unknown as RunnerTabManager;
    const first = new Engine({ clock, tabs });
    await first.load();
    await first.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.getState()).toMatchObject({ scanComplete: false, nextActionAt: START + 7_000 });
    expect(session.get(PACING_SESSION_KEY)).toMatchObject({ scan: { pages: 1, jobs: [job] } });
    expect(fake.alarms.create).toHaveBeenCalledWith('handshook.tick', { when: START + 30_000 });
    await first.tick();
    expect(send).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
    vi.setSystemTime(START + 7_000);
    const restored = new Engine({ clock, tabs });
    await restored.recoverScheduledRun();
    expect(send).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenLastCalledWith(
      'https://app.joinhandshake.com/job-search?page=2',
      true,
      { fresh: true },
    );
    expect(restored.getState()).toMatchObject({ scanComplete: true, nextActionAt: START + 14_000 });
    expect(await getQueueItem(job.id)).toBeDefined();
    expect(session.get(PACING_SESSION_KEY)).toMatchObject({ scan: undefined });
    await restored.pause();
    vi.setSystemTime(START + 90_000);
    await restored.onAlarm('handshook.tick');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('paces the next detail inspection after a filtered job', async () => {
    await saveSettings(
      makeSettings({
        onboardingComplete: true,
        pacing: { activeHours: null },
        search: { excludeKeywords: ['excluded'] },
      }),
    );
    await saveEngineState(makeEngineState({ status: 'running', scanComplete: true }));
    const job = makeJob({ requiredDocumentTypes: [], description: 'excluded' });
    await putJob(job);
    await putQueueItem(makeQueueItem());
    const send = vi.fn(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: job,
    }));
    const tabs = {
      ensure: vi.fn(async () => 7),
      send,
      id: 7,
      cancel: vi.fn(),
    } as unknown as RunnerTabManager;
    const engine = new Engine({ clock, tabs });
    await engine.load();
    await engine.tick();
    expect(await getQueueItem(job.id)).toMatchObject({ status: 'filtered' });
    expect(send.mock.calls.map(([request]) => request.type)).toEqual(['content.inspectJob']);
    expect(engine.getState().nextActionAt).toBe(START + 7_000);
    await engine.stop();
  });

  it('passes derived action timing to content and schedules derived application timing', async () => {
    await saveEngineState(makeEngineState({ status: 'running', scanComplete: true }));
    const job = makeJob({ requiredDocumentTypes: [] });
    await putJob(job);
    await putQueueItem(makeQueueItem());
    const send = vi.fn(async (request: ContentRequest) => ({
      requestId: request.requestId,
      ok: true,
      data: request.type === 'content.inspectJob' ? job : { jobId: job.id, outcome: 'would_apply' },
    }));
    const tabs = {
      ensure: vi.fn(async () => 7),
      send,
      id: 7,
      cancel: vi.fn(),
    } as unknown as RunnerTabManager;
    const engine = new Engine({ clock, tabs });
    await engine.load();
    await engine.tick();
    const request = send.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.type === 'content.apply');
    expect(request).toMatchObject({ options: { humanDelay: { minMs: 300, maxMs: 900 } } });
    expect(engine.getState().nextActionAt).toBe(START + 68_000);
    // A wait longer than the 30 s alarm floor still gets a precise in-memory timer.
    expect(vi.getTimerCount()).toBe(1);
    await engine.stop();
  });
});
