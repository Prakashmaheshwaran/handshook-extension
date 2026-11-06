import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { SAMPLE_ANSWERS, SAMPLE_DOCUMENTS } from '../../../src/test/mockData';
import { PROTOCOL_VERSION } from '../../../src/core/contracts';
import {
  getQueue,
  getState,
  runnerPage,
  seedExtension,
  startEngine,
  waitForState,
} from '../helpers/seed';

test.describe('engine flows', () => {
  test('review mode scans, fills a two-document form, and stops before submit', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);

    const { state, queue } = await waitForState(
      sidePanel,
      (current) => current.status === 'needs_user',
    );
    expect(state.message).toMatch(/review/i);
    expect(queue.summary.counts.ready_for_review).toBe(1);
    expect(queue.summary.counts.queued).toBeGreaterThan(0);
    expect(queue.needs[0]?.reason).toBe('review');

    const runner = runnerPage(context);
    await expect(runner.getByTestId('apply-dialog')).toBeVisible();
    await expect(runner.getByTestId('confirmation')).toHaveCount(0);
    await mock.dispose();
  });

  test('review mode marks applied when the user submits in the runner tab', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);
    await waitForState(sidePanel, (state) => state.status === 'needs_user');

    const runner = runnerPage(context);
    await runner.getByTestId('submit-application').click();
    const { state, queue } = await waitForState(
      sidePanel,
      (current) => current.todayCount >= 1,
      15_000,
    );
    expect(state.todayCount).toBe(1);
    expect(queue.summary.counts.applied).toBe(1);
    expect(queue.items.find((item) => item.jobId === '900001')?.status).toBe('applied');
    await mock.dispose();
  });

  test('autopilot submits a safe quick apply', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    const documents = SAMPLE_DOCUMENTS.filter((document) => document.id === 'document-0001');
    mock.setDocuments(documents);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: {
        mode: 'autopilot',
        documents: { autoSelectResume: false, coverLetterId: undefined, transcriptId: undefined },
        safety: { allowOneClickApply: true },
      },
    });
    await startEngine(sidePanel);

    const { state, queue } = await waitForState(
      sidePanel,
      (current, currentQueue) =>
        current.todayCount >= 1 || currentQueue.summary.counts.applied === 1,
      20_000,
    );
    expect(state.todayCount).toBeGreaterThanOrEqual(1);
    expect(queue.items.find((item) => item.jobId === '900001')?.status).toBe('applied');
    await mock.dispose();
  });

  test('autopilot submits a two-document form', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    // The cap reservation increments today's count just before the queue row
    // is written as applied, so wait for both rather than reading a snapshot
    // taken in between.
    const { queue } = await waitForState(
      sidePanel,
      (current, currentQueue) =>
        current.todayCount >= 1 && currentQueue.summary.counts.applied === 1,
      20_000,
    );
    const applied = queue.items.find((item) => item.jobId === '900001');
    expect(applied?.status).toBe('applied');
    await mock.dispose();
  });

  test('autopilot parks jobs on an unknown required question and applies after an answer', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-questions');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: { mode: 'autopilot', safety: { allowFreeTextAutoFill: false } },
      answers: SAMPLE_ANSWERS.map((answer) => ({ ...answer, autoSubmitAllowed: true })),
    });
    await startEngine(sidePanel);

    const { queue } = await waitForState(
      sidePanel,
      (_current, currentQueue) => currentQueue.needs.length > 1,
      35_000,
    );
    // The run did not stop at the first waiting job.
    expect(queue.needs.length).toBeGreaterThan(1);
    const question = queue.needs[0]?.questions[0];
    expect(question?.label).toMatch(/why are you interested/i);
    expect(queue.summary.counts.applied ?? 0).toBe(0);

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
          remember: true,
        });
      },
      { jobId: queue.needs[0]!.jobId, questionId: question!.id, protocolVersion: PROTOCOL_VERSION },
    );

    const answeredJob = queue.needs[0]!.jobId;
    const { queue: after } = await waitForState(
      sidePanel,
      (_current, currentQueue) =>
        currentQueue.items.find((item) => item.jobId === answeredJob)?.status === 'applied',
      60_000,
    );
    expect(after.items.find((item) => item.jobId === answeredJob)?.status).toBe('applied');
    // Remembering the answer released every other job waiting on the same question.
    expect(after.needs.filter((need) => need.reason === 'questions')).toEqual([]);
    await mock.dispose();
  });

  test('autopilot pauses when a required document is missing', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      // Only a resume is configured; the form also requires a cover letter.
      settings: {
        mode: 'autopilot',
        documents: { coverLetterId: '', transcriptId: '', otherDocumentId: '' },
      },
    });
    await startEngine(sidePanel);

    const { queue } = await waitForState(
      sidePanel,
      (current, currentQueue) => current.status === 'needs_user' && currentQueue.needs.length > 0,
      35_000,
    );
    expect(queue.needs[0]?.missingDocumentTypes).toContain('cover_letter');
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    await mock.dispose();
  });

  test('external postings discovered at detail time are hidden and uncounted by default', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'external');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    const { queue } = await waitForState(
      sidePanel,
      (current) => current.status === 'idle' && current.scanComplete === true,
      35_000,
    );
    expect(queue.items).toEqual([]);
    expect(queue.jobs).toEqual([]);
    expect(queue.needs).toEqual([]);
    expect(queue.summary.total).toBe(0);
    expect(queue.summary.todayCount).toBe(0);
    expect(queue.summary.counts.applied ?? 0).toBe(0);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    await mock.dispose();
  });

  test('daily cap stops before a second application', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'quick-apply');
    const documents = SAMPLE_DOCUMENTS.filter((document) => document.id === 'document-0001');
    mock.setDocuments(documents);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, {
      settings: {
        mode: 'autopilot',
        documents: { autoSelectResume: false, coverLetterId: undefined, transcriptId: undefined },
        safety: { allowOneClickApply: true },
        pacing: { dailyCap: 1, hardCap: 100, minDelayMs: 10_000, maxDelayMs: 10_000 },
      },
    });
    await startEngine(sidePanel);
    await waitForState(sidePanel, (current) => current.todayCount >= 1, 20_000);
    const { state, queue } = await waitForState(
      sidePanel,
      (current) =>
        current.status === 'idle' && (current.message ?? '').includes('Daily cap reached'),
      20_000,
    );
    expect(state.pauseReason).toBeUndefined();
    expect(queue.summary.counts.applied).toBe(1);
    await mock.dispose();
  });

  test('queue survives a side panel reload', async ({ context, sidePanel }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await startEngine(sidePanel);
    await waitForState(sidePanel, (state) => state.status === 'needs_user');
    await sidePanel.reload();
    // Reads go through the background, so they are valid as soon as the reload
    // completes; no fixed settle delay is needed.
    const queue = await getQueue(sidePanel);
    expect(queue.summary.total).toBeGreaterThan(0);
    expect(queue.summary.counts.ready_for_review).toBe(1);
    const state = await getState(sidePanel);
    expect(state.status).toBe('needs_user');
    await mock.dispose();
  });
});

test('autopilot pauses rather than submitting an unapproved sensitive answer', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'form-questions');
  const page = await context.newPage();
  await page.goto(mock.searchUrl());
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      safety: { allowSensitiveAutoSubmit: false, allowFreeTextAutoFill: true },
    },
  });
  await startEngine(sidePanel);
  const { queue } = await waitForState(
    sidePanel,
    (current, currentQueue) => current.status === 'needs_user' && currentQueue.needs.length > 0,
    20_000,
  );
  expect(
    queue.needs[0]?.questions.some((question) => /authorized|sponsorship/i.test(question.label)),
  ).toBe(true);
  expect(queue.summary.counts.applied ?? 0).toBe(0);
  await mock.dispose();
});

test('rate limits pause the run instead of retrying in a loop', async ({ context, sidePanel }) => {
  const mock = await installHandshakeRoutes(context, 'rate-limited');
  const documents = SAMPLE_DOCUMENTS.filter((document) => document.id === 'document-0001');
  mock.setDocuments(documents);
  const page = await context.newPage();
  await page.goto(mock.searchUrl());
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      documents: { autoSelectResume: false, coverLetterId: undefined, transcriptId: undefined },
    },
  });
  await startEngine(sidePanel);
  const { state } = await waitForState(
    sidePanel,
    (current) => current.pauseReason === 'rate_limited',
    20_000,
  );
  expect(state.pauseReason).toBe('rate_limited');
  await mock.dispose();
});
