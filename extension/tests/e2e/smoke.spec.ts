/**
 * Extension smoke: proves the harness itself works before feature E2E exists.
 *
 * These tests stay resilient while the UI and background wiring are in progress:
 * they assert the extension builds/loads, the service worker starts, the side panel
 * document renders, and a routed Handshake page loads with no uncaught errors.
 */

import { expect, test } from './helpers/extension';
import { installHandshakeRoutes } from './helpers/handshake';
import { PROTOCOL_VERSION } from '../../src/core/contracts';

test.describe('extension smoke', () => {
  test('loads the built extension and starts the background service worker', async ({
    serviceWorker,
    extensionId,
  }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

    expect(extractExtensionId(serviceWorker.url())).toBe(extensionId);
    expect(manifest.name).toBe('Handshook');
    expect(manifest.manifest_version).toBe(3);
  });

  test('renders the side panel document without uncaught errors', async ({
    sidePanel,
    pageErrors,
  }) => {
    await expect(sidePanel).toHaveTitle('Handshook');
    await expect(sidePanel.locator('#root')).toBeVisible();
    // The shell/onboarding/dashboard UI is owned by other tasks; require rendered
    // content and a heading without pinning copy that is still in flight.
    await expect(sidePanel.locator('#root')).not.toBeEmpty();
    await expect(sidePanel.getByRole('heading').first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('serves a routed Handshake search page with ten job cards', async ({
    context,
    pageErrors,
  }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();

    await page.goto(mock.searchUrl());

    await expect(page.getByRole('heading', { name: 'Job search' })).toBeVisible();
    await expect(page.getByTestId('job-results').locator('article')).toHaveCount(10);
    await expect(page.getByTestId('job-link').first()).toHaveAttribute(
      'href',
      new URL(mock.jobUrl('900001')).pathname,
    );
    expect(mock.pagesServed).toContain('/job-search');
    expect(pageErrors).toEqual([]);
  });

  test('paginates to the empty state and disables next', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();

    await page.goto(mock.searchUrl());
    await page.getByTestId('next-page').click({ timeout: 15_000 });

    await expect(page.getByTestId('empty-state')).toHaveText(/no jobs match/i);
    await expect(page.getByTestId('next-page')).toBeDisabled();
    await expect(page.getByTestId('job-results')).toHaveCount(0);
  });

  test('navigates from a search card to job detail through the SPA', async ({ context }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();

    await page.goto(mock.searchUrl());
    await page.getByRole('link', { name: 'Software Engineering Intern' }).click();

    await expect(page.getByTestId('job-detail')).toHaveAttribute('data-job-id', '900001');
    await expect(page.getByTestId('apply-button')).toHaveText('Quick Apply');
    expect(new URL(page.url()).pathname).toBe('/jobs/900001');
  });

  // The content bridge (T30) answers `content.ping`; the service worker drives the tab
  // exactly as the background router will.
  test('content script answers content.ping on a routed Handshake page', async ({
    context,
    serviceWorker,
  }) => {
    const mock = await installHandshakeRoutes(context, 'search-10-jobs');
    const page = await context.newPage();
    await page.goto(mock.searchUrl());

    await expect
      .poll(
        () =>
          serviceWorker.evaluate(async (protocolVersion) => {
            const tabs = await chrome.tabs.query({ url: 'https://app.joinhandshake.com/*' });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) return null;
            try {
              return await chrome.tabs.sendMessage(tabId, {
                type: 'content.ping',
                requestId: 'smoke',
                protocolVersion,
              });
            } catch {
              return null;
            }
          }, PROTOCOL_VERSION),
        { timeout: 15_000, message: 'content script did not answer content.ping' },
      )
      .toMatchObject({ requestId: 'smoke', ok: true, data: { pong: true } });
  });
});

function extractExtensionId(workerUrl: string): string {
  return new URL(workerUrl).hostname;
}
