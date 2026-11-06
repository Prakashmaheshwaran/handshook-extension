import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApplyOptions,
  ContentRequest,
  QuestionDescriptor,
  QueueItem,
  SettingsPatch,
} from '@/core/contracts';
import { handleUi } from '@/background/router';
import { Engine, engine as backgroundEngine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { getQueueItem, putJob, putQueueItem } from '@/core/orchestrator/queue';
import { getMeta, getTodayCount, resetDb } from '@/core/storage/db';
import {
  listAnswers,
  listJobAnswers,
  saveAnswer,
  saveJobAnswerOverride,
} from '@/core/storage/answers';
import { saveSettings } from '@/core/storage/settings';
import { listInboxQuestions } from '@/core/storage/questionInbox';
import { applyToJob } from '@/handshake/applyFlow';
import { extractQuestions } from '@/handshake/questions';
import {
  makeAnswer,
  makeEngineState,
  makeJob,
  makeQueueItem,
  makeSettings,
} from '@/test/factories';
import { createFakeBrowser } from '../unit/helpers/fakeBrowser';

const job = makeJob({
  id: '900001',
  applyType: 'handshake_form',
  requiredDocumentTypes: ['resume'],
  fitScore: 0.9,
});
const bankAnswer = makeAnswer({
  id: 'work-answer',
  label: 'Are you authorized to work in the United States?',
  type: 'select',
  value: 'yes',
  options: { Yes: 'yes', No: 'no' },
  sensitive: true,
  autoSubmitAllowed: false,
});
const allOptIns = {
  reviewBeforeSubmit: false,
  allowSensitiveAutoSubmit: true,
  allowEeoAutoFill: true,
  allowFreeTextAutoFill: true,
};

function loadForm(required = true) {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-form-unknown-question.html'),
    'utf8',
  );
  const dialog = document.querySelector<HTMLElement>('#apply-dialog');
  const field = document.querySelector<HTMLSelectElement>('#work-auth');
  if (!dialog || !field) throw new Error('Missing fixture form');
  field.required = required;
  // Capture the same stable question identity that the adapter sees after open.
  dialog.hidden = false;
  const question = extractQuestions(document)[0];
  dialog.hidden = true;
  if (!question) throw new Error('Missing fixture question');
  document.querySelector('button')?.addEventListener('click', () => {
    dialog.hidden = false;
  });
  const submit = vi.fn(() => {
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Application submitted';
    document.body.appendChild(status);
  });
  document.querySelector('[data-testid="submit-application"]')?.addEventListener('click', submit);
  return { question, field, submit };
}

async function run(patch: SettingsPatch = {}) {
  const settings = makeSettings({
    onboardingComplete: true,
    mode: 'autopilot',
    documents: { defaultResumeId: 'doc-resume', autoSelectResume: false },
    search: { minFitScore: 0 },
    pacing: { activeHours: null },
    safety: allOptIns,
    ...patch,
  });
  await saveSettings(settings);
  await putJob(job);
  let item = await getQueueItem(job.id);
  if (!item) {
    item = makeQueueItem({ jobId: job.id, status: 'queued' });
    await putQueueItem(item);
  }
  const requests: ApplyOptions[] = [];
  const tabs = {
    id: 1,
    ensure: vi.fn(async () => 1),
    cancel: vi.fn(async () => {}),
    send: vi.fn(async (request: ContentRequest) => {
      if (request.type === 'content.inspectJob')
        return { requestId: request.requestId, ok: true, data: job };
      if (request.type === 'content.apply') {
        requests.push(request.options);
        return {
          requestId: request.requestId,
          ok: true,
          data: await applyToJob(document, job, request.options, undefined, {
            authorizeSubmit: () =>
              engine.authorizeSubmit(job.id, request.requestId, tabs.id ?? undefined),
            needsReview: () => false,
          }),
        };
      }
      return { requestId: request.requestId, ok: true, data: null };
    }),
  } as unknown as RunnerTabManager;
  const engine = new Engine({
    tabs,
    clock: { now: () => Date.now(), sleep: async () => {}, random: () => 0.5 },
  });
  await engine.load();
  engine.getState().status = 'running';
  engine.getState().mode = settings.mode;
  await (engine as unknown as { apply(item: QueueItem): Promise<void> }).apply(item);
  return { engine, requests };
}

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  window.localStorage.clear();
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('saved answer approval through engine, form and Needs You', () => {
  it.each([true, false])(
    'lists an unapproved answer in Needs You and never submits even when required=%s and every global opt-in is on',
    async (required) => {
      const { field, question, submit } = loadForm(required);
      await saveAnswer(bankAnswer);
      const { engine } = await run({ safety: { ...allOptIns, stopOnUnknownQuestion: false } });
      expect(field.value).toBe('');
      expect(submit).not.toHaveBeenCalled();
      // Autopilot parks the job in Needs You and keeps the run going.
      expect(engine.getState().status).toBe('running');
      expect((await getQueueItem(job.id))?.status).toBe('needs_input');
      expect(await getTodayCount()).toBe(0);
      const pending = await getMeta<{ questions: QuestionDescriptor[] }>(`needs:${job.id}`);
      expect(pending?.questions).toEqual([
        expect.objectContaining({
          id: question.id,
          label: question.label,
          suggestedAnswer: 'yes',
          helpText: expect.stringMatching(/approval/),
        }),
      ]);
    },
  );

  it('also leaves unapproved reusable answers blank in Review mode', async () => {
    const { field, submit } = loadForm();
    await saveAnswer(bankAnswer);
    const { engine } = await run({ mode: 'review' });
    expect(field.value).toBe('');
    expect(submit).not.toHaveBeenCalled();
    expect(engine.getState().status).toBe('needs_user');
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
  });

  it('fills and submits an approved reusable answer when all global opt-ins allow it', async () => {
    const { field, submit } = loadForm();
    await saveAnswer({ ...bankAnswer, autoSubmitAllowed: true });
    // An unrelated bank opt-out must not block a job that never uses it.
    await saveAnswer(
      makeAnswer({ id: 'unused', label: 'Graduation date', type: 'date', value: '2027-01-01' }),
    );
    await run();
    expect(field.value).toBe('yes');
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await getQueueItem(job.id))?.status).toBe('applied');
    expect(await getTodayCount()).toBe(1);
  });

  it('does not let per-answer approval bypass a global sensitive opt-out', async () => {
    const { field, submit } = loadForm();
    await saveAnswer({ ...bankAnswer, autoSubmitAllowed: true });
    await run({ safety: { ...allOptIns, allowSensitiveAutoSubmit: false } });
    expect(field.value).toBe('');
    expect(submit).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
  });

  it('fills a job-specific unapproved answer but forces Review in both guards', async () => {
    const { question, field, submit } = loadForm();
    await saveJobAnswerOverride(job.id, { ...bankAnswer, id: question.id });
    const { requests } = await run();
    expect(requests[0]?.reviewBeforeSubmit).toBe(true);
    expect(field.value).toBe('yes');
    expect(submit).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
    // The content-side policy remains safe even if a caller forgets its review flag.
    const options = requests[0];
    if (!options) throw new Error('Missing apply request');
    const authorizeSubmit = vi.fn(async () => true);
    const result = await applyToJob(
      document,
      job,
      { ...options, reviewBeforeSubmit: false },
      undefined,
      { authorizeSubmit, needsReview: () => false },
    );
    expect(result.outcome).toBe('ready_for_review');
    expect(authorizeSubmit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('honors a newer bank opt-out instead of using stale job approval', async () => {
    const { question, field, submit } = loadForm();
    await saveJobAnswerOverride(job.id, {
      ...bankAnswer,
      id: question.id,
      value: 'no',
      autoSubmitAllowed: true,
      updatedAt: 1,
    });
    await saveAnswer({ ...bankAnswer, id: question.id, value: 'yes' });
    const { requests } = await run();
    expect(requests[0]?.reviewBeforeSubmit).toBe(true);
    expect(requests[0]?.answers.filter((answer) => answer.id === question.id)).toHaveLength(1);
    expect(field.value).toBe('yes');
    expect(submit).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
  });

  it('lets Needs You edit the answer for this job without changing the reusable opt-out', async () => {
    const { question, field, submit } = loadForm();
    await saveAnswer(bankAnswer);
    await run();
    const resume = vi.spyOn(backgroundEngine, 'resume').mockResolvedValue(makeEngineState());
    const saved = await handleUi({
      type: 'ui.job.answer',
      requestId: 'answer-this-job',
      jobId: job.id,
      questionId: question.id,
      value: 'no',
      remember: false,
    });
    expect(saved.ok).toBe(true);
    // The Autopilot run is still active, so the job is requeued for it to pick up.
    expect(resume).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('queued');
    expect((await listAnswers())[0]?.autoSubmitAllowed).toBe(false);
    expect((await listJobAnswers(job.id))[0]?.value).toBe('no');
    await run();
    expect(field.value).toBe('no');
    expect(submit).toHaveBeenCalledOnce();
    expect((await getQueueItem(job.id))?.status).toBe('applied');
  });

  it('does not reset an existing same-question opt-out when Needs You saves an edit', async () => {
    const { question, field, submit } = loadForm();
    await saveAnswer({ ...bankAnswer, id: question.id });
    await run();
    vi.spyOn(backgroundEngine, 'resume').mockResolvedValue(makeEngineState());
    expect(
      (
        await handleUi({
          type: 'ui.job.answer',
          requestId: 'edit-existing-answer',
          jobId: job.id,
          questionId: question.id,
          value: 'no',
          remember: true,
        })
      ).ok,
    ).toBe(true);
    expect((await listAnswers())[0]?.autoSubmitAllowed).toBe(false);
    expect((await listJobAnswers(job.id))[0]?.autoSubmitAllowed).toBe(false);
    await run();
    expect(field.value).toBe('no');
    expect(submit).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('ready_for_review');
  });

  it.each([true, false])(
    'never submits an unknown required question with stopOnUnknownQuestion=%s',
    async (stopOnUnknownQuestion) => {
      const { submit } = loadForm();
      await run({ safety: { ...allOptIns, stopOnUnknownQuestion } });
      expect(submit).not.toHaveBeenCalled();
      expect((await getQueueItem(job.id))?.status).toBe(
        stopOnUnknownQuestion ? 'needs_input' : 'ready_for_review',
      );
    },
  );

  it('routes ambiguous required answers to Needs You without picking the first', async () => {
    const { field, submit } = loadForm();
    await saveAnswer({ ...bankAnswer, autoSubmitAllowed: true });
    await saveAnswer({
      ...bankAnswer,
      id: 'conflicting-answer',
      value: 'no',
      autoSubmitAllowed: true,
    });
    await run();
    expect(field.value).toBe('');
    expect(submit).not.toHaveBeenCalled();
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
  });

  it('adds an unanswered question to Questions to answer, and saving it releases the waiting job', async () => {
    const { question } = loadForm();
    const { engine } = await run();
    expect(engine.getState().status).toBe('running');
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
    const inbox = await listInboxQuestions();
    expect(inbox).toEqual([
      expect.objectContaining({
        label: question.label,
        type: 'select',
        required: true,
        source: 'run',
      }),
    ]);
    expect(inbox[0]?.jobIds).toEqual([job.id]);

    const saved = await handleUi({
      type: 'ui.answer.save',
      requestId: 'save-from-inbox',
      answer: makeAnswer({
        id: 'asked-work',
        label: 'Are you authorized to work in the united states',
        type: 'select',
        value: 'yes',
        options: { yes: 'yes', no: 'no' },
        autoSubmitAllowed: true,
        sensitive: true,
      }),
    });
    expect(saved.ok).toBe(true);
    expect((await getQueueItem(job.id))?.status).toBe('queued');
    expect(await getMeta(`needs:${job.id}`)).toBeNull();
    expect(await listInboxQuestions()).toEqual([]);
  });

  it('still pauses the whole run at Needs You in Review mode', async () => {
    loadForm();
    const { engine } = await run({ mode: 'review' });
    expect((await getQueueItem(job.id))?.status).toBe('needs_input');
    expect(engine.getState().status).toBe('needs_user');
  });

  it('remembering an answer updates the saved answer with the same wording, not a copy', async () => {
    const { question } = loadForm();
    await saveAnswer(bankAnswer);
    await run();
    const saved = await handleUi({
      type: 'ui.job.answer',
      requestId: 'remember',
      jobId: job.id,
      questionId: question.id,
      value: 'no',
      remember: true,
    });
    expect(saved.ok).toBe(true);
    const sameWording = (await listAnswers()).filter((answer) => answer.label === bankAnswer.label);
    expect(sameWording).toEqual([
      expect.objectContaining({ id: bankAnswer.id, value: 'no', autoSubmitAllowed: false }),
    ]);
  });
});
