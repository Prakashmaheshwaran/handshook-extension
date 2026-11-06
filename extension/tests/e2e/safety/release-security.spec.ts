import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, EXTENSION_BUILD_PATH, EXTENSION_ROOT } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { sendUi } from '../helpers/seed';

async function scripts(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const name = path.join(directory, entry.name);
        return entry.isDirectory() ? scripts(name) : name.endsWith('.js') ? [name] : [];
      }),
    )
  ).flat();
}

test('generated MV3 manifest grants only the reviewed release capabilities', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(EXTENSION_BUILD_PATH, 'manifest.json'), 'utf8'),
  );
  const metadata = JSON.parse(await readFile(path.join(EXTENSION_ROOT, 'package.json'), 'utf8'));
  expect(manifest).toMatchObject({
    manifest_version: 3,
    version: metadata.version,
    minimum_chrome_version: '120',
  });
  expect([...manifest.permissions].sort()).toEqual(['alarms', 'sidePanel', 'storage']);
  expect(manifest.host_permissions).toEqual([
    'https://*.joinhandshake.com/*',
    'https://joinhandshake.com/*',
    'https://*.joinhandshake.co.uk/*',
    'https://joinhandshake.co.uk/*',
  ]);
  expect(manifest.optional_host_permissions).toEqual(['https://openrouter.ai/*']);
  for (const field of [
    'content_security_policy',
    'web_accessible_resources',
    'externally_connectable',
    'optional_permissions',
  ]) {
    expect(manifest[field]).toBeUndefined();
  }
  expect(manifest.content_scripts).toHaveLength(1);
  expect([...manifest.content_scripts[0].matches].sort()).toEqual(
    [...manifest.host_permissions].sort(),
  );
});

test('generated JavaScript contains no eval or direct or aliased Function constructor', async () => {
  for (const file of await scripts(EXTENSION_BUILD_PATH)) {
    const code = await readFile(file, 'utf8');
    expect(code, path.relative(EXTENSION_BUILD_PATH, file)).not.toMatch(
      /\b(?:eval|Function)\s*\(|=\s*Function\b/,
    );
  }
});

test('a real content-script context cannot read the stored OpenRouter credential', async ({
  context,
  serviceWorker,
  sidePanel,
  extensionId,
}) => {
  const mock = await installHandshakeRoutes(context, 'search-10-jobs');
  await sendUi(sidePanel, {
    type: 'ui.ai.setKey',
    requestId: 'security-key',
    apiKey: 'fixture-key',
  });
  expect(
    await serviceWorker.evaluate(async () =>
      Boolean((await chrome.storage.local.get('handshook.ai.keys.v1'))['handshook.ai.keys.v1']),
    ),
  ).toBe(true);

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const contexts = new Set<number>();
  cdp.on('Runtime.executionContextCreated', ({ context: execution }) => {
    contexts.add(execution.id);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    contexts.delete(executionContextId),
  );
  await cdp.send('Runtime.enable');
  await page.goto(mock.searchUrl());
  let contentContext: number | undefined;
  await expect
    .poll(async () => {
      for (const contextId of contexts) {
        const result = await cdp
          .send('Runtime.evaluate', {
            contextId,
            expression: 'globalThis.chrome?.runtime?.id',
            returnByValue: true,
          })
          .catch(() => null);
        if (result?.result.value === extensionId) contentContext = contextId;
      }
      return contentContext !== undefined;
    })
    .toBe(true);
  const result = await cdp.send('Runtime.evaluate', {
    contextId: contentContext,
    expression: `(async () => {
      try {
        const values = await chrome.storage.local.get('handshook.ai.keys.v1');
        return { readable: Boolean(values['handshook.ai.keys.v1']) };
      } catch { return { readable: false, denied: true }; }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(result.result.value).toEqual({ readable: false, denied: true });
  await cdp.detach();
});

test('OpenRouter background RPCs use mocked endpoints and honor permission revocation', async ({
  context,
  serviceWorker,
  sidePanel,
}) => {
  const apiKey = 'sk-or-v1-test-e2e-only';
  const model = 'fixture/text-model';
  const requests: Array<{ pathname: string; headers: Record<string, string>; body: unknown }> = [];
  // Routing serves every provider response; offline mode also prevents escapes.
  await context.setOffline(true);
  await context.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      pathname: url.pathname,
      headers: request.headers(),
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
    });
    let payload: unknown;
    if (url.pathname === '/api/v1/models') {
      payload = {
        data: [
          {
            id: model,
            name: 'Fixture text model',
            context_length: 32768,
            pricing: { prompt: '0.0000001', completion: '0.0000002' },
            architecture: { output_modalities: ['text'] },
            supported_parameters: ['structured_outputs', 'response_format'],
          },
        ],
      };
    } else if (url.pathname === '/api/v1/key') {
      payload = {
        data: {
          label: 'Fixture key',
          limit: 10,
          limit_remaining: 9,
          usage: 1,
          is_free_tier: false,
          free_model_daily_requests: { remaining: 45 },
        },
      };
    } else if (url.pathname === '/api/v1/chat/completions') {
      payload = {
        model: 'fixture/actual-response',
        choices: [
          {
            message: {
              content: JSON.stringify({
                resumeId: 'test-resume',
                confidence: 1,
                reason: 'Relevant test experience',
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { cost: 0.00001 },
      };
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(payload),
    });
  });
  // This transport test mocks consent; production user-gesture requests are UI-owned.
  await serviceWorker.evaluate(() => {
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable: true,
      value: async () => true,
    });
  });
  await sendUi(sidePanel, { type: 'ui.ai.setKey', requestId: 'or-key', apiKey });
  await sendUi(sidePanel, {
    type: 'ui.settings.update',
    requestId: 'or-settings',
    patch: {
      ai: {
        enabled: true,
        provider: 'openrouter',
        openRouter: {
          model,
          fallbackModels: ['fixture/fallback'],
          allowDataCollection: false,
          zeroDataRetention: true,
          maxPromptPricePerMillion: 1,
        },
      },
    },
  });
  const models = await sendUi(sidePanel, {
    type: 'ui.ai.openrouter.models',
    requestId: 'or-models',
    refresh: true,
  });
  expect(models).toMatchObject({
    models: [
      {
        id: model,
        promptPricePerMillion: 0.1,
        completionPricePerMillion: 0.2,
        supportsStructuredOutputs: true,
      },
    ],
  });
  await sendUi(sidePanel, { type: 'ui.ai.openrouter.models', requestId: 'or-cached' });
  const keyInfo = await sendUi(sidePanel, {
    type: 'ui.ai.openrouter.keyInfo',
    requestId: 'or-info',
  });
  expect(keyInfo).toMatchObject({ limitRemaining: 9, freeDailyRemaining: 45 });
  const probe = await sendUi(sidePanel, {
    type: 'ui.ai.test',
    requestId: 'or-test',
    provider: 'openrouter',
  });
  expect(probe).toMatchObject({
    ok: true,
    model: 'fixture/actual-response',
    costUsd: 0.00001,
  });
  expect(requests.map((request) => request.pathname)).toEqual([
    '/api/v1/models',
    '/api/v1/key',
    '/api/v1/chat/completions',
  ]);
  for (const request of requests) {
    expect(request.headers.authorization).toBe('Bearer ' + apiKey);
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers['http-referer']).toBeUndefined();
  }
  expect(requests[2]?.body).toMatchObject({
    model,
    models: [model, 'fixture/fallback'],
    route: 'fallback',
    response_format: { type: 'json_schema', json_schema: { strict: true } },
    provider: {
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 1 },
    },
  });
  for (const result of [models, keyInfo, probe])
    expect(JSON.stringify(result)).not.toContain(apiKey);
  await serviceWorker.evaluate(() => {
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable: true,
      value: async () => false,
    });
  });
  await expect(
    sendUi(sidePanel, {
      type: 'ui.ai.openrouter.models',
      requestId: 'or-revoked',
      refresh: true,
    }),
  ).rejects.toThrow(/permission is not granted/i);
  expect(requests).toHaveLength(3);
});
