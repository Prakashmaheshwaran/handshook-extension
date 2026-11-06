import { test as packaged, expect } from '../helpers/packaged-extension';
import { launchExtension, sidePanelUrl } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, listSubmissions, seedExtension, startEngine, waitFor } from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';

const test = packaged.extend({
  context: async ({ packagedExtensionPath }, use) => {
    // Uninstall/reinstall only inside the disposable fixture profile. The ZIP
    // is rebuilt and checksum-verified by the packaged-extension fixture.
    const launched = await launchExtension({
      extensionPath: packagedExtensionPath,
      enableExtensionDebugging: true,
    });
    try {
      // Command-line startup extensions have a different install location and
      // Chromium refuses to uninstall them. Register through Load unpacked
      // first, matching the user's installation instead of testing a reload.
      const browser = launched.context.browser();
      if (!browser) throw new Error('Chromium browser session is unavailable');
      const cdp = await browser.newBrowserCDPSession();
      const restarted = launched.context.waitForEvent('serviceworker', {
        timeout: 15_000,
        predicate: (worker) => worker.url() === launched.serviceWorker.url(),
      });
      await cdp.send('Extensions.loadUnpacked', { path: packagedExtensionPath });
      await restarted;
      await cdp.detach();
      await use(launched.context);
    } finally {
      await launched.close();
    }
  },
});

test('the packaged no-documents fix survives repeated removal and fresh setup', async ({
  context,
  sidePanel,
  extensionId,
  packagedExtensionPath,
}) => {
  const mock = await installHandshakeRoutes(context, 'no-additional-documents');
  const browser = context.browser();
  if (!browser) throw new Error('Chromium browser session is unavailable');
  const cdp = await browser.newBrowserCDPSession();
  let panel = sidePanel;

  try {
    for (const index of [0, 1]) {
      await panel.evaluate(async () => {
        await chrome.storage.local.set({ 'reinstall-fixture-marker': 'old-install' });
      });
      await cdp.send('Extensions.uninstall', { id: extensionId });
      expect((await cdp.send('Extensions.getExtensions')).extensions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: extensionId })]),
      );
      const installed = await cdp.send('Extensions.loadUnpacked', { path: packagedExtensionPath });
      expect(installed.id).toBe(extensionId);
      panel = await context.newPage();
      await expect(async () => {
        await panel.goto(sidePanelUrl(installed.id), { waitUntil: 'domcontentloaded' });
      }).toPass({ timeout: 15_000 });
      await expect(panel.getByText('Handshook setup', { exact: true })).toBeVisible();
      expect(
        await panel.evaluate(async () =>
          Boolean(
            (await chrome.storage.local.get('reinstall-fixture-marker'))[
              'reinstall-fixture-marker'
            ],
          ),
        ),
      ).toBe(false);

      const job = SAMPLE_JOBS[index];
      if (!job) throw new Error('Missing fictional job');
      mock.setSearchJobs([job]);
      await seedExtension(panel, {
        settings: {
          mode: 'autopilot',
          documents: {
            defaultResumeId: 'document-0001',
            coverLetterId: 'document-0003',
            transcriptId: 'document-0004',
            otherDocumentId: 'document-0005',
            autoSelectResume: false,
          },
          safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
        },
      });
      await startEngine(panel);
      await waitFor(
        () => getQueue(panel),
        (queue) => queue.items.some((item) => item.jobId === job.id && item.status === 'applied'),
        { description: `document-free result after reinstall ${index + 1}`, timeoutMs: 30_000 },
      );
      const attempts = await listSubmissions(panel);
      expect(attempts).toEqual([
        expect.objectContaining({ jobId: job.id, status: 'applied', documents: [] }),
      ]);
      expect(mock.requestsFor(`/jobs/${job.id}/applications`)).toHaveLength(1);
    }
  } finally {
    await cdp.detach();
  }
});
