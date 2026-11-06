import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import {
  getQueue,
  seedExtension,
  seedRecords,
  sendUi,
  startEngine,
  waitForState,
} from '../helpers/seed';
import type { QueuePayload } from '../../../src/core/contracts';
import { makeJob, makeQueueItem } from '../../../src/test/factories';

for (const width of [320, 400, 500]) {
  test(`external beta links stay separate, uncounted and dismissible at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }, testInfo) => {
    const mock = await installHandshakeRoutes(context, 'external');
    await seedExtension(sidePanel, { settings: { search: { collectExternalJobs: true } } });
    // Reproduce an older stored row that was incorrectly presented as Needs You.
    const job = makeJob({
      title: 'Employer-site design role',
      employer: 'Example employer',
      applyType: 'external',
      externalUrl: 'https://careers.example.test/apply',
    });
    await seedRecords(sidePanel, { job, queueItem: makeQueueItem({ status: 'needs_input' }) });
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    const queue = await getQueue(sidePanel);
    expect(queue.summary.total).toBe(0);
    expect(queue.summary.todayCount).toBe(0);
    expect(queue.needs).toEqual([]);
    await sidePanel
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Queue', exact: true })
      .click();
    await expect(sidePanel.getByText(job.title, { exact: true })).toHaveCount(0);
    await sidePanel.getByLabel('Filter queue', { exact: true }).selectOption('external');
    await expect(sidePanel.getByText(job.title, { exact: true })).toBeVisible();
    const link = sidePanel.getByRole('link', { name: /Open on employer site/ });
    await expect(link).toHaveAttribute('href', job.externalUrl ?? '');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(sidePanel.getByRole('button', { name: /^(Apply now|Retry|Skip)$/ })).toHaveCount(
      0,
    );
    expect(
      await sidePanel.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await sidePanel.screenshot({ path: testInfo.outputPath('external-beta.png') });
    await sidePanel.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(sidePanel.getByText(job.title, { exact: true })).toHaveCount(0);
    await sidePanel.reload();
    expect((await getQueue(sidePanel)).items).toEqual([]);
    expect(mock.requests.filter((request) => request.method === 'POST')).toEqual([]);
    expect(pageErrors).toEqual([]);
    await mock.dispose();
  });
}

test('collects a detail-time employer link only with beta enabled and never follows it', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'external');
  mock.setSearchJobs([makeJob({ applyType: 'unknown', title: 'Detail-only external role' })]);
  await seedExtension(sidePanel, {
    settings: { mode: 'autopilot', search: { collectExternalJobs: true } },
  });
  await startEngine(sidePanel);
  // Autopilot keeps rescanning when nothing eligible is left, so wait for the
  // completed scan rather than for the run to go idle.
  const { state } = await waitForState(sidePanel, (current) => current.scanComplete === true);
  expect(state.scanComplete).toBe(true);
  const externalQueue = () =>
    sendUi<QueuePayload>(sidePanel, {
      type: 'ui.queue.list',
      requestId: 'external-beta-list',
      status: ['external'],
    });
  await expect.poll(async () => (await externalQueue()).items.length).toBe(1);
  const queue = await externalQueue();
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0]?.status).toBe('external');
  expect(queue.jobs[0]?.externalUrl).toContain('https://careers.example.com/apply');
  expect(queue.summary.total).toBe(0);
  expect(queue.summary.todayCount).toBe(0);
  expect(queue.needs).toEqual([]);
  expect(mock.requests.filter((request) => request.method === 'POST')).toEqual([]);
  expect(context.pages().some((page) => page.url().startsWith('https://careers.'))).toBe(false);
  await mock.dispose();
});
