import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import {
  getQueue,
  listSubmissions,
  runnerPage,
  seedExtension,
  startEngine,
  waitFor,
} from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';

test('a transient missing-resume error reaches Needs you and Activity without a second submit', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'quick-apply-review');
  mock.setSearchJobs([SAMPLE_JOBS[0]!]);
  // This script runs only in intercepted fixture pages. It models Handshake
  // rejecting an attachment even though the picker displays a saved resume.
  await context.addInitScript(() => {
    if (location.hostname !== 'app.joinhandshake.com') return;
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest('[data-testid="submit-application"]'))
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        document.body.dataset.rejectedSubmits = String(
          Number(document.body.dataset.rejectedSubmits ?? 0) + 1,
        );
        const dialog = document.getElementById('apply-dialog');
        if (dialog) dialog.hidden = true;
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Documents must include a Resume';
        document.body.append(alert);
        setTimeout(() => alert.remove(), 500);
      },
      true,
    );
  });
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      documents: { defaultResumeId: 'document-0001', autoSelectResume: false },
      safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
    },
  });
  await startEngine(sidePanel);
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.items.some((item) => item.jobId === '900001' && item.status === 'needs_input'),
    { description: 'document rejection surfaced', timeoutMs: 30_000 },
  );
  const item = (await getQueue(sidePanel)).items.find((entry) => entry.jobId === '900001');
  expect(item).toMatchObject({
    missingDocumentTypes: ['resume'],
    lastError: { code: 'MISSING_DOCUMENT', message: 'documents must include a resume' },
  });
  const attempt = (await listSubmissions(sidePanel)).find((entry) => entry.jobId === '900001');
  expect(attempt).toMatchObject({ status: 'failed', error: { code: 'MISSING_DOCUMENT' } });
  const runner = runnerPage(context, '900001');
  expect(await runner.locator('body').getAttribute('data-rejected-submits')).toBe('1');
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);

  await sidePanel.reload();
  await sidePanel.getByRole('button', { name: /^Needs/ }).click();
  await expect(
    sidePanel.getByText('documents must include a resume', { exact: true }),
  ).toBeVisible();
  await sidePanel.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(
    sidePanel.getByText('Could not attach or verify: resume. See Needs you for details.', {
      exact: true,
    }),
  ).toBeVisible();
});
