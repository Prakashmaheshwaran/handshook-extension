/**
 * Safety-review regressions that depend on real submit behavior.
 *
 * Headless only (the harness default). Every Handshake request is intercepted
 * and DNS-pinned; nothing reaches the live site.
 */

import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { SAMPLE_JOBS } from '../../../src/test/mockData';
import {
  getQueue,
  getState,
  runnerPage,
  seedExtension,
  seedRecords,
  sendUi,
  startEngine,
  waitFor,
} from '../helpers/seed';

const JOB = SAMPLE_JOBS[0]!;

test.describe('safety review regressions', () => {
  test('HX-01 — switching to Review during fill revokes submit and manual review still completes', async ({
    context,
    sidePanel,
  }) => {
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    mock.setSearchJobs([JOB]);
    // Hold the fixture's resume options until the test releases them. This
    // gives a deterministic filling checkpoint without changing production code.
    await context.addInitScript(() => {
      if (!/^\/jobs\//.test(location.pathname)) return;
      const held: HTMLOptionElement[] = [];
      const observer = new MutationObserver(() => {
        for (const option of document.querySelectorAll<HTMLOptionElement>(
          'select[data-document-type="resume"] option',
        )) {
          if (option.value) {
            held.push(option);
            option.remove();
          }
        }
      });
      observer.observe(document, { subtree: true, childList: true });
      document.addEventListener(
        'handshook-test-release-fill',
        () => {
          observer.disconnect();
          document.querySelector('select[data-document-type="resume"]')?.append(...held);
        },
        { once: true },
      );
    });
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);
    await waitFor(
      () => getState(sidePanel),
      (state) => state.currentPhase === 'filling',
      {
        description: 'application is filling before switching mode',
        timeoutMs: 30_000,
      },
    );
    await sendUi(sidePanel, {
      type: 'ui.settings.update',
      requestId: 'review-during-fill',
      patch: { mode: 'review' },
    });
    const runner = runnerPage(context, JOB.id);
    await runner.evaluate(() => document.dispatchEvent(new Event('handshook-test-release-fill')));
    await waitFor(
      () => getQueue(sidePanel),
      (queue) =>
        queue.items.some((item) => item.jobId === JOB.id && item.status === 'ready_for_review'),
      {
        description: 'filled application needs review',
        timeoutMs: 30_000,
      },
    );
    await expect(runner.getByRole('dialog')).toBeVisible();
    await expect(runner.getByTestId('document-resume')).not.toHaveValue('');
    await expect(runner.getByTestId('document-cover-letter')).not.toHaveValue('');
    expect(mock.requestsFor(`/jobs/${JOB.id}/applications`)).toHaveLength(0);
    // The review watcher must still recognize the user's own final click.
    await runner.getByRole('button', { name: 'Submit Application', exact: true }).click();
    await waitFor(
      () => getQueue(sidePanel),
      (queue) => queue.items.some((item) => item.jobId === JOB.id && item.status === 'applied'),
      {
        description: 'manual Review submit is confirmed',
        timeoutMs: 15_000,
      },
    );
    expect(mock.requestsFor(`/jobs/${JOB.id}/applications`)).toHaveLength(1);
    await mock.dispose();
  });

  test('H1 — stopping during fill never submits', async ({ context, sidePanel }) => {
    test.setTimeout(120_000);
    const mock = await installHandshakeRoutes(context, 'slow-modal');
    mock.setSearchJobs([JOB]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    // The content adapter announces `filling` before it starts the slow modal
    // and document selection; stop while it is still filling.
    await waitFor(
      () => getState(sidePanel),
      (state) => state.currentPhase === 'filling',
      { description: 'engine reached the filling phase', timeoutMs: 30_000 },
    );

    await sendUi(sidePanel, { type: 'ui.engine.stop', requestId: 'stop-during-fill' });

    // Give the aborted adapter time to finish unwinding.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(mock.requestsFor(`/jobs/${JOB.id}/applications`)).toHaveLength(0);
    const queue = await getQueue(sidePanel);
    const item = queue.items.find((entry) => entry.jobId === JOB.id);
    expect(item?.status).not.toBe('applied');
    expect((await getState(sidePanel)).status).toBe('idle');
    await mock.dispose();
  });

  test('H2 — a lost apply channel is never retried or re-sent', async ({ context, sidePanel }) => {
    test.setTimeout(120_000);
    const mock = await installHandshakeRoutes(context, 'slow-modal');
    mock.setSearchJobs([JOB]);
    const page = await context.newPage();
    await page.goto(mock.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'autopilot' } });
    await startEngine(sidePanel);

    await waitFor(
      () => getState(sidePanel),
      (state) => state.currentPhase === 'filling',
      { description: 'engine reached the filling phase', timeoutMs: 30_000 },
    );

    // Simulate a lost content channel mid-apply (the response can no longer
    // reach the worker). The engine must verify, never silently retry.
    const runner = runnerPage(context, JOB.id);
    await runner.close();

    await waitFor(
      () => getQueue(sidePanel),
      (queue) => {
        const item = queue.items.find((entry) => entry.jobId === JOB.id);
        return item?.status === 'verifying' || item?.status === 'needs_input';
      },
      { description: 'apply became uncertain and stopped', timeoutMs: 30_000 },
    );

    const postsAfterLoss = mock.requestsFor(`/jobs/${JOB.id}/applications`).length;
    expect(postsAfterLoss).toBeLessThanOrEqual(1);

    await sidePanel.reload();
    await sidePanel
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /^Needs/ })
      .click();
    await expect(
      sidePanel.getByText(/This application may already have been submitted/),
    ).toBeVisible();
    await expect(sidePanel.getByText(/do not submit it again/)).toBeVisible();
    await expect(sidePanel.getByText(/application is filled and waiting/)).toHaveCount(0);

    // Resuming reconciles; it must not send the application again.
    await sendUi(sidePanel, { type: 'ui.engine.resume', requestId: 'resume-after-loss' });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(mock.requestsFor(`/jobs/${JOB.id}/applications`).length).toBe(postsAfterLoss);
    await mock.dispose();
  });

  test('H4 — applied rows cannot be retried, skipped, or applied again', async ({ sidePanel }) => {
    await seedExtension(sidePanel, {});
    await seedRecords(sidePanel, {
      job: JOB,
      queueItem: {
        jobId: JOB.id,
        status: 'applied',
        priority: 50,
        attempts: 1,
        addedAt: 1,
        updatedAt: 2,
      },
    });

    await expect(
      sendUi(sidePanel, { type: 'ui.queue.retry', requestId: 'retry-final', jobId: JOB.id }),
    ).rejects.toThrow(/final and cannot be retried/i);
    await expect(
      sendUi(sidePanel, {
        type: 'ui.queue.skip',
        requestId: 'skip-final',
        jobId: JOB.id,
        reason: 'nope',
      }),
    ).rejects.toThrow(/final and cannot be skipped/i);
    await expect(
      sendUi(sidePanel, { type: 'ui.queue.applyNow', requestId: 'apply-final', jobId: JOB.id }),
    ).rejects.toThrow(/final and cannot be applied/i);

    const queue = await getQueue(sidePanel);
    expect(queue.items.find((entry) => entry.jobId === JOB.id)?.status).toBe('applied');
  });
});
