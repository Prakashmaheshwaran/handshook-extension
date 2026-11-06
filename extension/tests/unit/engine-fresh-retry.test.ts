import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentRequest } from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { resetDb } from '@/core/storage/db';
import { createSubmission, getSubmissionsForJob } from '@/core/storage/submissions';
import { saveEngineState, saveSettings } from '@/core/storage/settings';
import { makeEngineState, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  localStorage.clear();
  await resetDb();
  await saveSettings(
    makeSettings({
      onboardingComplete: true,
      mode: 'review',
      search: { minFitScore: 0 },
      documents: { defaultResumeId: 'document-0001' },
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDb();
});

function runner() {
  const job = makeJob();
  const ensure = vi.fn(async () => 7);
  const send = vi.fn(async (request: ContentRequest) => ({
    requestId: request.requestId,
    ok: true,
    data:
      request.type === 'content.inspectJob'
        ? job
        : { jobId: job.id, outcome: 'manual_submit_required' },
  }));
  const tabs = { id: 7, ensure, send, cancel: async () => {} } as unknown as RunnerTabManager;
  return { job, ensure, send, tabs };
}

describe('fresh retry navigation', () => {
  it.each(['documents', 'answers', 'login', 'ui_changed'] as const)(
    'opens a fresh application for a settled %s retry with a new attempt ID',
    async (reason) => {
      const { job, ensure, send, tabs } = runner();
      await putJob(job);
      await putQueueItem(makeQueueItem({ attempts: 1 }));
      await saveEngineState(
        makeEngineState({
          status: reason === 'documents' || reason === 'answers' ? 'needs_user' : 'paused',
          pauseReason: reason === 'login' ? 'auth_required' : 'ui_changed',
          scanComplete: true,
        }),
      );
      const previous = await createSubmission({
        jobId: job.id,
        host: job.host,
        runId: 'previous-run',
        startedAt: 1,
        finishedAt: 2,
        status: 'failed',
        applyType: job.applyType,
        documents: [],
        questionIds: [],
      });
      const engine = new Engine({ tabs });
      await engine.resume();
      await expect.poll(async () => (await getQueueItem(job.id))?.status).toBe('ready_for_review');
      expect(ensure).toHaveBeenNthCalledWith(1, job.url, true, { fresh: true });
      // No reload between inspection and dispatch: the second ensure preserves
      // the fresh document and its content-side attempt identity.
      expect(ensure).toHaveBeenNthCalledWith(2, job.url);
      const attempts = await getSubmissionsForJob(job.id);
      expect(attempts).toHaveLength(2);
      expect(attempts.find((attempt) => attempt.id === previous.id)?.status).toBe('failed');
      const applies = send.mock.calls
        .map(([request]) => request)
        .filter((r) => r.type === 'content.apply');
      expect(applies).toHaveLength(1);
      expect(applies[0]?.requestId).not.toBe(previous.id);
      expect(attempts.some((attempt) => attempt.id === applies[0]?.requestId)).toBe(true);
      await engine.stop();
    },
  );

  it.each(['started', 'submitted', 'ambiguous', 'applied'] as const)(
    'never reloads or dispatches a requeued job with a %s attempt',
    async (status) => {
      const { job, ensure, send, tabs } = runner();
      await putJob(job);
      await putQueueItem(makeQueueItem());
      await saveEngineState(makeEngineState({ status: 'running', scanComplete: true }));
      await createSubmission({
        jobId: job.id,
        host: job.host,
        runId: 'previous-run',
        startedAt: 1,
        status,
        applyType: job.applyType,
        documents: [],
        questionIds: [],
      });
      const engine = new Engine({ tabs });
      await engine.load();
      await engine.tick();
      expect(ensure).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(await getSubmissionsForJob(job.id)).toHaveLength(1);
      await engine.stop();
    },
  );

  it('preserves an open Review form when another queued job exists', async () => {
    const { job, ensure, send, tabs } = runner();
    await putJob(job);
    await putQueueItem(makeQueueItem());
    await putQueueItem(makeQueueItem({ jobId: '900002', status: 'ready_for_review' }));
    await saveEngineState(makeEngineState({ status: 'running', scanComplete: true }));
    const engine = new Engine({ tabs });
    await engine.load();
    await engine.tick();
    expect(engine.getState().status).toBe('needs_user');
    expect(ensure).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await engine.stop();
  });
});
