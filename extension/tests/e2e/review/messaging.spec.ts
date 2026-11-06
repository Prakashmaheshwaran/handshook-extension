import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { SAMPLE_JOBS } from '../../../src/test/mockData';
import { PROTOCOL_VERSION } from '../../../src/core/contracts';
import {
  getQueue,
  getState,
  runnerPage,
  seedExtension,
  startEngine,
  waitFor,
} from '../helpers/seed';

test('a manual Review submission settles its journal and updates the panel count', async ({
  context,
  sidePanel,
  pageErrors,
}) => {
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  mock.setSearchJobs([SAMPLE_JOBS[0]!]);
  await seedExtension(sidePanel, { settings: { mode: 'review' } });
  await sidePanel.reload();
  await startEngine(sidePanel);
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.summary.counts.ready_for_review === 1,
    { description: 'application ready for manual review' },
  );
  const runner = runnerPage(context, '900001');
  await runner.getByTestId('submit-application').click();
  await expect(runner.getByTestId('confirmation')).toHaveText('Application submitted');
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.summary.counts.applied === 1,
    { description: 'manual submission accounted for' },
  );
  expect((await getState(sidePanel)).todayCount).toBe(1);
  const appliedEvents = await sidePanel.evaluate(async (protocolVersion) => {
    const response = await chrome.runtime.sendMessage({
      type: 'ui.events.list',
      requestId: 'manual-activity-proof',
      protocolVersion,
    });
    return (response.data as Array<{ type: string; jobId?: string }>).filter(
      (event) => event.type === 'job.applied',
    );
  }, PROTOCOL_VERSION);
  expect(appliedEvents).toEqual([expect.objectContaining({ jobId: '900001' })]);
  await expect(
    sidePanel.getByRole('progressbar', { name: 'Applications today versus the daily cap' }),
  ).toHaveAttribute('aria-valuenow', '1');
  const attempts = await sidePanel.evaluate(async () => {
    return new Promise<Array<{ status: string; capCountedAt?: number; reconciledAt?: number }>>(
      (resolve, reject) => {
        const open = indexedDB.open('handshook');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('submissions').objectStore('submissions').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        };
      },
    );
  });
  expect(attempts).toEqual([
    expect.objectContaining({
      status: 'applied',
      capCountedAt: expect.any(Number),
      reconciledAt: expect.any(Number),
    }),
  ]);
  await sidePanel.reload();
  expect((await getState(sidePanel)).todayCount).toBe(1);
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test('the existing panel receives pushes again after the service worker restarts', async ({
  context,
  sidePanel,
  extensionId,
  serviceWorker,
}) => {
  await installHandshakeRoutes(context, 'search-10-jobs');
  await seedExtension(sidePanel, { settings: { mode: 'review' } });
  await sidePanel.reload();
  // Chromium reuses its debugger target/Playwright Worker object across an MV3
  // restart. Prove the stopped lifecycle and loss of JS memory instead.
  const cdp = await context.newCDPSession(sidePanel);
  await cdp.send('ServiceWorker.enable');
  await serviceWorker.evaluate(() => {
    (self as unknown as { restartProbe?: boolean }).restartProbe = true;
  });
  const stopped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker did not stop')), 8_000);
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
  await cdp.send('ServiceWorker.stopAllWorkers');
  await stopped;
  const received = sidePanel.evaluate(
    async ({ protocolVersion, extensionId }) => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No push after worker restart')), 8000);
        const listener = (
          message: { type?: string; state?: { message?: string } },
          sender: chrome.runtime.MessageSender,
        ) => {
          if (sender.id === extensionId && message.type === 'state.changed') {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message.state?.message ?? '');
          }
        };
        chrome.runtime.onMessage.addListener(listener);
        void chrome.runtime
          .sendMessage({ type: 'ui.engine.stop', requestId: 'restart-stop', protocolVersion })
          .catch(reject);
      });
    },
    { protocolVersion: PROTOCOL_VERSION, extensionId },
  );
  await expect(received).resolves.toBe('Stopped');
  expect(
    await serviceWorker.evaluate(
      () => (self as unknown as { restartProbe?: boolean }).restartProbe,
    ),
  ).toBeUndefined();
  await cdp.detach();
});
