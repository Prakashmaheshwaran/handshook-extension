import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  contentEventSchema,
  contentRequestSchema,
  type ContentEvent,
  type EngineState,
} from '@/core/contracts';
import { receiveContentEvent, registerBackground } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { getDb, getMeta, getTodayCount, resetDb, setMeta } from '@/core/storage/db';
import {
  countAttemptTowardCapOnce,
  createSubmission,
  getSubmissionsForJob,
} from '@/core/storage/submissions';
import { listEvents } from '@/core/logging/eventStore';
import { makeEngineState, makeJob, makeQueueItem } from '@/test/factories';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';

const job = makeJob({
  id: '900001',
  url: 'https://app.joinhandshake.com/jobs/900001',
  host: 'app.joinhandshake.com',
});
const sender = { id: 'test-extension', frameId: 0, url: job.url, tab: { id: 7, url: job.url } };
let fake: FakeBrowser;
let state: EngineState;
let requestId: string;

function resultEvent(): Extract<ContentEvent, { type: 'content.event.result' }> & {
  protocolVersion: number;
} {
  return {
    type: 'content.event.result',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    jobId: job.id,
    result: {
      jobId: job.id,
      outcome: 'applied',
      submittedAt: Date.now(),
      confirmationText: 'Application submitted',
    },
  };
}

beforeEach(async () => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
  await resetDb();
  state = makeEngineState({ status: 'needs_user', runId: 'run-review' });
  vi.spyOn(engine, 'load').mockImplementation(async () => state);
  vi.spyOn(engine, 'getRunnerTabId').mockReturnValue(7);
  vi.spyOn(engine, 'pause').mockImplementation(async (reason) => {
    state.pauseReason = reason;
    return state;
  });
  await putJob(job);
  const attempt = await createSubmission({
    runId: 'run-review',
    jobId: job.id,
    host: job.host,
    startedAt: Date.now(),
    status: 'ambiguous',
    applyType: 'handshake_form',
    documents: [],
    questionIds: [],
  });
  requestId = attempt.id;
  await putQueueItem(
    makeQueueItem({ jobId: job.id, status: 'ready_for_review', submissionAttemptId: requestId }),
  );
  await setMeta(`needs:${job.id}`, { reason: 'review' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('validated content events', () => {
  it.each([
    ['foreign extension', { ...sender, id: 'foreign' }],
    ['foreign tab', { ...sender, tab: { ...sender.tab, id: 88 } }],
    [
      'external page',
      {
        ...sender,
        url: 'https://evil.example/jobs/900001',
        tab: { id: 7, url: 'https://evil.example/jobs/900001' },
      },
    ],
    ['host lookalike', { ...sender, url: 'https://joinhandshake.com.evil.example/jobs/900001' }],
    ['subframe', { ...sender, frameId: 1 }],
    ['wrong job page', { ...sender, url: 'https://app.joinhandshake.com/jobs/9000011' }],
    ['missing tab', { id: 'test-extension' }],
  ])('rejects a result from a %s', async (_name, source) => {
    await receiveContentEvent(resultEvent(), source);
    expect(await getTodayCount()).toBe(0);
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
    expect((await listEvents(10))[0]?.type).toBe('messaging.rejected');
  });

  it('rejects invalid results, wrong jobs, old attempts and old runs', async () => {
    const event = resultEvent();
    for (const invalid of [
      { ...event, result: { ...event.result, outcome: 'invented' } },
      { ...event, result: { ...event.result, jobId: '900002' } },
      { ...event, result: { ...event.result, confirmationText: '' } },
      { ...event, result: { ...event.result, confirmationText: 'Click recorded' } },
      { ...event, requestId: 'an-old-attempt' },
    ])
      await receiveContentEvent(invalid, sender);
    state.runId = 'a-different-run';
    await receiveContentEvent(event, sender);
    expect(await getTodayCount()).toBe(0);
    expect((await getSubmissionsForJob(job.id))[0]?.status).toBe('ambiguous');
  });

  it('pauses stale runner scripts and shows a clear reload message', async () => {
    await receiveContentEvent({ ...resultEvent(), protocolVersion: 99 }, sender);
    expect(engine.pause).toHaveBeenCalledWith('protocol_mismatch');
    expect(fake.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toast',
        message: expect.stringMatching(/Reload the Handshake tab/),
      }),
    );
    expect(await getTodayCount()).toBe(0);
  });

  it('never logs rejected payloads or sender URLs', async () => {
    const secret = 'session=private-sentinel';
    await receiveContentEvent(
      { ...resultEvent(), result: secret },
      { ...sender, url: `${job.url}?${secret}` },
    );
    expect(JSON.stringify(await listEvents(100))).not.toContain('private-sentinel');
  });

  it('rejects an absent runtime identity rather than trusting all senders', async () => {
    vi.stubGlobal('browser', { ...fake, runtime: { ...fake.runtime, id: undefined } });
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(0);
  });

  it('accepts only the active request for progress updates', async () => {
    state.currentJobId = job.id;
    state.status = 'running';
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'filling', submissionAttemptId: requestId }),
    );
    const event = {
      type: 'content.event.progress',
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      jobId: job.id,
      phase: 'filling',
      message: 'Filling application',
    };
    await receiveContentEvent({ ...event, requestId: 'stale' }, sender);
    expect(state.currentPhase).toBeUndefined();
    await receiveContentEvent(event, sender);
    expect(state.currentPhase).toBe('filling');
  });

  it('routes registered runtime events through validation before handling them', async () => {
    registerBackground();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      source: unknown,
      respond: (value: unknown) => void,
    ) => boolean;
    await new Promise<void>((resolve) => {
      expect(listener(resultEvent(), sender, () => resolve())).toBe(true);
    });
    expect(await getTodayCount()).toBe(1);
  });

  it('registers submit authorization behind exact active-attempt sender validation', async () => {
    state.status = 'running';
    state.currentJobId = job.id;
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'filling', submissionAttemptId: requestId }),
    );
    const authorize = vi.spyOn(engine, 'authorizeSubmit').mockResolvedValue(true);
    registerBackground();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      source: unknown,
      respond: (value: unknown) => void,
    ) => boolean;
    const request = {
      type: 'engine.authorizeSubmit',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'grant-request',
      jobId: job.id,
      applyRequestId: requestId,
    };
    const response = await new Promise((resolve) => listener(request, sender, resolve));
    expect(response).toMatchObject({
      requestId: request.requestId,
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      data: { authorized: true },
    });
    expect(authorize).toHaveBeenCalledWith(job.id, requestId, sender.tab.id);
    authorize.mockClear();
    const stale = await new Promise((resolve) =>
      listener({ ...request, applyRequestId: 'stale' }, sender, resolve),
    );
    expect(stale).toMatchObject({ ok: true, data: { authorized: false } });
    expect(authorize).not.toHaveBeenCalled();
    const wrongTab = await new Promise((resolve) =>
      listener(request, { ...sender, tab: { ...sender.tab, id: 88 } }, resolve),
    );
    expect(wrongTab).toMatchObject({ ok: true, data: { authorized: false } });
    expect(authorize).not.toHaveBeenCalled();
    const oldProtocol = vi.fn();
    expect(listener({ ...request, protocolVersion: 99 }, sender, oldProtocol)).toBe(false);
    expect(oldProtocol).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('waits for restored runner ownership before authorizing a post-wake event', async () => {
    let restored = false;
    vi.mocked(engine.getRunnerTabId).mockImplementation(() => (restored ? 7 : null));
    vi.mocked(engine.load).mockImplementation(async () => {
      restored = true;
      return state;
    });
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(1);
  });

  it('fails closed when runner restoration fails', async () => {
    vi.mocked(engine.load).mockRejectedValue(new Error('storage unavailable'));
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(0);
  });

  it('fails closed after a bounded wait when restoration stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(engine.load).mockImplementation(() => new Promise(() => {}));
      const pending = receiveContentEvent(resultEvent(), sender);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(await getTodayCount()).toBe(0);
  });
});

describe('durable Review completion', () => {
  it('records and broadcasts exactly one Activity applied event under concurrent/replayed results', async () => {
    const event = resultEvent();
    await Promise.all([receiveContentEvent(event, sender), receiveContentEvent(event, sender)]);
    await receiveContentEvent(event, sender);
    const applied = (await listEvents(100)).filter((entry) => entry.type === 'job.applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      jobId: job.id,
      message: `Applied: ${job.title} at ${job.employer}`,
    });
    const broadcasts = fake.runtime.sendMessage.mock.calls.map(
      ([message]) => message as { type?: string; event?: { type?: string } },
    );
    expect(
      broadcasts.filter(
        (message) => message.type === 'event.appended' && message.event?.type === 'job.applied',
      ),
    ).toHaveLength(1);
    // Even after Activity is cleared, replay cannot create a second event.
    await (await getDb()).clear('events');
    await receiveContentEvent(event, sender);
    expect(await listEvents(100)).toEqual([]);
    expect(await getTodayCount()).toBe(1);
  });

  it('defers an early Review result until the engine handoff is durable', async () => {
    vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(true);
    expect(await receiveContentEvent(resultEvent(), sender)).toBe(false);
    expect(await getTodayCount()).toBe(0);
    vi.mocked(engine.isRunnerBusy).mockReturnValue(false);
    expect(await receiveContentEvent(resultEvent(), sender)).toBe(true);
    expect(await getTodayCount()).toBe(1);
  });

  it.each(['needs_input', 'verifying'] as const)(
    'accepts correlated manual confirmation from %s',
    async (status) => {
      await putQueueItem(makeQueueItem({ jobId: job.id, status, submissionAttemptId: requestId }));
      expect(await receiveContentEvent(resultEvent(), sender)).toBe(true);
      expect((await getQueueItem(job.id))?.status).toBe('applied');
      expect(await getTodayCount()).toBe(1);
    },
  );
  it('settles queue, journal and daily count only once for concurrent and later duplicates', async () => {
    const event = resultEvent();
    await Promise.all([receiveContentEvent(event, sender), receiveContentEvent(event, sender)]);
    const settled = (await getSubmissionsForJob(job.id))[0];
    expect(settled).toMatchObject({
      id: requestId,
      status: 'applied',
      capCountedAt: expect.any(Number),
      reconciledAt: expect.any(Number),
    });
    expect(await getTodayCount()).toBe(1);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
    expect(await getMeta(`needs:${job.id}`)).toBeNull();
    fake.runtime.sendMessage.mockClear();
    await receiveContentEvent(event, sender);
    expect((await getSubmissionsForJob(job.id))[0]).toEqual(settled);
    expect(await getTodayCount()).toBe(1);
    expect(fake.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('shares cap deduplication with an engine completion', async () => {
    await countAttemptTowardCapOnce(requestId);
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(1);
    expect((await getSubmissionsForJob(job.id))[0]?.status).toBe('applied');
  });

  it('repairs a crash between journal settlement and cap accounting without settling twice', async () => {
    const db = await getDb();
    const attempt = (await getSubmissionsForJob(job.id))[0];
    if (!attempt) throw new Error('Missing fixture attempt');
    await db.put('submissions', { ...attempt, status: 'applied', finishedAt: 42 });
    await putQueueItem(
      makeQueueItem({ jobId: job.id, status: 'applied', submissionAttemptId: requestId }),
    );
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(1);
    expect((await getSubmissionsForJob(job.id))[0]?.finishedAt).toBe(42);
    await receiveContentEvent(resultEvent(), sender);
    expect(await getTodayCount()).toBe(1);
  });

  it('keeps deduplication after module reload using the persisted journal', async () => {
    const event = resultEvent();
    await receiveContentEvent(event, sender);
    const before = (await getSubmissionsForJob(job.id))[0];
    (await getDb()).close();
    vi.resetModules();
    const { settleReviewResult } = await import('@/background/review-results');
    const reloadedDb = await import('@/core/storage/db');
    expect(await settleReviewResult(event, state.runId)).toEqual({ ok: true, value: false });
    expect(await reloadedDb.getTodayCount()).toBe(1);
    expect(await (await reloadedDb.getDb()).get('submissions', requestId)).toEqual(before);
    (await reloadedDb.getDb()).close();
  });
});

describe('message schemas', () => {
  it('rejects malformed or unversioned commands and the unused focusJob contract', () => {
    for (const request of [
      { type: 'content.ping', requestId: 'r' },
      {
        type: 'content.focusJob',
        requestId: 'r',
        protocolVersion: PROTOCOL_VERSION,
        jobId: job.id,
      },
      { type: 'content.apply', requestId: 'r', protocolVersion: PROTOCOL_VERSION, job },
      {
        type: 'content.scan',
        requestId: 'r',
        protocolVersion: PROTOCOL_VERSION,
        options: { searchUrl: 'not a URL', maxJobs: 1, maxPages: 1, pageDelayMs: 0 },
      },
    ])
      expect(contentRequestSchema.safeParse(request).success).toBe(false);
  });

  it('parses every supported event and rejects unversioned events', () => {
    const events = [
      resultEvent(),
      {
        type: 'content.event.progress',
        jobId: job.id,
        requestId,
        phase: 'filling',
        message: 'Filling',
      },
      { type: 'content.event.discovered', jobs: [job] },
      { type: 'content.event.session', status: 'logged_in', host: job.host },
      {
        type: 'content.event.selectorHealth',
        health: { at: 1, page: 'job', selector: 'apply', strategy: 'button', ok: true },
      },
      {
        type: 'content.event.log',
        event: { id: 'event-1', at: 1, level: 'info', type: 'test', message: 'Test' },
      },
    ];
    for (const event of events) {
      expect(
        contentEventSchema.safeParse({ ...event, protocolVersion: PROTOCOL_VERSION }).success,
      ).toBe(true);
      expect(contentEventSchema.safeParse({ ...event, protocolVersion: undefined }).success).toBe(
        false,
      );
    }
  });
});
