import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, runnerPage, seedExtension, seedRecords, useMockPacing } from '../helpers/seed';
import { makeJob, makeQueueItem } from '../../../src/test/factories';

test('360px: onboarding and Settings accept pasted document links, then a per-job transcript choice reaches review', async ({
  context,
  sidePanel,
  pageErrors,
}) => {
  test.setTimeout(120_000);
  const mock = await installHandshakeRoutes(context, 'form-transcript');
  mock.setSearchJobs([
    makeJob({
      id: '900001',
      url: mock.jobUrl('900001'),
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'transcript'],
    }),
  ]);
  const handshake = await context.newPage();
  await handshake.goto(mock.searchUrl());
  await sidePanel.setViewportSize({ width: 360, height: 800 });
  await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
  const runnerPromise = context.waitForEvent('page');
  await sidePanel.getByRole('button', { name: 'Check session', exact: true }).click();
  const runner = await runnerPromise;
  await runner.reload({ waitUntil: 'domcontentloaded' });
  await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
  await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();

  // Documents: paste exactly what Handshake shows for a file.
  await sidePanel
    .getByLabel('Resume link or ID', { exact: true })
    .fill('https://app.joinhandshake.com/docs/document-0002');
  await expect(sidePanel.getByText('Saved as document ID document-0002')).toBeVisible();
  await expect(sidePanel.getByLabel('Transcript link or ID', { exact: true })).toHaveValue('');
  await sidePanel.screenshot({ path: 'test-results/ux-4-onboarding-360.png', fullPage: true });
  await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
  await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
  await sidePanel.getByLabel('Search name', { exact: true }).fill('Document selection fixture');
  await sidePanel.getByLabel('Search URL', { exact: true }).fill(mock.searchUrl());
  await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
  // This walkthrough is the Review opt-out: pick it explicitly before finishing.
  await sidePanel
    .getByRole('radio', { name: /^Review each application before it is submitted/ })
    .check();
  await sidePanel.getByRole('button', { name: 'Finish setup', exact: true }).click();

  const nav = sidePanel.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
    'document-0002',
  );
  await sidePanel.getByLabel('Resume link or ID', { exact: true }).fill('document-0001');
  await sidePanel.getByLabel('Transcript link or ID', { exact: true }).fill('document-0004');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sidePanel.getByText('Settings saved.', { exact: true })).toBeVisible();
  await sidePanel.getByLabel('Transcript link or ID', { exact: true }).fill('');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await sidePanel.reload();
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sidePanel.getByLabel('Transcript link or ID', { exact: true })).toHaveValue('');
  await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
    'document-0001',
  );
  await sidePanel.screenshot({ path: 'test-results/ux-4-settings-360.png', fullPage: true });
  await nav.getByRole('button', { name: 'Home', exact: true }).click();
  await useMockPacing(sidePanel);
  await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).needs[0]?.missingDocumentTypes, {
      timeout: 30_000,
    })
    .toContain('transcript');
  await nav.getByRole('button', { name: /^Needs/ }).click();
  // document-0002 is no longer a saved resume, so enter it for this job only.
  await sidePanel
    .getByLabel('Resume for this job', { exact: true })
    .selectOption({ label: 'Another resume (enter ID)' });
  await sidePanel
    .getByLabel('Resume link or ID', { exact: true })
    .fill('https://app.joinhandshake.com/docs/document-0002');
  await sidePanel.getByLabel('Transcript', { exact: true }).fill('document-0004');
  await sidePanel.screenshot({ path: 'test-results/ux-4-needs-360.png', fullPage: true });
  expect(
    await sidePanel.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth),
  ).toBeLessThanOrEqual(1);
  await sidePanel.getByRole('button', { name: 'Save documents & continue', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
      timeout: 30_000,
    })
    .toBe(1);
  const application = runnerPage(context, '900001');
  await expect(application.getByTestId('document-resume')).toHaveValue('document-0002');
  await expect(application.getByTestId('document-transcript')).toHaveValue('document-0004');
  expect((await getQueue(sidePanel)).items[0]?.documentSelection).toMatchObject({
    resumeId: 'document-0002',
    transcriptId: 'document-0004',
  });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
    'document-0001',
  );
  await expect(sidePanel.getByLabel('Transcript link or ID', { exact: true })).toHaveValue('');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test('360px: Queue details save a job-specific resume and none without changing defaults', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  await seedExtension(sidePanel);
  const job = makeJob({ id: '900001', url: mock.jobUrl('900001') });
  await seedRecords(sidePanel, {
    job,
    queueItem: makeQueueItem({ jobId: job.id, status: 'queued' }),
  });
  await sidePanel.setViewportSize({ width: 360, height: 800 });
  await sidePanel.reload();
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  await sidePanel.getByText('Documents for this job', { exact: true }).click();
  await sidePanel.getByLabel('Resume for this job', { exact: true }).selectOption('document-0002');
  await sidePanel.getByLabel('Cover letter', { exact: true }).fill('');
  await sidePanel.getByRole('button', { name: 'Save for this job', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).items[0]?.documentSelection)
    .toMatchObject({ resumeId: 'document-0002', coverLetterId: '' });
  await sidePanel.reload();
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  await sidePanel.getByText('Documents for this job', { exact: true }).click();
  await expect(sidePanel.getByLabel('Resume for this job', { exact: true })).toHaveValue(
    'document-0002',
  );
  await expect(sidePanel.getByLabel('Cover letter', { exact: true })).toHaveValue('');
  await sidePanel.screenshot({ path: 'test-results/ux-4-queue-360.png', fullPage: true });
  expect(
    await sidePanel.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth),
  ).toBeLessThanOrEqual(1);
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
    'document-0001',
  );
  await expect(sidePanel.getByLabel('Cover letter link or ID', { exact: true })).toHaveValue(
    'document-0003',
  );
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
});
