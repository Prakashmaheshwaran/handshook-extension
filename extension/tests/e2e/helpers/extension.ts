/**
 * Playwright fixture that loads the built extension into Playwright's bundled Chromium.
 *
 * Why bundled Chromium: Google Chrome 137+ ignores `--load-extension`, so the E2E
 * suite must use `channel: 'chromium'` from `npx playwright install chromium`.
 *
 * Usage:
 *
 *   import { expect, test } from './helpers/extension';
 *
 *   test('side panel renders', async ({ sidePanel, pageErrors }) => {
 *     await expect(sidePanel.locator('#root')).toBeVisible();
 *     expect(pageErrors).toEqual([]);
 *   });
 *
 * Fixtures:
 * - `context`       persistent context with the unpacked extension loaded
 * - `extensionId`   unpacked extension ID, parsed from the service worker URL
 * - `serviceWorker` the MV3 background worker
 * - `sidePanel`     `chrome-extension://<id>/sidepanel.html` opened in a tab
 * - `pageErrors`    uncaught page errors across every page in the context
 *
 * Environment:
 * - `HANDSHOOK_E2E_EXTENSION_PATH` override the build directory
 * - `HANDSHOOK_E2E_HEADLESS=1|0`   force headless/headed (default: headless locally)
 * - `HANDSHOOK_E2E_KEEP_PROFILE=1` keep the temporary profile after the run
 *
 * CI sets HANDSHOOK_E2E_HEADLESS=1 and uses full Chromium, not
 * `chromium_headless_shell`. To debug in headed mode on Linux, explicitly set
 * HANDSHOOK_E2E_HEADLESS=0 and run under xvfb or a desktop display.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repository root for the extension package (`extension/`). */
export const EXTENSION_ROOT = path.resolve(HELPERS_DIR, '../../..');

/** Unpacked build loaded by `--load-extension`. */
export const EXTENSION_BUILD_PATH =
  process.env.HANDSHOOK_E2E_EXTENSION_PATH ?? path.join(EXTENSION_ROOT, '.output', 'chrome-mv3');

/** Cold-start budget for the MV3 service worker. */
export const SERVICE_WORKER_TIMEOUT_MS = 15_000;

export interface LaunchedExtension {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly serviceWorker: Worker;
  readonly userDataDir: string;
  close(options?: { removeProfile?: boolean }): Promise<void>;
}

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  sidePanel: Page;
  pageErrors: string[];
}

/** Headless locally by default; headed only when explicitly requested or on non-Linux CI. */
export function shouldRunHeadless(): boolean {
  const override = process.env.HANDSHOOK_E2E_HEADLESS;
  if (override === '1') return true;
  if (override === '0') return false;

  // Default to headless so test runs never pop windows or steal focus. Set
  // HANDSHOOK_E2E_HEADLESS=0 only when you explicitly want to watch a run.
  const inCi = Boolean(process.env.CI);
  if (!inCi) return true;

  // Linux CI without xvfb has no display; Playwright's full Chromium still supports
  // extensions in new headless mode. macOS/Windows CI runners can run headed.
  if (process.platform === 'linux') return !process.env.DISPLAY;
  return false;
}

/** Launch the persistent context and wait for the extension's service worker. */
export async function launchExtension(
  options: {
    /** Load an extracted release package instead of the development build. */
    extensionPath?: string;
    userDataDir?: string;
    /** Clear a caller-supplied profile before launch (default true). */
    resetProfile?: boolean;
    /** Remove the profile when `close()` runs (default true). */
    removeProfileOnClose?: boolean;
    /** Permit CDP reloading only in the isolated extension-update regression. */
    enableExtensionDebugging?: boolean;
    /** Match page and MV3 worker local time for time-of-day regressions. */
    timezoneId?: string;
  } = {},
): Promise<LaunchedExtension> {
  const extensionPath = options.extensionPath ?? EXTENSION_BUILD_PATH;
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Extension build not found at ${extensionPath}. Run "npm run build" before "npm run test:e2e".`,
    );
  }

  const removeOnClose = options.removeProfileOnClose !== false;
  const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), 'handshook-e2e-'));
  if (options.userDataDir && options.resetProfile !== false) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
  mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: shouldRunHeadless(),
    // Playwright's global disable flag permits initial command-line loading,
    // but blocks the same extension after runtime.reload. The update test needs
    // normal extension lifecycle behavior in its otherwise empty profile.
    ...(options.enableExtensionDebugging ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
    timeout: 60_000,
    viewport: { width: 1280, height: 900 },
    ...(options.timezoneId
      ? { timezoneId: options.timezoneId, env: { ...process.env, TZ: options.timezoneId } }
      : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-sync',
      ...(options.enableExtensionDebugging ? ['--enable-unsafe-extension-debugging'] : []),
      // Safety net: any request that escapes Playwright route interception (for
      // example a tab the extension opens before Playwright attaches to it) must
      // never reach the real Handshake or OpenRouter service. Routing still serves mocked
      // responses; this only affects requests that were not intercepted.
      '--host-resolver-rules=MAP *.joinhandshake.com 127.0.0.1, MAP joinhandshake.com 127.0.0.1, MAP *.joinhandshake.co.uk 127.0.0.1, MAP joinhandshake.co.uk 127.0.0.1, MAP *.openrouter.ai 127.0.0.1, MAP openrouter.ai 127.0.0.1',
    ],
  });

  try {
    const serviceWorker = await waitForServiceWorker(context);
    return {
      context,
      extensionId: new URL(serviceWorker.url()).hostname,
      serviceWorker,
      userDataDir,
      close: async (closeOptions = {}) => {
        await context.close();
        const shouldRemove =
          (closeOptions.removeProfile ?? removeOnClose) &&
          process.env.HANDSHOOK_E2E_KEEP_PROFILE !== '1';
        if (shouldRemove) {
          rmSync(userDataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await context.close();
    if (removeOnClose && process.env.HANDSHOOK_E2E_KEEP_PROFILE !== '1') {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Wait for the extension MV3 service worker (cold start can take a few seconds). */
export async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const findWorker = (): Worker | undefined =>
    context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));

  const existing = findWorker();
  if (existing) return existing;

  try {
    return await context.waitForEvent('serviceworker', {
      timeout: SERVICE_WORKER_TIMEOUT_MS,
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    });
  } catch (error) {
    // The worker can start between the first check and listener registration.
    const late = findWorker();
    if (late) return late;
    throw new Error(
      `Extension service worker did not start within ${SERVICE_WORKER_TIMEOUT_MS}ms. ` +
        `Check that ${EXTENSION_BUILD_PATH} is a fresh build and that the test is not running in ` +
        `headless-shell mode. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** URL of the extension's side panel document. */
export function sidePanelUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/sidepanel.html`;
}

/** Open the side panel as a normal tab (Playwright cannot drive Chrome's side panel chrome). */
export async function openSidePanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(sidePanelUrl(extensionId), { waitUntil: 'domcontentloaded' });
  return page;
}

/** Collect uncaught page errors for every page opened in the context. */
export function collectPageErrors(context: BrowserContext): string[] {
  const errors: string[] = [];
  const attach = (page: Page): void => {
    page.on('pageerror', (error) => {
      errors.push(`${page.url()} :: ${error.message}`);
    });
  };
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
  return errors;
}

export const test = base.extend<ExtensionFixtures>({
  // Playwright requires an object destructuring pattern even when no fixtures are used.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const launched = await launchExtension();
    try {
      await use(launched.context);
    } finally {
      await launched.close();
    }
  },

  serviceWorker: async ({ context }, use) => {
    await use(await waitForServiceWorker(context));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).hostname);
  },

  pageErrors: async ({ context }, use) => {
    await use(collectPageErrors(context));
  },

  sidePanel: async ({ context, extensionId, pageErrors }, use) => {
    // Request pageErrors first so the listener exists before the side panel opens.
    void pageErrors;
    const page = await openSidePanel(context, extensionId);
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  },
});

export { expect };
