import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './helpers/packaged-extension';
import { EXTENSION_ROOT } from './helpers/extension';
import { installHandshakeRoutes, type MockHandshake } from './helpers/handshake';
import { getQueue, getState, runnerPage, sendUi } from './helpers/seed';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/contracts';
import { pacingTimings } from '../../src/core/contracts/pacing';
import { JOB_PAGE_READY_TIMEOUT_MS } from '../../src/handshake/verification';
import { SAMPLE_JOBS } from '../../src/test/mockData';

const SCREENSHOTS = path.join(EXTENSION_ROOT, 'test-results/walkthrough');
const DEFAULT_PACING = pacingTimings(DEFAULT_SETTINGS.pacing.speed);
// Budget the actual mock path, without overriding the packaged product's pacing.
// content.scan can wait 8s per page; our mock has a results page and an empty
// terminal page, with one preset delay between them (engine.scan).
const SCAN_WAIT_MS = 2 * 8_000 + DEFAULT_PACING.scanDelayMaxMs;
// engine.scan schedules inspection after another preset delay. The content
// router and inspectJob each check readiness before returning job details.
const INSPECTION_WAIT_MS = DEFAULT_PACING.scanDelayMaxMs + 2 * JOB_PAGE_READY_TIMEOUT_MS;
// applyFlow checks readiness, waits up to 15s for the modal, then selects two
// native documents (5s for options + 2s to verify each). It pauses before Apply,
// after opening, before each document, and before the final Review gate.
// The unknown-question scenario returns before filling answers or submitting.
const FORM_WAIT_MS =
  JOB_PAGE_READY_TIMEOUT_MS + 15_000 + 2 * (5_000 + 2_000) + 5 * DEFAULT_PACING.humanDelayMaxMs;
// Include 50% scheduling slack plus 30s for CI navigation, storage, messages
// and MV3 alarm fallback. The same deterministic budgets apply locally and in CI.
const withCiMargin = (waitMs: number): number => Math.ceil(waitMs * 1.5) + 30_000;
const SCAN_TIMEOUT_MS = withCiMargin(SCAN_WAIT_MS);
const INSPECTION_TIMEOUT_MS = withCiMargin(SCAN_WAIT_MS + INSPECTION_WAIT_MS);
const FORM_TIMEOUT_MS = withCiMargin(SCAN_WAIT_MS + INSPECTION_WAIT_MS + FORM_WAIT_MS);
const WALKTHROUGH_UI_BUDGET_MS = 90_000;

// Opt-in slow-runner validation: throttle the real pages, never their timers or
// the product's pacing settings. These CDP sessions last until context teardown.
async function throttleForSlowRunner(page: Page): Promise<void> {
  if (process.env.HANDSHOOK_E2E_SLOW_RUNNER !== '1') return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

test.beforeEach(async ({ sidePanel }) => {
  await throttleForSlowRunner(sidePanel);
});
const JOB = (() => {
  const job = SAMPLE_JOBS[0];
  if (!job) throw new Error('The walkthrough needs one fictional fixture job');
  return job;
})();

test.afterEach(async ({ pageErrors }) => {
  expect(pageErrors).toEqual([]);
});

async function snapshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await expect(
    page.getByText(/^(Connecting to Handshook|Loading Handshook|Loading…)$/),
  ).toHaveCount(0);
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), animations: 'disabled' });
}

async function section(page: Page, name: string): Promise<void> {
  const button = page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: name === 'Needs' ? /^Needs/ : name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', {
      name: name === 'Home' ? 'Dashboard' : name === 'Needs' ? 'Needs you' : name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Loading…$/)).toHaveCount(0);
}

async function startSetup(context: BrowserContext, panel: Page, mock: MockHandshake) {
  mock.setSearchJobs([JOB]);
  const handshake = await context.newPage();
  await throttleForSlowRunner(handshake);
  await handshake.goto(mock.searchUrl());
  await panel.setViewportSize({ width: 420, height: 900 });
  await expect(panel.getByText('Handshook setup', { exact: true })).toBeVisible();
  await snapshot(panel, `${mock.scenario}-01-welcome`);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  const runnerPromise = context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Check session', exact: true }).click();
  const runner = await runnerPromise;
  await throttleForSlowRunner(runner);
  // An extension-created tab may navigate before Playwright attaches its routes.
  // DNS is pinned to localhost; reload serves the same page from the mock.
  await runner.reload({ waitUntil: 'domcontentloaded' });
  return { handshake, runner };
}

async function finishSetup(
  panel: Page,
  mock: MockHandshake,
  options: { addAnswers?: boolean; noDocuments?: boolean; mode?: 'review' | 'autopilot' } = {},
) {
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  if (!options.noDocuments) {
    await panel.getByLabel('Resume link or ID', { exact: true }).fill('document-0001');
    await panel.getByLabel('Cover letter link or ID', { exact: true }).fill('document-0003');
  } else {
    await expect(
      panel.getByText('Jobs will wait in Needs You until you add a resume.'),
    ).toBeVisible();
  }
  await snapshot(panel, `${mock.scenario}-03-documents`);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByText(/You can add answers later/)).toBeVisible();
  if (options.addAnswers) {
    await panel.getByRole('radio', { name: 'Yes', exact: true }).first().check();
    await panel.getByRole('radio', { name: 'No', exact: true }).last().check();
    // Setup lists graduation date before the earliest start date.
    await panel.locator('input[type="date"]').first().fill('2027-05-15');
  }
  await snapshot(panel, `${mock.scenario}-04-answers`);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await panel.getByLabel('Search name', { exact: true }).fill('My first internship search');
  await panel.getByLabel('Search URL', { exact: true }).fill(mock.searchUrl());
  await snapshot(panel, `${mock.scenario}-05-search`);
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  if (options.mode === 'autopilot') {
    // Full automation is the shipped default, so the wizard preselects it.
    await expect(panel.getByRole('radio', { name: /^Handshook applies for you/ })).toBeChecked();
  } else {
    // Review flows opt out explicitly; Review is no longer the default.
    await panel
      .getByRole('radio', { name: /^Review each application before it is submitted/ })
      .check();
    await expect(
      panel.getByRole('radio', { name: /^Review each application before it is submitted/ }),
    ).toBeChecked();
  }
  await snapshot(panel, `${mock.scenario}-06-mode`);
  await panel.getByRole('button', { name: 'Finish setup' }).click();
}

test('release ZIP: install, onboard, Review submission, Activity, default Autopilot, stop', async ({
  context,
  sidePanel,
  extensionId,
  serviceWorker,
  pageErrors,
}) => {
  test.setTimeout(2 * FORM_TIMEOUT_MS + WALKTHROUGH_UI_BUDGET_MS);
  const extensions = await context.newPage();
  await throttleForSlowRunner(extensions);
  await extensions.goto('chrome://extensions');
  await extensions.locator('extensions-toolbar #devMode').click();
  await expect(
    extensions.getByRole('button', { name: 'Load unpacked', exact: true }),
  ).toBeVisible();
  await expect(
    extensions.locator('extensions-item').filter({ hasText: 'Handshook' }),
  ).toBeVisible();
  await snapshot(extensions, '00-installed-release');
  const installed = await serviceWorker.evaluate(async () => ({
    manifest: chrome.runtime.getManifest(),
    behavior: await chrome.sidePanel.getPanelBehavior(),
  }));
  expect(installed.manifest.name).toBe('Handshook');
  expect(installed.manifest.action?.default_title).toBe('Open Handshook');
  expect(installed.behavior.openPanelOnActionClick).toBe(true);
  expect(sidePanel.url()).toBe(`chrome-extension://${extensionId}/sidepanel.html`);
  // Native toolbar/pinning is outside Playwright page automation. The real
  // packaged panel document is opened in a tab by the fixture; no mock UI bridge.
  await extensions.close();
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  await startSetup(context, sidePanel, mock);
  await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
  await snapshot(sidePanel, 'form-two-docs-02-session');
  await finishSetup(sidePanel, mock, { addAnswers: true });
  expect(
    (await sendUi<Settings>(sidePanel, { type: 'ui.settings.get', requestId: 'review-defaults' }))
      .pacing,
  ).toEqual(DEFAULT_SETTINGS.pacing);
  await expect(sidePanel.getByRole('button', { name: 'Start review run' })).toBeVisible();
  await snapshot(sidePanel, '07-dashboard-before-start');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  await sidePanel.getByRole('button', { name: 'Start review run' }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
      timeout: FORM_TIMEOUT_MS,
    })
    .toBe(1);
  await section(sidePanel, 'Needs');
  await expect(sidePanel.getByText('Ready to review', { exact: true })).toBeVisible();
  await snapshot(sidePanel, '08-needs-review');
  await sidePanel.getByRole('button', { name: 'Open review tab' }).click();
  const runner = runnerPage(context, JOB.id);
  await expect(runner.getByTestId('document-resume')).toHaveValue('document-0001');
  await expect(runner.getByTestId('document-cover-letter')).toHaveValue('document-0003');
  await snapshot(runner, '09-prepared-form');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  await runner.getByRole('button', { name: 'Submit Application', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.applied ?? 0, { timeout: 20_000 })
    .toBe(1);
  expect(mock.requestsFor(`/jobs/${JOB.id}/applications`)).toHaveLength(1);
  await expect.poll(async () => (await getState(sidePanel)).todayCount).toBe(1);
  await snapshot(runner, '10-site-confirmation');
  await section(sidePanel, 'Queue');
  await expect(sidePanel.getByText('Applied', { exact: true }).first()).toBeVisible();
  await snapshot(sidePanel, '11-applied-queue');
  await section(sidePanel, 'Activity');
  const appliedEvents = sidePanel
    .getByRole('listitem')
    .filter({ has: sidePanel.getByText('job.applied', { exact: true }) });
  await expect(appliedEvents).toHaveCount(1);
  await expect(appliedEvents).toContainText(JOB.title);
  await snapshot(sidePanel, '12-activity');
  await section(sidePanel, 'Home');
  await sidePanel.getByRole('button', { name: 'Stop', exact: true }).click();
  await section(sidePanel, 'Settings');
  await sidePanel.getByRole('radio', { name: /^Handshook applies for you/ }).check();
  // Switching the run mode does not turn the Review gate on by itself: full
  // automation is the default. This walkthrough turns it on explicitly so the
  // next run still stops for a human.
  const reviewGate = sidePanel.getByRole('switch', {
    name: 'Review each application before it is submitted',
    exact: true,
  });
  await expect(reviewGate).toHaveAttribute('aria-checked', 'false');
  await reviewGate.click();
  await expect(reviewGate).toHaveAttribute('aria-checked', 'true');
  await expect(sidePanel.getByLabel('Daily cap', { exact: true })).toHaveValue('15');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await snapshot(sidePanel, '13-autopilot-defaults');
  const savedDefaults = await sendUi<Settings>(sidePanel, {
    type: 'ui.settings.get',
    requestId: 'autopilot-defaults',
  });
  expect(savedDefaults.mode).toBe('autopilot');
  expect(savedDefaults.safety.reviewBeforeSubmit).toBe(true);
  expect(savedDefaults.pacing).toEqual(DEFAULT_SETTINGS.pacing);
  // The first job is already applied, so a fresh scan correctly deduplicates it
  // and can finish before Stop is clicked. Give this run a new fixture job and
  // wait for the default Review gate to hold its form open.
  const nextJob = SAMPLE_JOBS[1];
  if (!nextJob) throw new Error('The walkthrough needs a second fictional fixture job');
  mock.setSearchJobs([nextJob]);
  await section(sidePanel, 'Home');
  await sidePanel.getByRole('button', { name: 'Start applying' }).click();
  await expect
    .poll(
      async () =>
        (await getQueue(sidePanel)).items.find((item) => item.jobId === nextJob.id)?.status,
      { timeout: FORM_TIMEOUT_MS },
    )
    .toBe('ready_for_review');
  await expect(sidePanel.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await snapshot(sidePanel, '14-autopilot-started');
  await sidePanel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await getState(sidePanel)).status).toBe('idle');
  await expect(
    sidePanel.getByRole('button', { name: 'Start applying', exact: true }),
  ).toBeVisible();
  await snapshot(sidePanel, '15-stopped');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test.describe('release ZIP at night', () => {
  test.use({ browserLocalHour: 23 });

  test('default Autopilot applies at night without an active-hours restriction', async ({
    context,
    sidePanel,
    serviceWorker,
  }) => {
    test.setTimeout(FORM_TIMEOUT_MS + WALKTHROUGH_UI_BUDGET_MS);
    // Keep the actual packaged defaults and run outside the retired window.
    const hour = await serviceWorker.evaluate(() => new Date().getHours());
    expect(hour === 23 || hour === 0).toBe(true);
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    await startSetup(context, sidePanel, mock);
    await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({
      timeout: 20_000,
    });
    await finishSetup(sidePanel, mock, { mode: 'autopilot' });
    await section(sidePanel, 'Settings');
    // Nothing to switch: Autopilot is the shipped default and the Review gate
    // is the opt-out, so this user's run is fully automatic.
    await expect(
      sidePanel.getByRole('radio', { name: /^Handshook applies for you/ }),
    ).toBeChecked();
    await expect(
      sidePanel.getByRole('switch', {
        name: 'Review each application before it is submitted',
        exact: true,
      }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      (await sendUi<Settings>(sidePanel, { type: 'ui.settings.get', requestId: 'night-defaults' }))
        .pacing,
    ).toEqual(DEFAULT_SETTINGS.pacing);
    await section(sidePanel, 'Home');
    await sidePanel.getByRole('button', { name: 'Start applying' }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).summary.counts.applied ?? 0, {
        timeout: FORM_TIMEOUT_MS,
      })
      .toBe(1);
    expect(mock.requestsFor(`/jobs/${JOB.id}/applications`)).toHaveLength(1);
    expect((await getState(sidePanel)).pauseReason).not.toBe('active_hours');
    await expect.poll(async () => (await getState(sidePanel)).todayCount).toBe(1);
    await snapshot(sidePanel, '24-autopilot-at-night');
  });
});

test('release ZIP: answers can wait, required questions cannot submit automatically', async ({
  context,
  sidePanel,
}) => {
  test.setTimeout(FORM_TIMEOUT_MS + WALKTHROUGH_UI_BUDGET_MS);
  const mock = await installHandshakeRoutes(context, 'form-questions');
  await startSetup(context, sidePanel, mock);
  await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
  await finishSetup(sidePanel, mock, { mode: 'autopilot' });
  await section(sidePanel, 'Settings');
  // Autopilot with the Review gate off is the default; the run must still stop
  // for a required question with no saved answer.
  await expect(
    sidePanel.getByRole('switch', {
      name: 'Review each application before it is submitted',
      exact: true,
    }),
  ).toHaveAttribute('aria-checked', 'false');
  // Remove the fit condition so the missing-answer gate itself is exercised.
  await sidePanel.getByRole('slider', { name: /Minimum fit score/ }).fill('0');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await section(sidePanel, 'Home');
  await sidePanel.getByRole('button', { name: 'Start applying' }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.needs_input ?? 0, {
      timeout: FORM_TIMEOUT_MS,
    })
    .toBe(1);
  await section(sidePanel, 'Needs');
  await expect(sidePanel.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await snapshot(sidePanel, '16-unanswered-questions');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
});

test('release ZIP: logged out and no documents explain how to continue safely', async ({
  context,
  sidePanel,
}) => {
  test.setTimeout(INSPECTION_TIMEOUT_MS + WALKTHROUGH_UI_BUDGET_MS);
  const mock = await installHandshakeRoutes(context, 'login-redirect');
  mock.setDocuments([]);
  const { runner } = await startSetup(context, sidePanel, mock);
  await expect(sidePanel.getByText('Not signed in', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await snapshot(sidePanel, '17-logged-out');
  // This is the mock site's own sign-in form, never a real credential or site.
  await runner.getByRole('button', { name: /sign in/i }).click();
  await sidePanel.getByRole('button', { name: 'Check session', exact: true }).click();
  await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
  await finishSetup(sidePanel, mock, { noDocuments: true, mode: 'autopilot' });
  await snapshot(sidePanel, '18-no-resume-warning');
  await sidePanel.getByRole('button', { name: 'Start applying' }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.needs_input ?? 0, {
      timeout: INSPECTION_TIMEOUT_MS,
    })
    .toBe(1);
  await section(sidePanel, 'Needs');
  await snapshot(sidePanel, '19-missing-documents');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
});

for (const scenario of ['external', 'missing-selector'] as const) {
  test(`release ZIP: ${scenario === 'external' ? 'external excluded by default' : 'missing-selector handoff'}, diagnostics, and reset`, async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(
      (scenario === 'external' ? SCAN_TIMEOUT_MS : INSPECTION_TIMEOUT_MS) +
        WALKTHROUGH_UI_BUDGET_MS,
    );
    const mock = await installHandshakeRoutes(context, scenario);
    await startSetup(context, sidePanel, mock);
    await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
    await finishSetup(sidePanel, mock);
    await sidePanel.getByRole('button', { name: 'Start review run' }).click();
    if (scenario === 'external') {
      await expect
        .poll(
          async () => {
            const state = await getState(sidePanel);
            return state.status === 'idle' && state.scanComplete;
          },
          { timeout: SCAN_TIMEOUT_MS },
        )
        .toBe(true);
      const queue = await getQueue(sidePanel);
      expect(queue.items).toEqual([]);
      expect(queue.jobs).toEqual([]);
      expect(queue.needs).toEqual([]);
      expect(queue.summary).toMatchObject({ total: 0, todayCount: 0, counts: {} });
      await section(sidePanel, 'Queue');
      await expect(sidePanel.getByText('Employer site', { exact: true })).toHaveCount(0);
      await expect(sidePanel.getByText('External links (beta)', { exact: true })).toHaveCount(0);
      expect(
        context.pages().some((candidate) => candidate.url().includes('careers.example.com')),
      ).toBe(false);
    } else {
      await expect
        .poll(async () => (await getState(sidePanel)).lastError?.code, {
          timeout: INSPECTION_TIMEOUT_MS,
        })
        .toBe('UI_CHANGED');
      await expect.poll(async () => (await getState(sidePanel)).pauseReason).toBe('ui_changed');
    }
    await snapshot(sidePanel, `20-${scenario}`);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    await section(sidePanel, 'Home');
    if ((await getState(sidePanel)).status !== 'idle') {
      await sidePanel.getByRole('button', { name: 'Stop', exact: true }).click();
    }
    await section(sidePanel, 'Settings');
    await sidePanel.getByRole('button', { name: 'Open diagnostics' }).click();
    await expect(
      sidePanel.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible();
    await snapshot(sidePanel, `21-${scenario}-diagnostics`);
    const downloadPromise = sidePanel.waitForEvent('download');
    await sidePanel.getByRole('button', { name: 'Export shareable diagnostics' }).click();
    const download = await downloadPromise;
    const saved = path.join(SCREENSHOTS, `${scenario}-shareable-diagnostics.json`);
    await download.saveAs(saved);
    const exported = await readFile(saved, 'utf8');
    expect(() => JSON.parse(exported) as unknown).not.toThrow();
    expect(exported).not.toContain(JOB.title);
    expect(exported).not.toContain(mock.searchUrl());
    await section(sidePanel, 'Settings');
    await sidePanel.getByRole('button', { name: 'Reset local data', exact: true }).click();
    const dialog = sidePanel.getByRole('dialog', { name: 'Reset everything?' });
    await expect(
      dialog.getByRole('button', { name: 'Reset local data', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('textbox').fill('reset');
    await snapshot(sidePanel, `22-${scenario}-reset-confirmation`);
    await dialog.getByRole('button', { name: 'Reset local data', exact: true }).click();
    await expect(sidePanel.getByText('Handshook setup', { exact: true })).toBeVisible();
    await expect.poll(async () => (await getQueue(sidePanel)).items.length).toBe(0);
    await snapshot(sidePanel, `23-${scenario}-reset-complete`);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
}
