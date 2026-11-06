import {
  expect,
  test as base,
  launchExtension,
  sidePanelUrl,
  EXTENSION_BUILD_PATH,
  waitForServiceWorker,
} from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import {
  getQueue,
  getState,
  listSubmissions,
  runnerPage,
  seedExtension,
  startEngine,
  waitFor,
} from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const launched = await launchExtension({ enableExtensionDebugging: true });
    try {
      await use(launched.context);
    } finally {
      await launched.close();
    }
  },
});

test('extension reload preserves an unfinished Review and explains how to continue safely', async ({
  context,
  sidePanel,
  extensionId,
  serviceWorker,
}) => {
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  mock.setSearchJobs([SAMPLE_JOBS[0]!]);
  await seedExtension(sidePanel, { settings: { mode: 'review' } });
  await startEngine(sidePanel);
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.summary.counts.ready_for_review === 1,
    { description: 'Review handoff before extension reload' },
  );
  const runner = runnerPage(context, '900001');
  const loads = mock.pagesServed.filter((path) => path === '/jobs/900001').length;

  // Reinstall the same unpacked path through Chromium's extension API, as an
  // unpacked update does. This invalidates old extension/content contexts.
  const cdp = await context.newCDPSession(runner);
  await cdp.send('ServiceWorker.enable');
  const stopped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Extension worker did not stop')), 8_000);
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      if (
        versions.some(
          (version) =>
            version.scriptURL === serviceWorker.url() && version.runningStatus === 'stopped',
        )
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await serviceWorker.evaluate(() => {
    (self as unknown as { rcReloadProbe?: boolean }).rcReloadProbe = true;
  });
  const browser = context.browser();
  if (!browser) throw new Error('Chromium browser session is unavailable');
  const browserCdp = await browser.newBrowserCDPSession();
  const installed = await browserCdp.send('Extensions.loadUnpacked', {
    path: EXTENSION_BUILD_PATH,
  });
  expect(installed.id).toBe(extensionId);
  await stopped;
  await browserCdp.detach();
  const panel = await context.newPage();
  // Extension resources are briefly blocked between unload and re-register.
  await expect(async () => {
    await panel.goto(sidePanelUrl(extensionId), { waitUntil: 'domcontentloaded' });
  }).toPass({ timeout: 15_000 });
  await expect(panel.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const restartedWorker = await waitForServiceWorker(context);
  // Verify a new JavaScript generation as well as the stopped lifecycle.
  expect(
    await restartedWorker.evaluate(
      () => (self as unknown as { rcReloadProbe?: boolean }).rcReloadProbe,
    ),
  ).toBeUndefined();
  await cdp.detach();
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(
    'finish or skip the pending application in Needs you',
  );
  expect(runner.url()).toBe(mock.jobUrl('900001'));
  expect(mock.pagesServed.filter((path) => path === '/jobs/900001')).toHaveLength(loads);
  await expect(runner.getByTestId('apply-dialog')).toBeVisible();
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);

  await panel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Needs/ })
    .click();
  await expect(panel.getByText(/If you already submitted, or the tab was reloaded/)).toBeVisible();
  await panel.getByRole('button', { name: 'Skip job', exact: true }).click();
  await panel.getByRole('dialog').getByRole('button', { name: 'Skip job', exact: true }).click();
  await waitFor(
    () => getQueue(panel),
    (queue) => queue.items[0]?.status === 'skipped',
    { description: 'explicit skip clears the unfinished Review' },
  );
  await panel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await waitFor(
    () => getState(panel),
    (state) => state.status === 'idle',
    { description: 'run can continue after explicit skip' },
  );
  expect((await listSubmissions(panel))[0]?.status).toBe('ambiguous');
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(0);
});
