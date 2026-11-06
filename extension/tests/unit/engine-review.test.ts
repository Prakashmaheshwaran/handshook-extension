import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type ApplyOptions,
  type ApplyResult,
  type ContentRequest,
  type Job,
  type QueueItem,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { Engine, resolveReviewBeforeSubmit } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putQueueItem } from '@/core/orchestrator/queue';
import { getMeta, resetDb } from '@/core/storage/db';
import { putJob } from '@/core/storage/jobs';
import { saveSettings } from '@/core/storage/settings';
import { getSubmissionsForJob } from '@/core/storage/submissions';
import { makeJob, makeQueueItem } from '@/test/factories';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';
import * as matcher from '@/ai/matcher';

let fake: FakeBrowser;

const ITEM: QueueItem = makeQueueItem({ jobId: '900001', status: 'queued' }, 1);

const BASE_PATCH: SettingsPatch = {
  onboardingComplete: true,
  mode: 'autopilot',
  pacing: { activeHours: null },
  documents: { autoSelectResume: false },
};

function baseSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, { ...BASE_PATCH, ...patch });
}

function tabManager(job: Job, result: ApplyResult) {
  const send = vi.fn(async (request: ContentRequest) => {
    if (request.type === 'content.inspectJob') {
      return { requestId: request.requestId, ok: true as const, data: job };
    }
    if (request.type === 'content.apply') {
      return { requestId: request.requestId, ok: true as const, data: result };
    }
    return { requestId: request.requestId, ok: true as const, data: null };
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

async function runApply(
  settings: Settings,
  job: Job,
  result: ApplyResult,
  itemPatch: Partial<QueueItem> = {},
): Promise<{
  engine: Engine;
  options: ApplyOptions | undefined;
  broadcasts: unknown[];
}> {
  await saveSettings(settings);
  await putJob(job);
  await putQueueItem({ ...ITEM, ...itemPatch });
  const { tabs, send } = tabManager(job, result);
  const broadcasts: unknown[] = [];
  const engine = new Engine({
    tabs,
    broadcast: (message) => broadcasts.push(message),
    clock: { now: () => 1_700_000_000_000, sleep: async () => {}, random: () => 0.5 },
  });
  await engine.load();
  // `apply` only runs while a run generation is active. Direct tests simulate
  // the engine already running; the token is the initial generation.
  engine.getState().status = 'running';
  await (engine as unknown as { apply(item: QueueItem): Promise<void> }).apply(ITEM);
  const applyCall = send.mock.calls.find(([request]) => request.type === 'content.apply');
  const options = applyCall?.[0] as ContentRequest | undefined;
  return {
    engine,
    options: options?.type === 'content.apply' ? options.options : undefined,
    broadcasts,
  };
}

beforeEach(async () => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveReviewBeforeSubmit — P0-4', () => {
  it('always stops in review and dry-run modes', () => {
    expect(resolveReviewBeforeSubmit('review', false)).toBe(true);
    expect(resolveReviewBeforeSubmit('dry_run', false)).toBe(true);
  });

  it('honors the safety toggle in autopilot', () => {
    expect(resolveReviewBeforeSubmit('autopilot', true)).toBe(true);
    expect(resolveReviewBeforeSubmit('autopilot', false)).toBe(false);
  });
});

describe('Engine.apply — review flag and new outcomes', () => {
  const job = makeJob({ id: '900001', fitScore: 0.9, requiredDocumentTypes: [] }, 1);
  const ready: ApplyResult = { jobId: '900001', outcome: 'ready_for_review' };

  it.each([false, true])(
    'passes the explicit one-click opt-in through the engine: %s',
    async (allowOneClickApply) => {
      const { options } = await runApply(
        baseSettings({
          safety: { reviewBeforeSubmit: false, allowOneClickApply },
          documents: { defaultResumeId: 'only-resume', autoSelectResume: false },
        }),
        job,
        ready,
      );
      expect(options?.allowOneClickApply).toBe(allowOneClickApply);
      expect(options?.reviewBeforeSubmit).toBe(false);
    },
  );

  it('persists Handshake-profile default provenance without inventing document IDs', async () => {
    await runApply(
      baseSettings({
        safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
        documents: { defaultResumeId: 'only-resume', autoSelectResume: false },
      }),
      job,
      {
        jobId: job.id,
        outcome: 'applied',
        confirmationText: 'Applied on October 27, 2026',
        documentsUsed: 'handshake_profile_defaults',
      },
    );
    expect((await getSubmissionsForJob(job.id))[0]).toMatchObject({
      status: 'applied',
      documents: 'handshake_profile_defaults',
    });
  });

  it('passes reviewBeforeSubmit=false for a safe autopilot run', async () => {
    const { options } = await runApply(
      baseSettings({
        safety: { reviewBeforeSubmit: false },
        documents: { defaultResumeId: 'only-resume', autoSelectResume: false },
      }),
      job,
      ready,
    );
    expect(options?.reviewBeforeSubmit).toBe(false);
    // These previously-dead settings now cross the apply boundary.
    expect(options?.stopOnUnknownQuestion).toBe(true);
    expect(options?.verifySubmissions).toBe(true);
  });

  it('treats an entered resume ID as configured instead of inventing a document list', async () => {
    const { options } = await runApply(
      baseSettings({
        safety: { reviewBeforeSubmit: false },
        documents: { defaultResumeId: 'missing-resume', autoSelectResume: true },
      }),
      job,
      ready,
    );
    expect(options?.documents.resumeId).toBe('missing-resume');
    expect(options?.documentsAvailable).toEqual([
      { id: 'missing-resume', type: 'resume', title: '', isDefault: true },
    ]);
    expect(options?.reviewBeforeSubmit).toBe(false);
  });

  it('persists only verified documents with optional-picker warnings in the submission record', async () => {
    const documentsUsed = [{ type: 'resume' as const, id: 'verified-resume' }];
    const warning = "Your cover letter (Cover Letter) is not offered in this application's picker";
    const { engine } = await runApply(baseSettings(), job, {
      jobId: job.id,
      outcome: 'needs_input',
      documentsUsed,
      missingDocumentTypes: ['cover_letter'],
      error: {
        code: 'MISSING_DOCUMENT',
        message: warning,
        retryable: false,
        details: { documentWarnings: [warning] },
      },
    });
    // Autopilot parks the job in Needs You and keeps the run going.
    expect(engine.getState().status).toBe('running');
    expect((await getSubmissionsForJob(job.id))[0]).toMatchObject({
      documents: documentsUsed,
      error: { message: warning, details: { documentWarnings: [warning] } },
    });
    expect((await getQueueItem(job.id))?.lastError?.message).toBe(warning);
  });

  it('persists the verified Quick Apply document IDs in an applied submission', async () => {
    const documentsUsed = [{ type: 'resume' as const, id: 'only-resume' }];
    await runApply(
      baseSettings({ documents: { defaultResumeId: 'only-resume', autoSelectResume: false } }),
      job,
      {
        jobId: job.id,
        outcome: 'applied',
        confirmationText: 'Application submitted',
        documentsUsed,
      },
    );
    expect((await getSubmissionsForJob(job.id))[0]).toMatchObject({
      status: 'applied',
      documents: documentsUsed,
    });
  });

  it('passes reviewBeforeSubmit=true when the user enabled the safety toggle', async () => {
    const { options } = await runApply(
      baseSettings({ safety: { reviewBeforeSubmit: true } }),
      job,
      ready,
    );
    expect(options?.reviewBeforeSubmit).toBe(true);
  });

  it('filters a job when its inspected fit is below the minimum', async () => {
    const lowFit = makeJob({ id: '900001', fitScore: 0.2, requiredDocumentTypes: [] }, 1);
    const { options } = await runApply(
      baseSettings({ safety: { reviewBeforeSubmit: false }, search: { minFitScore: 0.99 } }),
      lowFit,
      ready,
    );
    expect(options).toBeUndefined();
    expect((await getQueueItem(lowFit.id))?.status).toBe('filtered');
  });

  it('routes manual_submit_required to review with its copy', async () => {
    const { engine, broadcasts } = await runApply(
      baseSettings({ safety: { reviewBeforeSubmit: true } }),
      job,
      {
        jobId: '900001',
        outcome: 'manual_submit_required',
        confirmationText: 'Click Quick Apply yourself in the Handshook tab',
      },
    );

    const item = await getQueueItem('900001');
    expect(item?.status).toBe('ready_for_review');
    expect(engine.getState().status).toBe('needs_user');
    expect(engine.getState().message).toMatch(/click quick apply yourself/i);
    const need = await getMeta<{ reason: string; message?: string }>('needs:900001');
    expect(need).toMatchObject({
      reason: 'review',
      message: 'Click Quick Apply yourself in the Handshook tab',
    });
    expect(broadcasts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'needs.you', jobId: '900001' })]),
    );
  });

  it('keeps the default resume when AI is off even if automatic selection is enabled', async () => {
    const analystJob = makeJob(
      {
        id: '900001',
        title: 'Data Analyst Intern',
        description: 'data analyst sql dashboards reporting',
        fitScore: 0.9,
        requiredDocumentTypes: [],
      },
      1,
    );

    const { options } = await runApply(
      baseSettings({
        ai: { enabled: false },
        documents: {
          defaultResumeId: 'resume-frontend',
          defaultResumeName: 'A Frontend Resume',
          additionalResumes: [{ id: 'resume-analyst', name: 'Data Resume' }],
          autoSelectResume: true,
        },
        safety: { reviewBeforeSubmit: true },
      }),
      analystJob,
      ready,
    );

    expect(options?.documents.resumeId).toBe('resume-frontend');
  });

  it.each([false, true])(
    'uses the chosen default when automatic selection is off (AI=%s)',
    async (enabled) => {
      const match = vi.spyOn(matcher, 'matchResume');
      const { options } = await runApply(
        baseSettings({
          documents: { defaultResumeId: 'chosen', autoSelectResume: false },
          ai: { enabled },
        }),
        job,
        ready,
      );
      expect(options?.documents.resumeId).toBe('chosen');
      expect(match).not.toHaveBeenCalled();
    },
  );

  it.each(['default', 'additional', 'unknown'])(
    'offers every configured resume to AI and accepts only a configured choice: %s',
    async (returnedId) => {
      const match = vi.spyOn(matcher, 'matchResume').mockResolvedValue({
        ok: true,
        value: {
          resumeId: returnedId,
          confidence: 1,
          reason: 'Fixture match',
          provider: 'heuristic',
          cached: false,
        },
      });
      const { options } = await runApply(
        baseSettings({
          documents: {
            defaultResumeId: 'default',
            defaultResumeName: 'First Resume',
            additionalResumes: [{ id: 'additional', name: 'Second Resume' }],
            autoSelectResume: true,
          },
          ai: { enabled: true },
        }),
        job,
        ready,
      );
      expect(match.mock.calls[0]?.[0].resumes.map((resume) => resume.id)).toEqual([
        'default',
        'additional',
      ]);
      expect(options?.documents.resumeId).toBe(returnedId === 'unknown' ? 'default' : returnedId);
      expect(
        options?.documentsAvailable?.filter((document) => document.type === 'resume'),
      ).toHaveLength(2);
    },
  );

  it('uses the default without an AI call when a resume has no name', async () => {
    const match = vi.spyOn(matcher, 'matchResume');
    const { options } = await runApply(
      baseSettings({
        documents: {
          defaultResumeId: 'default',
          additionalResumes: [{ id: 'additional', name: 'Second Resume' }],
          autoSelectResume: true,
        },
        ai: { enabled: true },
      }),
      job,
      ready,
    );
    expect(match).not.toHaveBeenCalled();
    expect(options?.documents.resumeId).toBe('default');
  });

  it('uses the only resume without an AI call', async () => {
    const match = vi.spyOn(matcher, 'matchResume');
    const { options } = await runApply(
      baseSettings({
        documents: {
          defaultResumeId: 'default',
          defaultResumeName: 'Only',
          autoSelectResume: true,
        },
        ai: { enabled: true },
      }),
      job,
      ready,
    );
    expect(match).not.toHaveBeenCalled();
    expect(options?.documents.resumeId).toBe('default');
  });

  it('never calls AI when no resume is configured', async () => {
    const match = vi.spyOn(matcher, 'matchResume');
    const { options } = await runApply(
      baseSettings({
        documents: { autoSelectResume: true },
        ai: { enabled: true },
      }),
      job,
      ready,
    );
    expect(options?.documents.resumeId).toBeUndefined();
    expect(match).not.toHaveBeenCalled();
  });

  it('passes exact per-job documents and None to apply instead of global choices or AI', async () => {
    const match = vi.spyOn(matcher, 'matchResume');
    const chosen = {
      resumeId: 'job-resume',
      coverLetterId: '',
      transcriptId: 'transcript',
      otherDocumentId: '',
    };
    const { options } = await runApply(
      baseSettings({
        documents: {
          defaultResumeId: 'default',
          autoSelectResume: true,
          coverLetterId: 'global-cover',
        },
        ai: { enabled: true },
      }),
      job,
      ready,
      { documentSelection: chosen },
    );
    expect(options?.documents).toEqual(chosen);
    expect(match).not.toHaveBeenCalled();
  });

  it('takes a pacer session break after the configured batch', async () => {
    const { engine } = await runApply(
      baseSettings({
        pacing: {
          sessionBatchSize: 1,
          useAdvanced: true,
          sessionBreakMinMs: 600_000,
          sessionBreakMaxMs: 600_000,
        },
        safety: { reviewBeforeSubmit: false },
      }),
      job,
      { jobId: '900001', outcome: 'applied', confirmationText: 'Application submitted' },
    );

    expect(engine.getState().message).toMatch(/session batch complete/i);
    expect(fake.alarms.create).toHaveBeenCalled();
  });

  it('records would_apply as a neutral dry-run result, not a failure', async () => {
    const { engine } = await runApply(mergeSettings(baseSettings(), { mode: 'dry_run' }), job, {
      jobId: '900001',
      outcome: 'would_apply',
    });

    expect(await getQueueItem('900001')).toMatchObject({ status: 'would_apply' });
    expect(engine.getState().status).not.toBe('error');
    expect(engine.getState().message).toMatch(/dry run/i);
    expect(await getMeta('needs:900001')).toBeFalsy();
    expect(await getSubmissionsForJob('900001')).toEqual([]);
  });
});
