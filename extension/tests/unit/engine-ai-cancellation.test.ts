import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, type ContentRequest } from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putQueueItem, updateQueueItem } from '@/core/orchestrator/queue';
import { resetDb } from '@/core/storage/db';
import { putJob } from '@/core/storage/jobs';
import { saveAiKey, saveSettings } from '@/core/storage/settings';
import { getSubmissionsForJob } from '@/core/storage/submissions';
import { makeJob, makeQueueItem } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';
import { ROUTING } from './helpers/openrouter';

let epoch = 0;
beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser({ openRouterPermission: true }).fake);
  await resetDb();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('engine cancellation during AI matching', () => {
  it.each(['stop', 'pause', 'resetForDataClear', 'skip'] as const)(
    '%s aborts a hung OpenRouter request and never proceeds to apply',
    async (action) => {
      await saveSettings(
        mergeSettings(DEFAULT_SETTINGS, {
          onboardingComplete: true,
          mode: 'review',
          pacing: { activeHours: null },
          ai: { enabled: true, provider: 'openrouter', openRouter: ROUTING },
          search: { minFitScore: 0 },
          documents: {
            defaultResumeId: 'r1',
            defaultResumeName: 'Software resume',
            additionalResumes: [{ id: 'r2', name: 'Data resume' }],
          },
        }),
      );
      await saveAiKey('fixture-key');
      const job = makeJob({ id: '900001', requiredDocumentTypes: [], fitScore: 0.9 });
      await putJob(job);
      await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
      const send = vi.fn(async (request: ContentRequest) => ({
        requestId: request.requestId,
        ok: true,
        data: job,
      }));
      const tabs = { ensure: vi.fn(async () => 1), send, cancel: vi.fn(async () => {}), id: 1 };
      const engine = new Engine({ tabs: tabs as unknown as RunnerTabManager });
      await engine.load();
      engine.getState().status = 'running';
      engine.getState().scanComplete = true;
      let signal: AbortSignal | null | undefined;
      let started: (() => void) | undefined;
      const starting = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          signal = init?.signal;
          started?.();
          return new Promise<Response>(() => {});
        }),
      );
      // IndexedDB keeps its real task queue; only the AI/Stop timers are faked.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(2_100_000_000_000 + ++epoch * 1_000_000);
      const running = engine.tick();
      await starting;
      if (action === 'skip') {
        await updateQueueItem(job.id, { status: 'skipped' });
        await engine.cancelActiveJob(job.id);
      } else await engine[action]();
      await running;
      expect(signal?.aborted).toBe(true);
      expect(send.mock.calls.some(([request]) => request.type === 'content.apply')).toBe(false);
      expect(await getSubmissionsForJob(job.id)).toEqual([]);
      if (action === 'skip') {
        expect(engine.getState().status).toBe('running');
        expect(engine.getState().nextActionAt).toBeGreaterThan(Date.now());
        expect((await getQueueItem(job.id))?.status).toBe('skipped');
        await engine.pause();
      } else expect(engine.getState().status).toBe(action === 'pause' ? 'paused' : 'idle');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
