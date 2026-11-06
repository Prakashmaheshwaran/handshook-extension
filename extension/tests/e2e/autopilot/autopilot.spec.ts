/**
 * Autopilot and failure-mode E2E.
 *
 * The mock site provides the contract (quick apply, forms, questions, 429/403,
 * ambiguous confirmation). These tests drive the real background engine and content
 * adapter to prove the safety guarantees: a safe quick apply is verified, unknown
 * questions and missing documents pause, sensitive answers are never auto-filled,
 * caps stop the run, rate limits do not loop, a crash is reconciled without a
 * duplicate submit, a closed tab or restarted browser pauses, and a missing selector
 * pauses as UI_CHANGED.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchExtension, openSidePanel, test } from '../helpers/extension';
import { installHandshakeRoutes, type MockHandshake } from '../helpers/handshake';
import { SAMPLE_ANSWERS, SAMPLE_DOCUMENTS, SAMPLE_JOBS } from '../../../src/test/mockData';
import { PROTOCOL_VERSION } from '../../../src/core/contracts';
import { makeJob } from '../../../src/test/factories';
import type { Job, QueueItem } from '../../../src/core/contracts';
import {
  getQueue,
  getState,
  listSubmissions,
  resumeEngine,
  runnerPage,
  saveEngineState,
  seedExtension,
  seedRecords,
  startEngine,
  waitFor,
  type SeedOptions,
} from '../helpers/seed';

const SINGLE_RESUME = SAMPLE_DOCUMENTS.filter((document) => document.id === 'document-0001');

async function appliedActivity(sidePanel: Page) {
  return sidePanel.evaluate(async (protocolVersion) => {
    const response = await chrome.runtime.sendMessage({
      type: 'ui.events.list',
      requestId: 'reconciled-activity',
      protocolVersion,
    });
    return (response.data as Array<{ id: string; type: string; jobId?: string }>).filter(
      (event) => event.type === 'job.applied',
    );
  }, PROTOCOL_VERSION);
}

/** Submission scenarios explicitly accept Handshake-profile defaults. */
async function seedQuickApply(
  sidePanel: Page,
  mock: MockHandshake,
  settings: SeedOptions['settings'] = {},
): Promise<void> {
  mock.setDocuments(SINGLE_RESUME);
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      ...settings,
      safety: { allowOneClickApply: true, ...settings.safety },
      documents: {
        defaultResumeId: 'document-0001',
        coverLetterId: undefined,
        transcriptId: undefined,
        autoSelectResume: false,
        ...settings.documents,
      },
    },
  });
}

test.describe('autopilot and failure modes', () => {
  test('review never clicks an Apply action that does not declare a form', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'undeclared-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);
    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'ready_for_review',
      { description: 'unadvertised Apply needs manual review' },
    );
    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('apply-dialog')).toBeHidden();
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
    // Resume must preserve this handoff rather than scanning/navigating away.
    const runnerLoads = mock.pagesServed.filter((page) => page === '/jobs/900001').length;
    const resume = await sidePanel.evaluate(
      async (protocolVersion) =>
        chrome.runtime.sendMessage({
          type: 'ui.engine.resume',
          requestId: 'resume-with-review-open',
          protocolVersion,
        }),
      PROTOCOL_VERSION,
    );
    expect(resume).toMatchObject({
      ok: false,
      error: {
        message: 'Stop the run and finish any pending review before refreshing the runner.',
      },
    });
    // The real Home action must explain the guard, not hide it behind a
    // generic error that suggests reloading the unfinished application.
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(sidePanel.getByRole('alert')).toContainText(
      'finish or skip the pending application in Needs you',
    );
    expect((await getState(sidePanel)).status).toBe('needs_user');
    expect(runner.url()).toBe(mock.jobUrl('900001'));
    expect(mock.pagesServed.filter((page) => page === '/jobs/900001')).toHaveLength(runnerLoads);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
  });

  test('autopilot clicks an unadvertised Apply, fills the dialog it opens, and applies exactly once', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'undeclared-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);
    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'unadvertised Apply opened its dialog and applied once', timeoutMs: 40_000 },
    );

    // The plain Apply opened Handshake's own dialog, which the flow then filled
    // and submitted from — it did not treat the label as an instant submit.
    const runner = runnerPage(context, '900001');
    expect(runner.url()).toBe(mock.jobUrl('900001'));
    await expect(runner.getByTestId('confirmation')).toHaveText(/application submitted/i);
    const attempts = (await listSubmissions(sidePanel)).filter(
      (attempt) => attempt.jobId === '900001',
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'applied',
      documents: [{ type: 'resume', id: 'document-0001' }],
    });
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
    expect((await getState(sidePanel)).todayCount).toBe(1);
  });

  test('quick apply submits and shows a confirmation', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900001'));

    await page.getByTestId('apply-button').click();

    await expect(page.getByTestId('confirmation')).toHaveText(/application submitted/i);
    await expect(page.getByTestId('apply-button')).toBeDisabled();
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
  });

  test('a form blocks submit until required documents are chosen', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900002'));

    await page.getByTestId('apply-button').click();
    await expect(page.getByTestId('apply-dialog')).toBeVisible();

    await page.getByTestId('submit-application').click();
    await expect(page.getByTestId('form-error')).toContainText(/required fields/i);
    expect(mock.requestsFor('/jobs/900002/applications')).toHaveLength(0);

    await page.getByTestId('document-resume').selectOption('document-0001');
    await page.getByTestId('document-cover-letter').selectOption('document-0003');
    await page.getByTestId('submit-application').click();

    await expect(page.getByTestId('confirmation')).toHaveText(/application submitted/i);
  });

  test('an unknown-question form requires every required control', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'form-questions');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900003'));

    await page.getByTestId('apply-button').click();
    await page.getByTestId('document-resume').selectOption('document-0001');
    await page.getByTestId('submit-application').click();

    await expect(page.getByTestId('form-error')).toContainText(/required fields/i);
    expect(mock.requestsFor('/jobs/900003/applications')).toHaveLength(0);

    await page.getByTestId('question-why').fill('I want to work on reliable backend systems.');
    await page.getByTestId('question-work-authorization').selectOption('yes');
    await page.getByTestId('question-sponsorship').getByLabel('No').check();
    await page.getByTestId('submit-application').click();

    await expect(page.getByTestId('confirmation')).toBeVisible();
  });

  test('rate limiting surfaces as an error and sends no confirmation', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'rate-limited');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900001'));

    await page.getByTestId('apply-button').click();

    await expect(page.getByTestId('submit-error')).toContainText(/too many requests/i);
    await expect(page.getByTestId('confirmation')).toHaveCount(0);
    await expect(page.getByTestId('apply-button')).toBeEnabled();

    const apiStatus = await page.evaluate(
      async (url) => (await fetch(url, { headers: { Accept: 'application/json' } })).status,
      mock.apiUrl('900001'),
    );
    expect(apiStatus).toBe(429);
  });

  test('already-applied and closed jobs have no apply control', async ({ context }) => {
    const applied = await installHandshakeRoutes(context, 'already-applied');
    const page = await context.newPage();

    await page.goto(applied.jobUrl('900007'));
    await expect(page.getByTestId('applied-banner')).toContainText(/you applied on/i);
    await expect(page.getByTestId('apply-button')).toHaveCount(0);

    await applied.dispose();
    const closed = await installHandshakeRoutes(context, 'closed');
    await page.goto(closed.jobUrl('900009'));
    await expect(page.getByTestId('closed-banner')).toContainText(/no longer accepting/i);
    await expect(page.getByTestId('apply-button')).toHaveCount(0);
  });

  test('a missing apply control leaves no submit path', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'missing-selector');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900001'));

    await expect(page.getByTestId('job-actions-missing')).toBeVisible();
    await expect(page.getByTestId('apply-button')).toHaveCount(0);
    await expect(page.getByTestId('submit-application')).toHaveCount(0);
  });

  test('shows review-first safety copy in the side panel', async ({ sidePanel }) => {
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    const job = makeJob({ id: '900001', title: 'Software Engineering Intern' });
    await seedRecords(sidePanel, {
      job,
      queueItem: {
        jobId: job.id,
        status: 'ready_for_review',
        priority: 80,
        attempts: 0,
        addedAt: Date.now() - 1_000,
        updatedAt: Date.now() - 500,
      },
    });
    await sidePanel.reload();

    // Review mode must still tell the owner that it stops here and never
    // submits on their behalf; the hand-off is theirs to open and finish.
    await expect(
      sidePanel.getByRole('heading', {
        name: '1 application is ready for you to submit on Handshake',
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      sidePanel.getByText(
        'You chose to review applications before submitting, so Handshook stops here and never clicks Submit for you.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(sidePanel.getByText('Review mode', { exact: true }).first()).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Open job', exact: true })).toBeVisible();
    await expect(
      sidePanel.getByRole('button', { name: 'Start review run', exact: true }),
    ).toBeVisible();
  });

  test('autopilot submits a safe quick apply and verifies it', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedQuickApply(sidePanel, mock);
    await startEngine(sidePanel);

    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'quick apply marked applied', timeoutMs: 30_000 },
    );

    const state = await getState(sidePanel);
    expect(state.todayCount).toBeGreaterThanOrEqual(1);
    const submissions = await listSubmissions(sidePanel);
    expect(submissions.find((attempt) => attempt.jobId === '900001')).toMatchObject({
      status: 'applied',
      documents: 'handshake_profile_defaults',
    });
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);

    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('confirmation')).toHaveText(/application submitted/i);
  });

  test('autopilot applies once through one-click consent when its chosen resume cannot be verified', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: {
        mode: 'autopilot',
        documents: {
          defaultResumeId: 'document-0002',
          coverLetterId: undefined,
          transcriptId: undefined,
          autoSelectResume: false,
        },
      },
    });
    await startEngine(sidePanel);
    // One-click consent is on by default, so an instant-submit Quick Apply is
    // taken once. The chosen file cannot be proven, so the record must say the
    // profile defaults were sent instead of claiming a verified document ID.
    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'one-click consent applied once', timeoutMs: 30_000 },
    );
    const attempts = (await listSubmissions(sidePanel)).filter(
      (attempt) => attempt.jobId === '900001',
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'applied',
      documents: 'handshake_profile_defaults',
    });
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
    expect((await getState(sidePanel)).todayCount).toBe(1);
  });

  test('dry run records a would-apply result without filling or submitting', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'dry_run' } });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) =>
        value.items.some(
          (item) => item.jobId === '900001' && (item.status as string) === 'would_apply',
        ),
      { description: 'dry run recorded a would-apply result', timeoutMs: 30_000 },
    );
    expect(queue.items.find((item) => item.jobId === '900001')?.status).toBe('would_apply');

    // A dry run may open a form whose Apply declares a dialog, to read its
    // questions. It never fills, chooses documents or submits.
    const runner = context.pages().find((candidate) => candidate.url().includes('/jobs/900001'));
    if (runner) await expect(runner.getByTestId('confirmation')).toHaveCount(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
  });

  test('autopilot with reviewBeforeSubmit fills the form and stops before submit', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: { mode: 'autopilot', safety: { reviewBeforeSubmit: true } },
    });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.counts.ready_for_review === 1,
      { description: 'autopilot stopped at review instead of submitting', timeoutMs: 30_000 },
    );
    expect(queue.summary.counts.ready_for_review).toBe(1);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);

    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('apply-dialog')).toBeVisible();
    await expect(runner.getByTestId('document-resume')).toHaveValue('document-0001');
    await expect(runner.getByTestId('confirmation')).toHaveCount(0);
  });

  test('unknown screening question pauses for input and resumes after an answer', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-questions');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: { mode: 'autopilot', safety: { allowFreeTextAutoFill: false } },
      answers: SAMPLE_ANSWERS.map((answer) => ({ ...answer, autoSubmitAllowed: true })),
    });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.needs.length > 0 && value.needs[0]!.questions.length > 0,
      { description: 'screening question surfaced as needs-input', timeoutMs: 30_000 },
    );
    const need = queue.needs[0]!;
    const question = need.questions.find((entry) => /why are you interested/i.test(entry.label));
    expect(question).toBeTruthy();
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);

    await sidePanel.evaluate(
      async ({ jobId, questionId, protocolVersion }) => {
        await chrome.runtime.sendMessage({
          type: 'ui.settings.update',
          requestId: 'allow-free-text',
          protocolVersion,
          patch: { safety: { allowFreeTextAutoFill: true } },
        });
        return chrome.runtime.sendMessage({
          type: 'ui.job.answer',
          requestId: 'answer',
          protocolVersion,
          jobId,
          questionId,
          value: 'I want to build reliable tools with a small team.',
          remember: false,
        });
      },
      { jobId: need.jobId, questionId: question!.id, protocolVersion: PROTOCOL_VERSION },
    );

    await waitFor(
      () => getQueue(sidePanel),
      (value) => value.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'run resumed and applied after the answer', timeoutMs: 30_000 },
    );
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
  });

  test('missing transcript pauses as needs-input instead of substituting a document', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-transcript');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      // No transcript ID entered; the form requires one.
      settings: { mode: 'autopilot', documents: { transcriptId: '' } },
    });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) =>
        value.needs.length > 0 && value.needs[0]!.missingDocumentTypes.includes('transcript'),
      { description: 'missing transcript surfaced', timeoutMs: 30_000 },
    );
    const need = queue.needs[0]!;
    expect(need.reason).toBe('documents');
    expect(need.missingDocumentTypes).toEqual(['transcript']);
    expect(queue.items.find((item) => item.jobId === '900001')?.missingDocumentTypes).toEqual([
      'transcript',
    ]);
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
  });

  test('sensitive unapproved answer pauses and is never auto-filled', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-questions');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: {
        mode: 'autopilot',
        safety: {
          allowSensitiveAutoSubmit: true,
          allowFreeTextAutoFill: true,
          allowEeoAutoFill: true,
        },
      },
    });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) =>
        value.needs.length > 0 &&
        value.needs[0]!.questions.some((question) =>
          /authorized|sponsorship/i.test(question.label),
        ),
      { description: 'sensitive question awaits approval', timeoutMs: 30_000 },
    );
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);

    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('question-work-authorization')).toHaveValue('');
    await expect(runner.locator('input[name="sponsorship_required"]:checked')).toHaveCount(0);
    await expect(runner.getByTestId('question-why')).toHaveValue('');
  });

  test('daily cap stops the run and the hard cap cannot be bypassed', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!, SAMPLE_JOBS[1]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedQuickApply(sidePanel, mock, {
      pacing: {
        dailyCap: 100,
        hardCap: 1,
        minDelayMs: 10_000,
        maxDelayMs: 10_000,
        jitterPercent: 0,
      },
    });
    await startEngine(sidePanel);

    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.summary.counts.applied === 1,
      {
        description: 'first application counted',
        timeoutMs: 30_000,
      },
    );
    const state = await waitFor(
      () => getState(sidePanel),
      (value) => value.status === 'idle' && (value.message ?? '').includes('cap reached'),
      { description: 'run finished at the hard cap', timeoutMs: 30_000 },
    );
    expect(state.pauseReason).toBeUndefined();

    const queue = await getQueue(sidePanel);
    expect(queue.summary.counts.applied).toBe(1);
    expect(queue.items.find((item) => item.jobId === '900002')?.status).toBe('queued');
    expect(mock.requestsFor('/jobs/900002/applications')).toHaveLength(0);
  });

  test('429 and 403 responses trigger backoff and pause, not retry loops', async ({
    context,
    sidePanel,
  }) => {
    const rateLimited = await installHandshakeRoutes(context, 'rate-limited');
    rateLimited.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(rateLimited.searchUrl());
    await seedQuickApply(sidePanel, rateLimited);
    await startEngine(sidePanel);

    await waitFor(
      () => getState(sidePanel),
      (state) => state.pauseReason === 'rate_limited',
      { description: '429 pauses the run', timeoutMs: 30_000 },
    );
    // A read-only 429 must stop the run before any application is attempted.
    expect(rateLimited.requestsFor('/jobs/900001/applications')).toHaveLength(0);
    expect((await getQueue(sidePanel)).summary.counts.applied ?? 0).toBe(0);
    await rateLimited.dispose();

    const forbidden = await installHandshakeRoutes(context, 'application-forbidden');
    forbidden.setDocuments(SINGLE_RESUME);
    forbidden.setSearchJobs([SAMPLE_JOBS[0]!]);
    const retry = await sidePanel.evaluate(async (protocolVersion) => {
      return chrome.runtime.sendMessage({
        type: 'ui.queue.retry',
        requestId: 'retry-after-403',
        protocolVersion,
        jobId: '900001',
      });
    }, PROTOCOL_VERSION);
    expect((retry as { ok: boolean }).ok).toBe(true);

    await waitFor(
      () => Promise.resolve(forbidden.requestsFor('/jobs/900001/applications').length),
      (count) => count === 1,
      { description: '403 attempt issued once', timeoutMs: 30_000 },
    );
    const paused = await waitFor(
      () => getState(sidePanel),
      (state) => state.pauseReason === 'rate_limited',
      { description: '403 pauses the run', timeoutMs: 30_000 },
    );
    expect(paused.lastError?.code).toBe('FORBIDDEN');
    expect(forbidden.requestsFor('/jobs/900001/applications')).toHaveLength(1);
    expect((await getQueue(sidePanel)).summary.counts.applied ?? 0).toBe(0);
  });

  test('crash after submit reconciles to applied with no duplicate submission', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'already-applied');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    // Open the routed job page before the engine starts. This is the tab the
    // engine reuses; a tab the extension creates itself is not yet covered by
    // Playwright routing until a page exists.
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900001'));
    await seedExtension(sidePanel, { settings: { mode: 'review' } });

    const job = SAMPLE_JOBS[0]!;
    const now = Date.now();
    await seedRecords(sidePanel, {
      job,
      queueItem: {
        jobId: job.id,
        status: 'queued',
        priority: 91,
        attempts: 1,
        addedAt: now - 60_000,
        updatedAt: now - 60_000,
      },
      submission: {
        id: 'attempt-crash-after-submit',
        runId: 'run-crashed',
        jobId: job.id,
        host: job.host,
        startedAt: now - 30_000,
        status: 'started',
        applyType: 'quick_apply',
        documents: [],
        questionIds: [],
      },
    });

    await startEngine(sidePanel);

    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === job.id)?.status === 'applied',
      { description: 'crashed submission reconciled to applied', timeoutMs: 30_000 },
    );

    const submissions = await listSubmissions(sidePanel);
    const crashed = submissions.find((attempt) => attempt.id === 'attempt-crash-after-submit');
    expect(crashed?.status).toBe('applied');
    expect(crashed?.reconciliationNote).toMatch(/verified applied/i);
    expect(await appliedActivity(sidePanel)).toEqual([
      expect.objectContaining({ id: 'attempt-crash-after-submit', jobId: job.id }),
    ]);
    expect(mock.requests.filter((entry) => entry.pathname.endsWith('/applications'))).toHaveLength(
      0,
    );
  });

  test('tab close or browser restart pauses the run and can be resumed', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([SAMPLE_JOBS[0]!, SAMPLE_JOBS[1]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'first application completed', timeoutMs: 30_000 },
    );

    const runner = runnerPage(context, '900001');
    await runner.close();

    const paused = await waitFor(
      () => getState(sidePanel),
      (state) => state.status === 'paused' && state.pauseReason === 'tab_closed',
      { description: 'closing the runner tab pauses the run', timeoutMs: 15_000 },
    );
    expect(paused.pauseReason).toBe('tab_closed');

    await resumeEngine(sidePanel);
    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.items.find((item) => item.jobId === '900002')?.status === 'applied',
      { description: 'resume opens a new runner tab and applies the next job', timeoutMs: 45_000 },
    );
    expect(queue.summary.counts.applied).toBe(2);
    expect(mock.requestsFor('/jobs/900002/applications')).toHaveLength(1);
    await waitFor(
      () =>
        Promise.resolve(context.pages().filter((entry) => /\/jobs\/\d+/.test(entry.url())).length),
      (count) => count >= 1,
      { description: 'a replacement runner tab is open', timeoutMs: 10_000 },
    );
  });

  test('missing selector pauses with UI_CHANGED instead of clicking the wrong element', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'missing-selector');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    const state = await waitFor(
      () => getState(sidePanel),
      (value) => value.pauseReason === 'ui_changed',
      { description: 'missing selector pauses with ui_changed', timeoutMs: 30_000 },
    );
    expect(state.lastError?.code).toBe('UI_CHANGED');

    const queue = await getQueue(sidePanel);
    expect(queue.items.find((item) => item.jobId === '900001')?.status).toBe('blocked');
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
    await expect(runnerPage(context, '900001').getByTestId('job-actions-missing')).toBeVisible();
  });

  test('ambiguous confirmation moves to verifying and reconciles later', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'ambiguous-confirmation');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedQuickApply(sidePanel, mock);
    await startEngine(sidePanel);

    const ambiguous = await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'verifying',
      { description: 'missing confirmation moves the job to verifying', timeoutMs: 40_000 },
    );
    expect(ambiguous.summary.counts.applied ?? 0).toBe(0);
    const state = await getState(sidePanel);
    expect(state.status).toBe('needs_user');
    expect(state.message).toMatch(/verification/i);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
    await mock.dispose();

    // The page later shows the applied banner (simulating the delayed evidence).
    const appliedMock = await installHandshakeRoutes(context, 'already-applied');
    appliedMock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const runner = runnerPage(context, '900001');
    await runner.reload();
    await expect(runner.getByTestId('applied-banner')).toBeVisible();

    await resumeEngine(sidePanel);
    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.find((item) => item.jobId === '900001')?.status === 'applied',
      { description: 'verifying job reconciled to applied', timeoutMs: 30_000 },
    );
    const submissions = await listSubmissions(sidePanel);
    expect(submissions.find((attempt) => attempt.jobId === '900001')?.status).toBe('applied');
    const appliedEvents = await appliedActivity(sidePanel);
    expect(appliedEvents).toEqual([expect.objectContaining({ jobId: '900001' })]);
    await sidePanel.reload();
    expect(await appliedActivity(sidePanel)).toEqual(appliedEvents);
    expect(
      appliedMock.requests.filter((entry) => entry.pathname.endsWith('/applications')),
    ).toHaveLength(0);
  });

  test('browser restart pauses an in-flight run and can be resumed', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'handshook-restart-'));
    const job = makeJob(
      { id: '900001', title: 'Software Engineering Intern', employer: 'Northwind Labs' },
      1,
    );
    let first: Awaited<ReturnType<typeof launchExtension>> | undefined;
    try {
      first = await launchExtension({
        userDataDir,
        resetProfile: true,
        removeProfileOnClose: false,
      });
      const firstMock = await installHandshakeRoutes(first.context, 'quick-apply');
      const firstPanel = await openSidePanel(first.context, first.extensionId);
      await seedQuickApply(firstPanel, firstMock);
      await seedRecords(firstPanel, { job, queueItem: queuedJob(job) });
      await saveEngineState(firstPanel, {
        status: 'running',
        mode: 'autopilot',
        scanComplete: true,
        runId: 'run-restart',
        todayCount: 0,
      });
      // The persisted state is what survives the restart. Read it back without
      // waking the live engine (which keeps its own in-memory snapshot).
      const persisted = await firstPanel.evaluate(async () => {
        const key = 'handshook.engine.v1';
        return (await chrome.storage.local.get(key))[key] as { status?: string } | undefined;
      });
      expect(persisted?.status).toBe('running');
      await firstMock.dispose();
      await first.close({ removeProfile: false });
      first = undefined;

      const second = await launchExtension({
        userDataDir,
        resetProfile: false,
        removeProfileOnClose: false,
      });
      try {
        const secondMock = await installHandshakeRoutes(second.context, 'quick-apply');
        secondMock.setDocuments(SINGLE_RESUME);
        const secondPanel = await openSidePanel(second.context, second.extensionId);

        const paused = await waitFor(
          () => getState(secondPanel),
          (state) => state.pauseReason === 'browser_restarted',
          { description: 'restart pauses the persisted run', timeoutMs: 25_000 },
        );
        expect(paused.status).toBe('paused');
        expect(paused.message).toMatch(/restart/i);

        await resumeEngine(secondPanel);

        const resumed = await waitFor(
          () => getQueue(secondPanel),
          (queue) => (queue.summary.counts.applied ?? 0) >= 1,
          { description: 'resume after restart applies the queued job', timeoutMs: 45_000 },
        );
        expect(resumed.items.find((item) => item.jobId === job.id)?.status).toBe('applied');
        expect(
          secondMock.requests.filter(
            (entry) => entry.method === 'POST' && entry.pathname === `/jobs/${job.id}/applications`,
          ),
        ).toHaveLength(1);
        await secondMock.dispose();
      } finally {
        await second.close({ removeProfile: false });
      }
    } finally {
      if (first) await first.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

function queuedJob(job: Job): QueueItem {
  return {
    jobId: job.id,
    status: 'queued',
    priority: 90,
    attempts: 0,
    addedAt: Date.now() - 1_000,
    updatedAt: Date.now() - 500,
  };
}
