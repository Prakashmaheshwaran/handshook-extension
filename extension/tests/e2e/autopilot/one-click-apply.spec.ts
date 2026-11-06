import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import {
  getQueue,
  getState,
  listSubmissions,
  resumeEngine,
  runnerPage,
  seedExtension,
  startEngine,
  waitFor,
} from '../helpers/seed';
import { SAMPLE_DOCUMENTS, SAMPLE_JOBS } from '../../../src/test/mockData';
import type { Settings } from '../../../src/core/contracts';
import {
  ONE_CLICK_APPLY_REVIEW_REASON,
  ONE_CLICK_APPLY_LABEL,
  ONE_CLICK_APPLY_HELP,
} from '../../../src/core/documents/selection';

test.describe('live-shaped Handshake one-click Apply', () => {
  test('Resume without a saved run identity authorizes the same persisted attempt', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'one-click-apply');
    mock.setSearchJobs([SAMPLE_JOBS[0]!]);
    await seedExtension(sidePanel, {
      settings: {
        mode: 'autopilot',
        documents: {
          defaultResumeId: 'document-0002',
          coverLetterId: '',
          transcriptId: '',
          otherDocumentId: '',
          autoSelectResume: false,
        },
        safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
      },
    });
    expect((await getState(sidePanel)).runId).toBeUndefined();
    await resumeEngine(sidePanel);
    await waitFor(
      () => getQueue(sidePanel),
      (queue) =>
        queue.items.some(
          (item) =>
            item.jobId === '900001' && ['applied', 'ready_for_review'].includes(item.status),
        ),
      { description: 'resumed one-click result', timeoutMs: 30_000 },
    );
    expect((await getQueue(sidePanel)).items.find((item) => item.jobId === '900001')?.status).toBe(
      'applied',
    );
    const state = await getState(sidePanel);
    const attempts = await listSubmissions(sidePanel);
    expect(state.runId).toBeTruthy();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ runId: state.runId, status: 'applied' });
    expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
  });

  test('Autopilot setup saves an informed opt-in without starting a run at 320px', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'one-click-apply');
    await sidePanel.setViewportSize({ width: 320, height: 900 });
    await seedExtension(sidePanel);
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Run setup again', exact: true }).click();
    for (let step = 0; step < 5; step += 1)
      await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await sidePanel.getByRole('radio', { name: /^Handshook applies for you/ }).check();
    // One-click consent is on by default now; the checklist still shows the
    // exact consequence (profile defaults, cannot be changed) before Finish.
    const consent = sidePanel.getByRole('checkbox', { name: ONE_CLICK_APPLY_LABEL, exact: false });
    await expect(consent).toBeChecked();
    await expect(sidePanel.getByText(ONE_CLICK_APPLY_HELP, { exact: true })).toBeVisible();
    // It remains an informed opt-out, and the saved state follows the choice made.
    await consent.uncheck();
    await expect(consent).not.toBeChecked();
    await consent.check();
    // The carried-over Review gate is its own opt-in; this user turns it off so
    // the setup they save is fully automatic.
    const reviewGate = sidePanel.getByRole('switch', {
      name: 'Review each application before it is submitted',
      exact: true,
    });
    await reviewGate.click();
    await expect(reviewGate).toHaveAttribute('aria-checked', 'false');
    await sidePanel.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await expect(sidePanel.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    const settings = await sidePanel.evaluate(
      async () =>
        (await chrome.storage.local.get('handshook.settings.v1'))[
          'handshook.settings.v1'
        ] as Settings,
    );
    expect(settings.mode).toBe('autopilot');
    expect(settings.safety.allowOneClickApply).toBe(true);
    expect(settings.safety.reviewBeforeSubmit).toBe(false);
    expect((await getState(sidePanel)).status).toBe('idle');
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(
      await sidePanel.locator('main').evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
  });

  for (const { mode, optIn, applied } of [
    { mode: 'review', optIn: true, applied: false },
    { mode: 'autopilot', optIn: false, applied: false },
    { mode: 'autopilot', optIn: true, applied: true },
  ] as const) {
    test(`${mode} with opt-in ${optIn ? 'on' : 'off'} ${applied ? 'submits once with banner evidence' : 'hands off without clicking'}`, async ({
      context,
      sidePanel,
    }) => {
      const mock = await installHandshakeRoutes(context, 'one-click-apply');
      mock.setSearchJobs([SAMPLE_JOBS[0]!]);
      // Multiple resumes deliberately differ from the Handshook choice. Consent
      // accepts profile defaults; the record must not claim a verified file ID.
      mock.setDocuments(SAMPLE_DOCUMENTS);
      await seedExtension(sidePanel, {
        settings: {
          mode,
          documents: {
            defaultResumeId: 'document-0002',
            coverLetterId: '',
            transcriptId: '',
            otherDocumentId: '',
            autoSelectResume: false,
          },
          safety: { reviewBeforeSubmit: false, allowOneClickApply: optIn },
        },
      });
      await startEngine(sidePanel);
      await waitFor(
        () => getQueue(sidePanel),
        (queue) =>
          queue.items.find((item) => item.jobId === '900001')?.status ===
          (applied ? 'applied' : 'ready_for_review'),
        { description: 'one-click policy result', timeoutMs: 30_000 },
      );
      const runner = runnerPage(context, '900001');
      await expect(runner.getByTestId('apply-button')).toHaveText('Apply');
      await expect(runner.getByTestId('apply-button')).not.toHaveAttribute('aria-haspopup');
      const attempts = (await listSubmissions(sidePanel)).filter(
        (attempt) => attempt.jobId === '900001',
      );
      expect(attempts).toHaveLength(1);
      if (applied) {
        await expect(runner.getByTestId('live-applied-banner')).toContainText(
          'Applied on October 27, 2026',
        );
        await expect(runner.getByRole('button', { name: 'Withdraw application' })).toBeVisible();
        await expect(runner.getByTestId('apply-button')).toBeDisabled();
        await expect(runner.getByTestId('apply-button')).toHaveAttribute('aria-disabled', 'true');
        expect(attempts[0]).toMatchObject({
          status: 'applied',
          documents: 'handshake_profile_defaults',
          confirmationText: expect.stringMatching(/^applied on /i),
        });
        expect((await getState(sidePanel)).todayCount).toBe(1);
        expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
        await sidePanel.reload();
        expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
      } else {
        expect(attempts[0]?.documents).toEqual([]);
        expect((await getState(sidePanel)).message).toBe(ONE_CLICK_APPLY_REVIEW_REASON);
        expect((await getState(sidePanel)).todayCount).toBe(0);
        expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
        await sidePanel.reload();
        const card = sidePanel.locator('div.rounded-panel').filter({
          has: sidePanel.getByRole('heading', {
            name: '1 application is ready for you to submit on Handshake',
            exact: true,
          }),
        });
        await expect(
          sidePanel.getByRole('heading', {
            name: '1 application is ready for you to submit on Handshake',
            exact: true,
          }),
        ).toBeVisible();
        await expect(card.getByText(ONE_CLICK_APPLY_REVIEW_REASON, { exact: true })).toBeVisible();
        await sidePanel.getByRole('button', { name: 'Open job', exact: true }).click();
        expect(runner.url()).toBe(mock.jobUrl('900001'));
        await expect(runner.getByTestId('apply-button')).toBeEnabled();
        expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
      }
    });
  }

  test('Safety exposes informed opt-in as a default-on checkbox that persists', async ({
    context,
    sidePanel,
  }) => {
    await installHandshakeRoutes(context, 'one-click-apply');
    await seedExtension(sidePanel);
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    const checkbox = sidePanel.getByRole('checkbox', { name: ONE_CLICK_APPLY_LABEL, exact: false });
    // Full automation is the default, so consent starts on with its explanation.
    await expect(checkbox).toBeChecked();
    await expect(sidePanel.getByText(ONE_CLICK_APPLY_HELP, { exact: true })).toBeVisible();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sidePanel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      sidePanel.getByRole('checkbox', { name: ONE_CLICK_APPLY_LABEL, exact: false }),
    ).not.toBeChecked();
  });
});
