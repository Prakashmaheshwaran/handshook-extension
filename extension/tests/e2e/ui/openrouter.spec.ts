import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, runnerPage, seedExtension, sendUi } from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';
import type { Settings } from '../../../src/core/contracts';

interface ChatRequest {
  model: string;
  models?: string[];
  route?: string;
  provider: { data_collection: string; zdr?: boolean; max_price?: { prompt: number } };
  messages: { role: string; content: string }[];
}

const CATALOG = [
  {
    id: 'demo-labs/sprout:free',
    name: 'Fixture Sprout',
    context_length: 32768,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['structured_outputs', 'response_format'],
  },
  {
    id: 'fictional-ai/cedar-mini',
    name: 'Fixture Cedar Mini',
    context_length: 128000,
    pricing: { prompt: '0.0000002', completion: '0.0000005' },
    supported_parameters: ['structured_outputs', 'response_format'],
  },
  {
    id: 'example-research/atlas',
    name: 'Fixture Atlas',
    context_length: 1000000,
    pricing: { prompt: '0.000002', completion: '0.000008' },
    supported_parameters: ['structured_outputs'],
    expiration_date: '2027-12-31',
  },
  {
    id: 'demo-labs/fern:free',
    name: 'Fixture Fern Plain Text',
    context_length: 8192,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: [],
  },
].map((entry) => ({
  ...entry,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
}));

async function mockOpenRouter(context: BrowserContext) {
  const chats: ChatRequest[] = [];
  const requests: string[] = [];
  await context.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url.pathname);
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-openrouter-title',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'content-type': 'application/json',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/v1/models')
      return route.fulfill({ headers, json: { data: CATALOG } });
    if (url.pathname === '/api/v1/key')
      return route.fulfill({
        headers,
        json: {
          data: {
            label: 'Fixture key',
            limit: 10,
            limit_remaining: 8,
            usage: 2,
            is_free_tier: false,
            free_model_daily_requests: { used: 8, limit: 50, remaining: 42 },
          },
        },
      });
    if (url.pathname === '/api/v1/chat/completions') {
      const body = request.postDataJSON() as ChatRequest;
      chats.push(body);
      const prompt = body.messages.map((message) => message.content).join('\n');
      const resumeId = prompt.includes('document-0002')
        ? 'document-0002'
        : (/\bid: "([^"]+)"/.exec(prompt)?.[1] ?? 'test-resume');
      return route.fulfill({
        headers,
        json: {
          id: 'fixture-response',
          model: body.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  resumeId,
                  confidence: 0.99,
                  reason: 'Fixture matching result.',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1500, completion_tokens: 200, cost: 0.0004 },
        },
      });
    }
    return route.abort();
  });
  return { chats, requests };
}

async function permissionFixture(panel: Page, worker: Worker, granted: boolean) {
  // Simulate Chrome's user-controlled grant, keeping all application RPC and
  // background permission rechecks real. Headless Chrome has no grant dialog.
  await panel.evaluate((value) => {
    Object.defineProperty(chrome.permissions, 'request', {
      configurable: true,
      value: async () => value,
    });
  }, granted);
  await worker.evaluate((value) => {
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable: true,
      value: async ({ origins }: { origins?: string[] }) =>
        origins?.includes('https://openrouter.ai/*') ? value : false,
    });
  }, granted);
}

async function settings(panel: Page) {
  await panel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
}

for (const width of [320, 400, 500]) {
  test(`OpenRouter setup, selection, test and Review matching at ${width}px`, async ({
    context,
    sidePanel,
    serviceWorker,
    pageErrors,
  }, testInfo) => {
    const errors: string[] = [];
    sidePanel.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const api = await mockOpenRouter(context);
    const handshake = await installHandshakeRoutes(context, 'form-two-docs');
    handshake.setSearchJobs([SAMPLE_JOBS[0]!]);
    const page = await context.newPage();
    await page.goto(handshake.searchUrl());
    await seedExtension(sidePanel, { settings: { mode: 'review' } });
    await sidePanel.reload();
    await sidePanel.setViewportSize({ width, height: 900 });
    await permissionFixture(sidePanel, serviceWorker, true);
    await settings(sidePanel);
    await sidePanel.getByLabel('API key', { exact: true }).fill('sk-or-v1-test-ui-only');
    await sidePanel.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(sidePanel.getByText('OpenRouter key saved', { exact: true })).toBeVisible();
    // Saving a key while AI is off must not start even a catalog request.
    expect(api.requests).toEqual([]);
    await sidePanel.getByRole('button', { name: 'Load models', exact: true }).click();
    await expect(
      sidePanel.getByRole('button', { name: 'Select Fixture Cedar Mini', exact: true }),
    ).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Check key', exact: true }).click();
    await expect(sidePanel.getByText('Key: Fixture key', { exact: true })).toBeVisible();
    await expect(sidePanel.getByText('Free requests left today: 42')).toBeVisible();
    await sidePanel.getByRole('switch', { name: 'Use AI to pick a resume', exact: true }).click();
    await sidePanel.getByLabel('Provider', { exact: true }).selectOption('openrouter');
    await expect(
      sidePanel.getByRole('switch', {
        name: 'Allow providers that may store or train on job text',
        exact: true,
      }),
    ).not.toBeChecked();
    await sidePanel.getByLabel('Search models', { exact: true }).fill('cedar-mini');
    await expect(
      sidePanel.getByRole('list', { name: 'OpenRouter models', exact: true }).getByRole('listitem'),
    ).toHaveCount(1);
    await sidePanel.getByRole('button', { name: 'Select Fixture Cedar Mini', exact: true }).click();
    await sidePanel.getByLabel('Search models', { exact: true }).fill('');
    await expect(sidePanel.getByText('Estimated match cost: about $0.0004 per job.')).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Fallback Fixture Sprout', exact: true }).click();
    await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sidePanel.getByText('Settings saved.', { exact: true })).toBeVisible();
    const saved = await sendUi<Settings>(sidePanel, {
      type: 'ui.settings.get',
      requestId: 'verify-or-settings',
    });
    expect(saved.ai.openRouter).toMatchObject({
      model: 'fictional-ai/cedar-mini',
      fallbackModels: ['demo-labs/sprout:free'],
      allowDataCollection: false,
      zeroDataRetention: false,
      maxPromptPricePerMillion: null,
    });
    await sidePanel.getByRole('button', { name: 'Test OpenRouter', exact: true }).click();
    await expect(
      sidePanel.getByText(/Passed:.*fictional-ai\/cedar-mini.*Cost: \$0\.0004/),
    ).toBeVisible();
    expect(api.chats).toHaveLength(1);
    expect(api.chats[0]).toMatchObject({
      model: 'fictional-ai/cedar-mini',
      models: ['fictional-ai/cedar-mini', 'demo-labs/sprout:free'],
      route: 'fallback',
      provider: { data_collection: 'deny' },
    });
    expect(
      await sidePanel.evaluate(() => {
        const main = document.querySelector('main');
        return main ? main.scrollWidth - main.clientWidth : 0;
      }),
    ).toBeLessThanOrEqual(1);
    await sidePanel.screenshot({ path: testInfo.outputPath(`openrouter-${width}-privacy.png`) });
    await sidePanel
      .locator('[aria-label="Selected OpenRouter model"]')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await sidePanel.screenshot({ path: testInfo.outputPath(`openrouter-${width}-models.png`) });
    await sidePanel
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    await sidePanel.getByRole('button', { name: 'Start review run', exact: true }).click();
    await expect
      .poll(async () => (await getQueue(sidePanel)).summary.counts.ready_for_review ?? 0, {
        timeout: 30000,
      })
      .toBe(1);
    expect(api.chats).toHaveLength(2);
    expect(api.chats[1]).toMatchObject({
      model: 'fictional-ai/cedar-mini',
      provider: { data_collection: 'deny' },
    });
    expect(
      api.chats[1]?.messages.some((message) => message.content.includes('document-0002')),
    ).toBe(true);
    await expect(runnerPage(context, '900001').getByTestId('document-resume')).toHaveValue(
      'document-0002',
    );
    expect(handshake.requestsFor('/jobs/900001/applications')).toHaveLength(0);
    expect(api.requests).toContain('/api/v1/models');
    expect(api.requests).toContain('/api/v1/key');
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('denied OpenRouter permission leaves the key unsaved and sends no cloud requests', async ({
  context,
  sidePanel,
  serviceWorker,
  pageErrors,
}) => {
  const api = await mockOpenRouter(context);
  await seedExtension(sidePanel);
  await sidePanel.reload();
  await permissionFixture(sidePanel, serviceWorker, false);
  await settings(sidePanel);
  await sidePanel.getByLabel('API key', { exact: true }).fill('sk-or-v1-test-denied');
  await sidePanel.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(sidePanel.getByRole('alert')).toContainText('Your key was not saved');
  const configured = await serviceWorker.evaluate(async () => {
    const keys = (await chrome.storage.local.get('handshook.ai.keys.v1'))[
      'handshook.ai.keys.v1'
    ] as { openRouterApiKey?: string } | undefined;
    return Boolean(keys?.openRouterApiKey);
  });
  expect(configured).toBe(false);
  expect(api.requests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('migration notice links from Dashboard and stays dismissed after a reload', async ({
  sidePanel,
  pageErrors,
}) => {
  await seedExtension(sidePanel);
  await sidePanel.evaluate(async () => {
    await chrome.storage.local.set({
      'handshook.ai.migration.v1': { geminiReplaced: true, notified: false },
    });
  });
  await sidePanel.reload();
  await sidePanel.getByRole('button', { name: 'Set up OpenRouter', exact: true }).click();
  await expect(sidePanel.getByText(/^Gemini support was replaced by OpenRouter/)).toBeVisible();
  await sidePanel.getByRole('button', { name: 'Dismiss migration notice', exact: true }).click();
  await expect(sidePanel.getByText(/^Gemini support was replaced by OpenRouter/)).toHaveCount(0);
  await sidePanel.reload();
  await settings(sidePanel);
  await expect(sidePanel.getByText(/^Gemini support was replaced by OpenRouter/)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
