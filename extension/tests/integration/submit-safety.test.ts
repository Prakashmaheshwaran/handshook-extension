import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  mergeSettings,
  type ApplyResult,
  type ContentRequest,
  type MessageResponse,
  type QueueItem,
} from '@/core/contracts';
import { Engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { resetDb } from '@/core/storage/db';
import { saveSettings } from '@/core/storage/settings';
import { makeDocument, makeJob, makeQueueItem } from '@/test/factories';
import { applyToJob } from '@/handshake/applyFlow';
import { createFakeBrowser } from '../unit/helpers/fakeBrowser';

const bridge = vi.hoisted(() => ({
  handler: undefined as
    ((request: ContentRequest) => Promise<MessageResponse<unknown>>) | undefined,
}));
vi.mock('@/content/bridge', () => ({
  registerContentCommand: vi.fn(),
  registerContentBridge: (handler: typeof bridge.handler) => {
    bridge.handler = handler;
  },
  responseOk: (requestId: string, data: unknown) => ({ requestId, ok: true, data }),
  sendContentEvent: vi.fn(async () => undefined),
}));
vi.mock('@/content/lifecycle', () => ({ watchRoute: vi.fn() }));
import { registerContentRouter } from '@/content/router';

const JOB = makeJob(
  { id: '900001', requiredDocumentTypes: ['resume'], applyType: 'handshake_form', fitScore: 0.9 },
  1,
);
const SETTINGS = mergeSettings(DEFAULT_SETTINGS, {
  onboardingComplete: true,
  mode: 'autopilot',
  safety: { reviewBeforeSubmit: false },
  documents: { defaultResumeId: 'doc-resume', autoSelectResume: false },
  search: { minFitScore: 0 },
  pacing: { activeHours: null },
});
const options = {
  mode: 'autopilot' as const,
  documents: { resumeId: 'doc-resume' },
  documentsAvailable: [makeDocument({ id: 'doc-resume', type: 'resume' })],
  answers: [],
  allowSensitiveAutoSubmit: false,
  allowEeoAutoFill: false,
  allowFreeTextAutoFill: false,
  reviewBeforeSubmit: false,
  stopOnUnknownQuestion: true,
  verifySubmissions: false,
  timeoutMs: 1_000,
};

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  vi.stubGlobal('location', new URL(JOB.url));
  await resetDb();
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-form.html'),
    'utf8',
  );
  document.querySelector('button')?.addEventListener('click', () => {
    const dialog = document.getElementById('apply-dialog');
    if (dialog) dialog.hidden = false;
  });
  registerContentRouter();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('live submit revocation across engine, content router and form', () => {
  for (const change of ['review', 'reviewBeforeSubmit', 'pause', 'stop'] as const) {
    it(`${change} during document filling leaves the selected form for review without submitting`, async () => {
      vi.stubGlobal('browser', createFakeBrowser().fake);
      await saveSettings(SETTINGS);
      await putJob(JOB);
      const item = makeQueueItem({ jobId: JOB.id, status: 'queued' });
      await putQueueItem(item);
      const submit = vi.fn();
      document
        .querySelector('[data-testid="submit-application"]')
        ?.addEventListener('click', submit);
      let revoking = Promise.resolve();
      const tabs = {
        id: 7,
        ensure: vi.fn(async () => 7),
        cancel: vi.fn(async (jobId: string) => {
          await bridge.handler?.({ type: 'content.cancel', requestId: 'cancel', jobId });
        }),
        send: vi.fn(async (request: ContentRequest): Promise<MessageResponse<unknown>> =>
          request.type === 'content.inspectJob'
            ? { requestId: request.requestId, ok: true, data: JOB }
            : bridge.handler
              ? bridge.handler(request)
              : {
                  requestId: request.requestId,
                  ok: false,
                  error: { code: 'UNKNOWN', message: 'No handler', retryable: false },
                },
        ),
      };
      const fake = (
        globalThis as unknown as { browser: ReturnType<typeof createFakeBrowser>['fake'] }
      ).browser;
      const engine = new Engine({ tabs: tabs as unknown as RunnerTabManager });
      fake.runtime.sendMessage.mockImplementation(async (message: unknown) => {
        await revoking;
        const request = message as { requestId: string; jobId: string; applyRequestId: string };
        return {
          requestId: request.requestId,
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          data: {
            authorized: await engine.authorizeSubmit(request.jobId, request.applyRequestId, 7),
          },
        };
      });
      vi.stubGlobal('browser', fake);
      await engine.load();
      engine.getState().status = 'running';
      document.querySelector('#resume-select')?.addEventListener(
        'change',
        () => {
          revoking =
            change === 'pause' || change === 'stop'
              ? engine[change]().then(() => undefined)
              : saveSettings(
                  mergeSettings(
                    SETTINGS,
                    change === 'review'
                      ? { mode: 'review' }
                      : { safety: { reviewBeforeSubmit: true } },
                  ),
                )
                  .then(() => engine.load())
                  .then(() => undefined);
        },
        { once: true },
      );
      await (engine as unknown as { apply(item: QueueItem): Promise<void> }).apply(item);
      await revoking;
      expect(submit).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLSelectElement>('#resume-select')?.value).toBe('doc-resume');
      expect(
        document
          .querySelector<HTMLElement>('[role="dialog"]')
          ?.closest<HTMLElement>('#apply-dialog')?.hidden,
      ).toBe(false);
      expect(await getQueueItem(JOB.id)).toMatchObject({ status: 'ready_for_review' });
      if (change === 'pause') expect(engine.getState().status).toBe('paused');
      if (change === 'stop') expect(engine.getState().status).toBe('idle');
    });
  }
});

describe('submitting clicks require a live grant', () => {
  it('leaves a filled standard form for review when no authorization control is provided', async () => {
    const submit = vi.fn();
    document.querySelector('[data-testid="submit-application"]')?.addEventListener('click', submit);
    const result = await applyToJob(document, JOB, options);
    expect(result.outcome).toBe('ready_for_review');
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('#resume-select')?.value).toBe('doc-resume');
  });

  it.each(['denied', 'error', 'revoked-in-transit'] as const)(
    'never clicks one-click Quick Apply when %s',
    async (failure) => {
      document.body.innerHTML =
        '<main data-hook="job-details-page"><button>Quick Apply</button></main>';
      const click = vi.fn();
      document.querySelector('button')?.addEventListener('click', click);
      let revoked = false;
      const result: ApplyResult = await applyToJob(
        document,
        { ...JOB, applyType: 'quick_apply', requiredDocumentTypes: [] },
        options,
        undefined,
        {
          needsReview: () => revoked,
          authorizeSubmit: async () => {
            if (failure === 'error') throw new Error('No background');
            revoked = failure === 'revoked-in-transit';
            return failure !== 'denied';
          },
        },
      );
      expect(result.outcome).toBe('manual_submit_required');
      expect(click).not.toHaveBeenCalled();
    },
  );
});
