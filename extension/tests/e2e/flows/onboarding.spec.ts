import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, seedExtension, seedRecords, useMockPacing } from '../helpers/seed';
import { makeJob, makeQueueItem } from '../../../src/test/factories';
import type { Settings } from '../../../src/core/contracts';

for (const width of [320, 400, 500]) {
  test(`upgraded install reruns setup without losing data and keeps Dry run visible at ${width}px`, async ({
    sidePanel,
  }) => {
    await sidePanel.setViewportSize({ width, height: 900 });
    await seedExtension(sidePanel, {
      settings: {
        mode: 'dry_run',
        search: { collectExternalJobs: true },
        documents: { otherDocumentId: '' },
      },
    });
    const job = makeJob();
    const queueItem = makeQueueItem({ jobId: job.id, status: 'applied' });
    await seedRecords(sidePanel, { job, queueItem });
    const before = await getQueue(sidePanel);
    const beforeSettings = await sidePanel.evaluate(
      async () =>
        (await chrome.storage.local.get('handshook.settings.v1'))[
          'handshook.settings.v1'
        ] as Settings,
    );
    await sidePanel.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('handshook');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').put({
            id: 'upgrade-history',
            at: 1,
            type: 'job.applied',
            level: 'info',
            jobId: '900001',
            message: 'Fixture application history',
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    });
    await sidePanel.reload();
    await expect(
      sidePanel.getByText('Dry run: nothing will be submitted', { exact: true }),
    ).toBeVisible();
    await expect(
      sidePanel.getByRole('button', { name: 'Start dry run (no submissions)', exact: true }),
    ).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Queue', exact: true }).click();
    const banner = sidePanel.getByText('Dry run: nothing will be submitted', { exact: true });
    await expect(banner).toBeVisible();
    await sidePanel.locator('main').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(banner).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Run setup again', exact: true }).click();
    await expect(sidePanel.getByText('Step 1 of 6', { exact: true })).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
      beforeSettings.documents.defaultResumeId ?? '',
    );
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(sidePanel.getByLabel('Search name', { exact: true })).toHaveValue(
      beforeSettings.search.savedSearches[0]?.name ?? '',
    );
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      sidePanel.getByRole('radio', { name: /^Dry run: nothing will be submitted/ }),
    ).toBeChecked();
    await sidePanel.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await expect(
      sidePanel.getByRole('button', { name: 'Start dry run (no submissions)', exact: true }),
    ).toBeVisible();
    const after = await getQueue(sidePanel);
    expect(after.items).toEqual(before.items);
    expect(after.jobs).toEqual(before.jobs);
    const afterSettings = await sidePanel.evaluate(
      async () =>
        (await chrome.storage.local.get('handshook.settings.v1'))[
          'handshook.settings.v1'
        ] as Settings,
    );
    expect(afterSettings.mode).toBe('dry_run');
    expect(afterSettings.documents).toEqual(beforeSettings.documents);
    expect(afterSettings.search.collectExternalJobs).toBe(true);
    expect(afterSettings.search.savedSearches.map((search: { id: string }) => search.id)).toEqual(
      beforeSettings.search.savedSearches.map((search: { id: string }) => search.id),
    );
    const history = await sidePanel.evaluate(
      async () =>
        new Promise<unknown>((resolve, reject) => {
          const request = indexedDB.open('handshook');
          request.onsuccess = () => {
            const db = request.result;
            const read = db
              .transaction('events', 'readonly')
              .objectStore('events')
              .get('upgrade-history');
            read.onsuccess = () => {
              db.close();
              resolve(read.result);
            };
            read.onerror = () => reject(read.error);
          };
          request.onerror = () => reject(request.error);
        }),
    );
    expect(history).toMatchObject({ id: 'upgrade-history', type: 'job.applied' });
    expect(
      await sidePanel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('first-run onboarding to a reviewed application, end to end', async ({
  context,
  sidePanel,
}) => {
  test.setTimeout(120_000);
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  const handshake = await context.newPage();
  await handshake.goto(mock.searchUrl());
  await sidePanel.setViewportSize({ width: 420, height: 900 });

  // Welcome → session
  await sidePanel.getByRole('button', { name: /continue/i }).click();
  // The runner opens its own (P1-17) background tab for the session check. In
  // Playwright that tab can start navigating before the harness attaches, so
  // reload it once attached to guarantee the mock routes answer it.
  const runnerTabPromise = context.waitForEvent('page');
  await sidePanel.getByRole('button', { name: /check session/i }).click();
  const sessionTab = await runnerTabPromise;
  await sessionTab.reload({ waitUntil: 'domcontentloaded' });
  await expect(sidePanel.getByText(/signed in on this browser/i)).toBeVisible({
    timeout: 20_000,
  });
  await sidePanel.getByRole('button', { name: /^continue$/i }).click();

  // Documents: paste the links Handshake shows for each file.
  await sidePanel
    .getByLabel('Resume link or ID', { exact: true })
    .fill('https://app.joinhandshake.com/docs/document-0001');
  await expect(sidePanel.getByText('Saved as document ID document-0001')).toBeVisible();
  await sidePanel.getByLabel('Cover letter link or ID', { exact: true }).fill('document-0003');
  await sidePanel.getByRole('button', { name: /^continue$/i }).click();

  // Reusable answers are optional during setup; this user chooses to save them.
  await sidePanel.getByRole('radio', { name: /^yes$/i }).first().check();
  await sidePanel.getByRole('radio', { name: /^no$/i }).last().check();
  // Setup lists graduation date before the earliest start date.
  await sidePanel.locator('input[type="date"]').first().fill('2027-05-15');
  await sidePanel.getByRole('button', { name: /^continue$/i }).click();

  // Saved search
  await expect(sidePanel.getByText(/your saved search/i)).toBeVisible({ timeout: 5_000 });
  await sidePanel.getByLabel(/search name/i).fill('Software internships');
  await sidePanel.getByLabel(/search url/i).fill(mock.searchUrl());
  await sidePanel.getByRole('button', { name: /^continue$/i }).click();

  // This flow is the Review opt-out: select it explicitly, then finish.
  await sidePanel
    .getByRole('radio', { name: /^Review each application before it is submitted/ })
    .check();
  await expect(
    sidePanel.getByRole('radio', { name: /^Review each application before it is submitted/ }),
  ).toBeChecked();
  await sidePanel.getByRole('button', { name: /finish setup/i }).click();
  await expect(sidePanel.getByRole('button', { name: /start review run/i })).toBeVisible();
  await useMockPacing(sidePanel);

  await sidePanel.getByRole('button', { name: /start review run/i }).click();
  // The run fills a form and waits for the user.
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
      timeout: 30_000,
    })
    .toBe(1);

  await sidePanel.getByRole('button', { name: /needs/i }).first().click();
  await expect(sidePanel.getByText('Ready to review', { exact: true })).toBeVisible();
  await sidePanel.getByRole('button', { name: /open review tab/i }).click();

  const runner = context.pages().find((page) => /\/jobs\/\d+/.test(page.url()));
  expect(runner).toBeTruthy();
  await runner!.getByTestId('submit-application').click();

  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.applied ?? 0, {
      timeout: 20_000,
    })
    .toBe(1);
  await mock.dispose();
});
