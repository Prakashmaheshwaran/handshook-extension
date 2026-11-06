/**
 * Review-mode E2E.
 *
 * Exercises the real side-panel screens, background runner, and content bridge
 * against the routed mock Handshake site. Assertions go through the extension, never
 * a stubbed bridge.
 */

import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { SAMPLE_JOBS } from '../../../src/test/mockData';
import {
  getQueue,
  getState,
  resumeEngine,
  runnerPage,
  seedExtension,
  startEngine,
  waitFor,
} from '../helpers/seed';

test.describe('review mode', () => {
  test('opens the side panel next to a routed search page', async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();

    await page.goto(mock.searchUrl());

    await expect(page.getByTestId('job-results').locator('article')).toHaveCount(10);
    await expect(sidePanel.locator('#root')).not.toBeEmpty();
    await expect(sidePanel.getByRole('heading').first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('redirects a protected page to login and returns after sign-in', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'login-redirect');
    const page = await context.newPage();

    await page.goto(mock.searchUrl());

    await expect(page.getByTestId('login-page')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(mock.isLoggedIn()).toBe(false);

    await page.getByTestId('sign-in').click();

    await expect(page.getByTestId('job-results').locator('article')).toHaveCount(10);
    expect(new URL(page.url()).pathname).toBe('/job-search');
    expect(mock.isLoggedIn()).toBe(true);
  });

  test('serves job detail JSON with apply type and required documents', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.jobUrl('900002'));

    const details = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }, mock.apiUrl('900002'));

    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      title: 'Data Analyst Intern',
      employer: { name: 'Contoso Analytics' },
      job_apply_setting: { apply_type: 'handshake_form' },
      required_job_document_types: ['resume', 'cover_letter'],
    });
    expect(typeof details.body.apply_start).toBe('string');
  });

  test('shows a sanitized document list with resumes, cover letter, and transcript', async ({
    context,
  }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();
    await page.goto(mock.documentsUrl());

    const items = page.locator('table tbody tr');
    await expect(items).toHaveCount(4);
    await expect(page.getByRole('columnheader')).toHaveText([
      'Name',
      'Type',
      'Employer Visibility',
      'Category',
      'Status',
      'Upload date',
    ]);
    await expect(page.getByRole('cell', { name: 'Resume', exact: true })).toHaveCount(2);
    await expect(page.getByRole('cell', { name: 'Cover Letter', exact: true })).toHaveCount(1);
    await expect(page.getByRole('cell', { name: 'Transcript', exact: true })).toHaveCount(1);
    await expect(items.locator('a[href^="/docs/"]')).toHaveCount(4);
  });

  test('shows onboarding or dashboard copy in the side panel', async ({ sidePanel }) => {
    await expect(sidePanel.locator('#root')).toContainText(
      /handshook setup|onboarding|dashboard|review-first/i,
    );
  });

  test('scans one page and queues ten jobs', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.total === 10,
      {
        description: 'ten jobs queued from one search page',
        timeoutMs: 30_000,
      },
    );

    const jobIds = queue.items.map((item) => item.jobId);
    expect(jobIds).toHaveLength(10);
    expect(new Set(jobIds).size).toBe(10);
    expect(queue.summary.counts.filtered ?? 0).toBe(0);
    expect(mock.pagesServed.some((served) => served.startsWith('/job-search'))).toBe(true);
  });

  test('fills a two-document application and stops before submit', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.counts.ready_for_review === 1,
      { description: 'one application filled and waiting for review', timeoutMs: 30_000 },
    );
    expect(queue.summary.counts.ready_for_review).toBe(1);

    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('apply-dialog')).toBeVisible();
    await expect(runner.getByTestId('document-resume')).toHaveValue('document-0001');
    await expect(runner.getByTestId('document-cover-letter')).toHaveValue('document-0003');
    await expect(runner.getByTestId('confirmation')).toHaveCount(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
  });

  test('opens a quick-apply review step, fills documents, and stops before submit', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply-review');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.counts.ready_for_review === 1,
      { description: 'quick apply opened a review step and stopped', timeoutMs: 30_000 },
    );
    expect(queue.summary.counts.ready_for_review).toBe(1);

    const runner = runnerPage(context, '900001');
    await expect(runner.getByTestId('apply-dialog')).toBeVisible();
    await expect(runner.getByTestId('document-resume')).toHaveValue('document-0001');
    await expect(runner.getByTestId('confirmation')).toHaveCount(0);
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
  });

  test('keeps the queue after a side-panel reload', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);
    await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.counts.ready_for_review === 1,
      { description: 'one application ready before reload' },
    );

    await sidePanel.reload();

    const state = await waitFor(
      () => getState(sidePanel),
      (value) => value.status === 'needs_user',
      {
        description: 'engine state restored as needs_user after reload',
        timeoutMs: 15_000,
      },
    );
    expect(state.status).toBe('needs_user');
    const queue = await getQueue(sidePanel);
    expect(queue.summary.total).toBeGreaterThan(0);
    expect(queue.summary.counts.ready_for_review).toBe(1);
    expect(queue.items.filter((item) => item.jobId === '900001')).toHaveLength(1);
  });

  test('pauses on login redirect and resumes after sign-in', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'login-redirect');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    const paused = await waitFor(
      () => getState(sidePanel),
      (state) => state.status === 'paused' && state.pauseReason === 'auth_required',
      { description: 'engine paused at auth_required', timeoutMs: 25_000 },
    );
    expect(paused.pauseReason).toBe('auth_required');
    expect(mock.isLoggedIn()).toBe(false);
    await expect(page.getByTestId('login-page')).toBeVisible();

    await page.getByTestId('sign-in').click();
    await expect(page.getByTestId('job-results').locator('article')).toHaveCount(10);

    await resumeEngine(sidePanel);
    const queue = await waitFor(
      () => getQueue(sidePanel),
      (value) => value.summary.total === 10,
      {
        description: 'scan resumed and queued ten jobs after sign-in',
        timeoutMs: 30_000,
      },
    );
    expect(queue.summary.total).toBe(10);
    expect(queue.summary.counts.queued ?? 0).toBeGreaterThan(0);
  });

  test('keeps external jobs hidden and uncounted in Review by default', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'external');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    await waitFor(
      () => getState(sidePanel),
      (value) => value.status === 'idle' && value.scanComplete === true,
      { description: 'external scan completed without an application', timeoutMs: 30_000 },
    );
    const queue = await getQueue(sidePanel);
    expect(queue.items).toEqual([]);
    expect(queue.jobs).toEqual([]);
    expect(queue.needs).toEqual([]);
    expect(queue.summary.total).toBe(0);
    expect(queue.summary.todayCount).toBe(0);
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    expect(mock.requests.filter((entry) => entry.pathname.endsWith('/applications'))).toHaveLength(
      0,
    );
    expect(
      context.pages().some((candidate) => candidate.url().includes('careers.example.com')),
    ).toBe(false);
  });
});
