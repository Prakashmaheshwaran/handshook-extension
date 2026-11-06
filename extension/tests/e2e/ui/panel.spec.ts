import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, EXTENSION_ROOT } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, getState, seedExtension, seedRecords, useMockPacing } from '../helpers/seed';
import { makeJob, makeQueueItem } from '../../../src/test/factories';

const AUDIT_DIR = path.join(EXTENSION_ROOT, 'test-results/ui-audit');

async function snapshot(page: Page, name: string): Promise<void> {
  await mkdir(AUDIT_DIR, { recursive: true });
  await expect(
    page.getByText(/^(Connecting to Handshook|Loading Handshook|Loading…)$/),
  ).toHaveCount(0);
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: /^(Loading |Reading |Connecting to )/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: path.join(AUDIT_DIR, `${name}.png`) });
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.querySelector('#root');
    return main ? main.scrollWidth - main.clientWidth : 0;
  });
  expect(overflow, `${name} has horizontal overflow`).toBeLessThanOrEqual(1);
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function section(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', {
      name: name === 'Needs' ? /^Needs/ : name,
      exact: true,
    })
    .click();
}

for (const width of [320, 360, 400, 500]) {
  test(`first-time user completes onboarding and visits every screen at ${width}px without console errors`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(sidePanel);
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    const handshake = await context.newPage();
    await handshake.goto(mock.searchUrl());
    await sidePanel.setViewportSize({ width, height: 800 });
    await snapshot(sidePanel, `${width}-onboarding-welcome`);
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    const runnerPromise = context.waitForEvent('page');
    await sidePanel.getByRole('button', { name: 'Check session', exact: true }).click();
    const runner = await runnerPromise;
    await runner.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidePanel.getByText('Signed in on this browser')).toBeVisible({ timeout: 20_000 });
    await snapshot(sidePanel, `${width}-onboarding-session`);
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await sidePanel
      .getByLabel('Resume link or ID', { exact: true })
      .fill('https://app.joinhandshake.com/docs/document-0002');
    await expect(sidePanel.getByText('Saved as document ID document-0002')).toBeVisible();
    await sidePanel.getByLabel('Cover letter link or ID', { exact: true }).fill('document-0003');
    await snapshot(sidePanel, `${width}-onboarding-documents`);
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(sidePanel.getByText(/You can add answers later/)).toBeVisible();
    await sidePanel.getByRole('radio', { name: /^Yes$/ }).first().check();
    await sidePanel.getByRole('radio', { name: /^No$/ }).last().check();
    // Setup lists graduation date before the earliest start date.
    await sidePanel.locator('input[type="date"]').first().fill('2027-05-15');
    await snapshot(sidePanel, `${width}-onboarding-answers`);
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await sidePanel.getByLabel('Search name', { exact: true }).fill('Internships');
    await sidePanel.getByLabel('Search URL', { exact: true }).fill('https://example.com/jobs');
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(sidePanel.getByRole('alert')).toContainText('Handshake job search URL');
    await sidePanel.getByLabel('Search URL', { exact: true }).fill(mock.searchUrl());
    await snapshot(sidePanel, `${width}-onboarding-search`);
    await sidePanel.getByRole('button', { name: 'Continue', exact: true }).click();
    // This walkthrough visits every screen in the Review opt-out.
    await sidePanel
      .getByRole('radio', { name: /^Review each application before it is submitted/ })
      .check();
    await expect(
      sidePanel.getByRole('radio', { name: /^Review each application before it is submitted/ }),
    ).toBeChecked();
    await snapshot(sidePanel, `${width}-onboarding-mode`);
    await sidePanel.getByRole('button', { name: 'Finish setup' }).click();
    await expect(sidePanel.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await useMockPacing(sidePanel);
    await sidePanel.getByRole('button', { name: 'Start review run' }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    await section(sidePanel, 'Home');
    await snapshot(sidePanel, `${width}-dashboard`);
    for (const [nav, heading] of [
      ['Queue', 'Queue'],
      ['Needs', 'Needs you'],
      ['Activity', 'Activity'],
      ['Settings', 'Settings'],
    ] as const) {
      await section(sidePanel, nav);
      await expect(sidePanel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await snapshot(sidePanel, `${width}-${nav.toLowerCase()}`);
      if (nav === 'Needs') {
        await sidePanel.getByRole('button', { name: 'Open review tab', exact: true }).click();
        expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
      }
    }
    await sidePanel.getByRole('button', { name: 'Open diagnostics' }).click();
    await expect(
      sidePanel.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible();
    await snapshot(sidePanel, `${width}-diagnostics`);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
}

for (const width of [320, 400, 500]) {
  test(`all screens and settings sections fit at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const errors = watchConsole(sidePanel);
    await installHandshakeRoutes(context, 'search-10-jobs');
    await sidePanel.setViewportSize({ width, height: 800 });
    await snapshot(sidePanel, `${width}-onboarding`);
    await seedExtension(sidePanel);
    await sidePanel.reload();
    await expect(sidePanel.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await snapshot(sidePanel, `${width}-dashboard`);
    for (const nav of ['Queue', 'Needs', 'Activity', 'Settings']) {
      await section(sidePanel, nav);
      await expect(sidePanel.locator('main')).not.toContainText('Loading…');
      await snapshot(sidePanel, `${width}-${nav.toLowerCase()}`);
    }
    for (const id of [
      'safety',
      'search',
      'pacing',
      'documents',
      'answers',
      'ai',
      'beta',
      'advanced',
      'data',
      'import-export',
    ]) {
      await sidePanel.locator(`#${id}`).scrollIntoViewIfNeeded();
      await snapshot(sidePanel, `${width}-settings-${id}`);
    }
    await sidePanel.getByRole('button', { name: 'Open diagnostics' }).click();
    await expect(
      sidePanel.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible();
    await snapshot(sidePanel, `${width}-diagnostics`);
    const download = sidePanel.waitForEvent('download');
    await sidePanel
      .getByRole('button', { name: 'Export shareable diagnostics', exact: true })
      .click();
    expect((await download).suggestedFilename()).toMatch(/\.json$/);
    await sidePanel.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(sidePanel.getByRole('dialog', { name: 'Clear diagnostics?' })).toBeVisible();
    await sidePanel.keyboard.press('Escape');
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

for (const width of [320, 400, 500]) {
  test(`settings controls persist, answer CRUD works, and import/export/reset remain reviewable at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const errors = watchConsole(sidePanel);
    await installHandshakeRoutes(context, 'search-10-jobs');
    await seedExtension(sidePanel);
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    await section(sidePanel, 'Settings');
    await sidePanel.getByRole('radio', { name: /^Dry run/ }).check();
    await sidePanel.getByRole('radio', { name: /^Handshook applies for you/ }).check();
    // Choosing Autopilot must not silently turn the Review gate off; the saved
    // safety switch still decides whether each application is reviewed.
    await expect(
      sidePanel.getByRole('switch', {
        name: 'Review each application before it is submitted',
        exact: true,
      }),
    ).toHaveAttribute('aria-checked', 'true');
    await sidePanel.getByRole('radio', { name: /^Review each application/ }).check();
    for (const name of [
      'Review each application before it is submitted',
      'Submit sensitive answers automatically',
      'Fill EEO self-identification automatically',
      'Fill free-text answers automatically',
      'Stop on an unknown required question',
    ]) {
      const toggle = sidePanel.getByRole('switch', { name, exact: true });
      const before = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
      await toggle.click();
    }
    const verification = sidePanel.getByRole('switch', {
      name: /^(Verify each submission|Wait for submission confirmation)$/,
    });
    await verification.click();
    await verification.click();
    await sidePanel
      .getByLabel('Handshake host', { exact: true })
      .selectOption('app.joinhandshake.co.uk');
    await sidePanel
      .getByLabel('Handshake host', { exact: true })
      .selectOption('app.joinhandshake.com');
    await sidePanel.getByRole('checkbox', { name: 'Remote roles only', exact: true }).check();
    await sidePanel.getByRole('checkbox', { name: 'Remote roles only', exact: true }).uncheck();
    await sidePanel.getByRole('slider', { name: /Minimum fit score/ }).press('ArrowRight');
    await sidePanel.getByLabel('Search name', { exact: true }).fill('Second search');
    await sidePanel
      .getByLabel('Search URL', { exact: true })
      .fill('https://app.joinhandshake.com/job-search?query=data');
    await sidePanel.getByRole('button', { name: 'Add saved search' }).click();
    await sidePanel.getByRole('button', { name: 'Use', exact: true }).click();
    const saved = sidePanel.locator('#search li').filter({ hasText: 'Second search' });
    await saved.getByRole('checkbox', { name: 'Enabled', exact: true }).uncheck();
    await saved.getByRole('checkbox', { name: 'Enabled', exact: true }).check();
    await saved.getByRole('button', { name: 'Remove Second search' }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    for (const label of ['Include keywords', 'Exclude keywords', 'Locations', 'Employment types']) {
      const input = sidePanel.getByLabel(label, { exact: true });
      await input.fill('');
      await input.pressSequentially('data, research');
      await expect(input).toHaveValue('data, research');
    }
    await sidePanel.getByLabel('Daily cap', { exact: true }).fill('15');
    // Raw timing (delays, jitter, batch, break) is no longer shown; the Speed slider
    // replaces it. The remaining limits stay editable.
    await sidePanel.getByRole('slider', { name: 'Speed', exact: true }).fill('3');
    for (const [label, value] of [
      ['Max pages per run', '2'],
      ['Max jobs per run', '25'],
      ['Hard cap', '50'],
      ['Pause after failures', '2'],
      ['Tries per job', '3'],
    ] as const)
      await sidePanel.getByLabel(label, { exact: true }).fill(value);
    await expect(
      sidePanel.getByRole('checkbox', { name: /Only run inside active hours/ }),
    ).toHaveCount(0);
    await sidePanel.getByLabel('Resume link or ID', { exact: true }).fill('document-0002');
    await sidePanel.getByLabel('Cover letter link or ID', { exact: true }).fill('document-0003');
    await sidePanel.getByLabel('Transcript link or ID', { exact: true }).fill('document-0004');
    await expect(
      sidePanel.getByText(/AI is off\. Your default resume is used for every job/),
    ).toBeVisible();
    await sidePanel.getByLabel('Theme', { exact: true }).selectOption('dark');
    await sidePanel.getByRole('switch', { name: 'Show advanced options', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sidePanel.getByText('Settings saved.', { exact: true })).toBeVisible();
    await sidePanel.reload();
    await section(sidePanel, 'Settings');
    await expect(sidePanel.getByLabel('Include keywords', { exact: true })).toHaveValue(
      'data, research',
    );
    await expect(sidePanel.getByLabel('Daily cap', { exact: true })).toHaveValue('15');
    await expect(sidePanel.getByLabel('Resume link or ID', { exact: true })).toHaveValue(
      'document-0002',
    );
    await expect(sidePanel.locator('html')).toHaveAttribute('data-theme', 'dark');

    await sidePanel.getByLabel('Question', { exact: true }).fill('Preferred working style');
    await sidePanel.getByLabel('Answer', { exact: true }).fill('Collaborative');
    await sidePanel.getByRole('button', { name: 'Add answer', exact: true }).click();
    const answer = sidePanel.locator('#answers li').filter({ hasText: 'Preferred working style' });
    await expect(answer).toBeVisible();
    await answer.getByRole('button', { name: 'Edit', exact: true }).click();
    await answer
      .getByRole('switch', { name: 'Allow autopilot to use this answer', exact: true })
      .click();
    await answer.getByLabel('Answer value', { exact: true }).fill('Independent and collaborative');
    await answer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(answer.getByText('Independent and collaborative', { exact: true })).toBeVisible();
    await answer.getByRole('button', { name: 'Delete answer Preferred working style' }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete answer', exact: true })
      .click();
    await expect(answer).toHaveCount(0);

    await sidePanel.getByLabel('Provider', { exact: true }).selectOption('heuristic');
    await sidePanel.getByRole('button', { name: 'Test provider', exact: true }).click();
    await expect(sidePanel.getByText(/Passed:/)).toBeVisible();
    await sidePanel
      .getByRole('slider', { name: 'Minimum AI confidence', exact: true })
      .press('ArrowLeft');
    await sidePanel.getByRole('button', { name: 'Discard', exact: true }).click();
    await sidePanel.evaluate(() => {
      Object.defineProperty(chrome.permissions, 'request', {
        configurable: true,
        value: async () => true,
      });
      Object.defineProperty(globalThis, 'LanguageModel', {
        configurable: true,
        value: { availability: async () => 'unavailable' },
      });
    });
    await sidePanel.getByLabel('API key', { exact: true }).fill('sk-or-v1-test-panel-key');
    await sidePanel.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(sidePanel.getByText('OpenRouter key saved', { exact: true })).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Remove key', exact: true }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Remove key', exact: true })
      .click();
    await expect(sidePanel.getByText('OpenRouter key saved', { exact: true })).toHaveCount(0);
    await expect(sidePanel.getByText(/on-device/i)).toHaveCount(0);
    await sidePanel
      .getByRole('switch', { name: 'Collect external job links (beta)', exact: true })
      .click();
    await sidePanel.getByRole('button', { name: 'Discard', exact: true }).click();
    const backupDownload = sidePanel.waitForEvent('download');
    await sidePanel
      .getByRole('button', { name: 'Export private backup (JSON)', exact: true })
      .click();
    const backup = await backupDownload;
    const backupPath = await backup.path();
    if (!backupPath) throw new Error('Backup was not downloaded');
    await sidePanel.getByLabel('Legacy or backup file', { exact: true }).setInputFiles(backupPath);
    await expect(sidePanel.getByText(/^Preview:/)).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Import this file', exact: true }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Import', exact: true })
      .click();
    await expect(sidePanel.getByText('Import finished', { exact: true })).toBeVisible();
    await sidePanel.getByLabel('Legacy or backup file', { exact: true }).setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{broken'),
    });
    await expect(sidePanel.locator('#import-export [role="alert"]')).toBeVisible();
    const csvDownload = sidePanel.waitForEvent('download');
    await sidePanel.getByRole('button', { name: 'Export applications CSV', exact: true }).click();
    expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/);

    await sidePanel.getByRole('button', { name: 'Reset local data', exact: true }).click();
    const dialog = sidePanel.getByRole('dialog', { name: 'Reset everything?' });
    await expect(
      dialog.getByRole('button', { name: 'Reset local data', exact: true }),
    ).toBeDisabled();
    await snapshot(sidePanel, `${width}-reset-confirmation`);
    await dialog.getByRole('textbox').pressSequentially('reset');
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await dialog.getByRole('button', { name: 'Reset local data', exact: true }).click();
    await expect(sidePanel.getByText('Step 1 of 6')).toBeVisible();
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

for (const width of [320, 400, 500]) {
  test(`queue filters, skip confirmation, retry and posting links work at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    await installHandshakeRoutes(context, 'search-10-jobs');
    await seedExtension(sidePanel);
    await seedRecords(sidePanel, {
      job: makeJob({ id: '10000001', title: 'Analyst internship' }),
      queueItem: makeQueueItem({ jobId: '10000001', status: 'failed' }),
    });
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    await section(sidePanel, 'Queue');
    await expect(sidePanel.getByText('Analyst internship', { exact: true })).toBeVisible();
    await expect(sidePanel.getByRole('link', { name: 'Open posting' })).toHaveAttribute(
      'href',
      /joinhandshake\.com/,
    );
    await sidePanel.getByLabel('Search the queue').fill('no match');
    await expect(sidePanel.getByText('Nothing matches this filter')).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Clear filters' }).click();
    await sidePanel.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(sidePanel.getByText('Queued to retry.', { exact: true })).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Skip', exact: true }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect.poll(async () => (await getQueue(sidePanel)).items[0]?.status).toBe('queued');
    await sidePanel.getByRole('button', { name: 'Skip', exact: true }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Skip job', exact: true })
      .click();
    await expect.poll(async () => (await getQueue(sidePanel)).items[0]?.status).toBe('skipped');
    await snapshot(sidePanel, `${width}-queue-skipped`);
    expect(pageErrors).toEqual([]);
  });
}

for (const width of [320, 400, 500]) {
  test(`Needs You validates and saves screening answers at ${width}px without submitting`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const errors = watchConsole(sidePanel);
    const mock = await installHandshakeRoutes(context, 'form-questions');
    await seedExtension(sidePanel, {
      answers: [],
      settings: { safety: { allowFreeTextAutoFill: true } },
    });
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).needs[0]?.questions.length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await section(sidePanel, 'Needs');
    await sidePanel.getByRole('button', { name: 'Save & continue', exact: true }).click();
    await expect(sidePanel.getByRole('alert')).toContainText('before continuing');
    await sidePanel
      .getByRole('textbox', { name: /why are you interested/i })
      .fill('I enjoy building useful tools with a team.');
    await sidePanel.getByRole('combobox', { name: /legally authorized/ }).selectOption('yes');
    await sidePanel.getByRole('radio', { name: /^no$/i }).check();
    await sidePanel.getByRole('checkbox', { name: /^Remember these answers/ }).check();
    await snapshot(sidePanel, `${width}-needs-answers`);
    await sidePanel.getByRole('button', { name: 'Save & continue', exact: true }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test(`Needs You rechecks missing documents at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const errors = watchConsole(sidePanel);
    const mock = await installHandshakeRoutes(context, 'form-transcript');
    await seedExtension(sidePanel, {
      settings: { documents: { transcriptId: undefined } },
    });
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).needs[0]?.missingDocumentTypes ?? [], {
        timeout: 30_000,
      })
      .toContain('transcript');
    await section(sidePanel, 'Needs');
    await snapshot(sidePanel, `${width}-needs-documents`);
    // HX-04 shares the owned runner for document collection; it navigates the
    // existing posting tab rather than creating a second automation tab.
    const documentTab = context.pages().find((page) => /\/jobs\/900001/.test(page.url()));
    if (!documentTab) throw new Error('Application runner was not open');
    await sidePanel.getByRole('button', { name: 'Save documents & continue', exact: true }).click();
    await expect(
      sidePanel.getByRole('alert').filter({ hasText: /needs a transcript/i }),
    ).toBeVisible();
    await sidePanel.getByLabel('Transcript', { exact: true }).fill('document-0004');
    await sidePanel.getByRole('button', { name: 'Save documents & continue', exact: true }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    // Recovery owns both fresh loads; no manual refresh or second runner.
    expect(context.pages().filter((page) => page.url().startsWith(mock.origin))).toEqual([
      documentTab,
    ]);
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

for (const width of [320, 400, 500]) {
  test(`dashboard run controls and activity filters work at ${width}px`, async ({
    context,
    sidePanel,
    pageErrors,
  }) => {
    const errors = watchConsole(sidePanel);
    const mock = await installHandshakeRoutes(context, 'form-two-docs');
    await seedExtension(sidePanel);
    await sidePanel.setViewportSize({ width, height: 800 });
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Show runner tab' }).click();
    await expect(sidePanel.getByText(/No Handshake tab is open yet/)).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(async () => (await getState(sidePanel)).status).toBe('paused');
    await sidePanel.getByRole('button', { name: 'Resume', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await getState(sidePanel)).status).toBe('idle');
    await section(sidePanel, 'Activity');
    await sidePanel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await sidePanel.getByLabel('Filter by level', { exact: true }).selectOption('error');
    await expect(
      sidePanel.getByText('No events match these filters', { exact: true }),
    ).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Clear filters' }).click();
    await sidePanel.getByRole('checkbox', { name: /^Live updates/ }).uncheck();
    await expect(sidePanel.getByText('Live paused', { exact: true })).toBeVisible();
    const download = sidePanel.waitForEvent('download');
    await sidePanel
      .getByRole('button', { name: 'Export shareable diagnostics', exact: true })
      .click();
    expect((await download).suggestedFilename()).toMatch(/\.json$/);
    await sidePanel.getByRole('button', { name: 'Clear', exact: true }).click();
    await sidePanel
      .getByRole('dialog')
      .getByRole('button', { name: 'Clear activity', exact: true })
      .click();
    await expect(sidePanel.getByText('No activity yet', { exact: true })).toBeVisible();
    expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('Needs You document retry submits exactly once in authorized Autopilot without page refreshes', async ({
  context,
  sidePanel,
  pageErrors,
}) => {
  const errors = watchConsole(sidePanel);
  const mock = await installHandshakeRoutes(context, 'form-transcript');
  mock.setSearchJobs([
    makeJob({
      id: '900001',
      url: mock.jobUrl('900001'),
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'transcript'],
    }),
  ]);
  await seedExtension(sidePanel, {
    settings: { mode: 'autopilot', documents: { transcriptId: undefined } },
  });
  await sidePanel.reload();
  await sidePanel.getByRole('button', { name: 'Start applying', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).needs[0]?.missingDocumentTypes ?? [], {
      timeout: 30_000,
    })
    .toContain('transcript');
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  await section(sidePanel, 'Needs');
  await sidePanel.getByRole('button', { name: 'Save documents & continue', exact: true }).click();
  await sidePanel.getByLabel('Transcript', { exact: true }).fill('document-0004');
  await sidePanel.getByRole('button', { name: 'Save documents & continue', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.applied ?? 0, { timeout: 30_000 })
    .toBe(1);
  expect((await getState(sidePanel)).todayCount).toBe(1);
  expect(mock.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(context.pages().filter((page) => page.url().startsWith(mock.origin))).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('UI_CHANGED requires an explicit Queue retry and loads the recovered page without manual refresh', async ({
  context,
  sidePanel,
  pageErrors,
}) => {
  const broken = await installHandshakeRoutes(context, 'missing-selector');
  const job = makeJob({ id: '900001', url: broken.jobUrl('900001') });
  broken.setSearchJobs([job]);
  await seedExtension(sidePanel);
  await sidePanel.reload();
  await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
  await expect
    .poll(async () => (await getState(sidePanel)).pauseReason, { timeout: 30_000 })
    .toBe('ui_changed');
  const runner = context.pages().find((page) => page.url() === broken.jobUrl('900001'));
  if (!runner) throw new Error('Runner was not open');
  await section(sidePanel, 'Needs');
  await expect(
    sidePanel.getByText(
      'Handshake changed its page. Retry here or from Queue; nothing is submitted.',
    ),
  ).toBeVisible();
  await expect(sidePanel.getByRole('button', { name: 'Retry job', exact: true })).toBeVisible();
  await expect(sidePanel.getByRole('button', { name: 'Skip job', exact: true })).toHaveCount(0);
  expect(broken.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  await broken.dispose();

  const recovered = await installHandshakeRoutes(context, 'form-two-docs');
  recovered.setSearchJobs([job]);
  await section(sidePanel, 'Queue');
  await sidePanel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect
    .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
      timeout: 30_000,
    })
    .toBe(1);
  expect(
    recovered.requestsFor('/jobs/900001').filter((request) => request.resourceType === 'document'),
  ).toHaveLength(1);
  expect(recovered.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  expect(context.pages().filter((page) => page.url().startsWith(recovered.origin))).toEqual([
    runner,
  ]);
  expect(pageErrors).toEqual([]);
});
