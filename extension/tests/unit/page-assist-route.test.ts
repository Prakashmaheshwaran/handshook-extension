import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEngineState, makeQueueItem } from '@/test/factories';
import { DB_STORES, type MessageResponse } from '@/core/contracts';
import {
  PAGE_ASSIST_ATTRIBUTES,
  type PageAssistCandidate,
  type PageAssistRequest,
} from '@/core/contracts/pageAssist';
import { engine } from '@/core/orchestrator/engine';
import { putQueueItem } from '@/core/orchestrator/queue';
import { getDb, resetDb } from '@/core/storage/db';
import { createFakeBrowser } from './helpers/fakeBrowser';

const mocks = vi.hoisted(() => ({
  runPageAssist: vi.fn(async () => ({ index: 0, source: 'ai' as const, confidence: 0.9 })),
}));

vi.mock('@/background/page-assist', () => ({ runPageAssist: mocks.runPageAssist }));

import { pageAssistRpc } from '@/background/router';

const JOB_ID = '900001';
const RUN_ID = 'run-1';
const HOST = 'app.joinhandshake.com';

function candidate(index: number): PageAssistCandidate {
  return {
    index,
    tag: 'button',
    role: 'button',
    name: 'Apply',
    attributes: Object.fromEntries(
      PAGE_ASSIST_ATTRIBUTES.map((name) => [name, '']),
    ) as PageAssistCandidate['attributes'],
    inDialog: false,
    disabled: false,
  };
}

function request(applyRequestId: string): PageAssistRequest {
  return {
    type: 'engine.pageAssist',
    requestId: 'assist-1',
    jobId: JOB_ID,
    applyRequestId,
    target: 'applyButton',
    scope: 'job',
    candidates: [candidate(0)],
  };
}

function sender(tabId: number): unknown {
  const url = `https://${HOST}/jobs/${JOB_ID}`;
  return {
    id: 'test-extension',
    frameId: 0,
    url,
    tab: { id: tabId, url },
  };
}

async function dataOf(response: MessageResponse<unknown>): Promise<unknown> {
  expect(response.ok).toBe(true);
  return response.ok ? response.data : undefined;
}

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser({ openRouterPermission: true }).fake);
  await resetDb();
  mocks.runPageAssist.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('engine.pageAssist sender and attempt binding', () => {
  it('refuses a sender that is not the runner tab without calling page assist', async () => {
    const response = await pageAssistRpc(request('attempt-1'), sender(99));

    expect(await dataOf(response)).toEqual({ index: null, source: 'none' });
    expect(mocks.runPageAssist).not.toHaveBeenCalled();
  });

  it('refuses a stale applyRequestId without calling page assist', async () => {
    vi.spyOn(engine, 'load').mockResolvedValue(
      makeEngineState({
        status: 'running',
        runId: RUN_ID,
        currentJobId: JOB_ID,
      }),
    );
    vi.spyOn(engine, 'getRunnerTabId').mockReturnValue(7);
    await putQueueItem(
      makeQueueItem({
        jobId: JOB_ID,
        status: 'filling',
        submissionAttemptId: 'current-attempt',
        runId: RUN_ID,
      }),
    );

    const response = await pageAssistRpc(request('stale-attempt'), sender(7));

    expect(await dataOf(response)).toEqual({ index: null, source: 'none' });
    expect(mocks.runPageAssist).not.toHaveBeenCalled();
  });

  it('serves the active attempt from the runner tab', async () => {
    vi.spyOn(engine, 'load').mockResolvedValue(
      makeEngineState({
        status: 'running',
        runId: RUN_ID,
        currentJobId: JOB_ID,
      }),
    );
    vi.spyOn(engine, 'getRunnerTabId').mockReturnValue(7);
    await putQueueItem(
      makeQueueItem({
        jobId: JOB_ID,
        status: 'filling',
        submissionAttemptId: 'current-attempt',
        runId: RUN_ID,
      }),
    );
    const db = await getDb();
    await db.put(DB_STORES.submissions, {
      id: 'current-attempt',
      runId: RUN_ID,
      jobId: JOB_ID,
      host: HOST,
      startedAt: 1,
      status: 'started',
      applyType: 'quick_apply',
      documents: 'handshake_profile_defaults',
      questionIds: [],
    });

    const response = await pageAssistRpc(request('current-attempt'), sender(7));

    expect(await dataOf(response)).toEqual({ index: 0, source: 'ai', confidence: 0.9 });
    expect(mocks.runPageAssist).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'engine.pageAssist', jobId: JOB_ID }),
      HOST,
      expect.any(Object),
    );
  });
});
