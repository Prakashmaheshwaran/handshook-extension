import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  mergeSettings,
  type OpenRouterModelSummary,
  type Settings,
} from '@/core/contracts';
import { makeEngineState, makeSettings } from '@/test/factories';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { useAiStatus, type AiController } from '@/ui/hooks/useAiStatus';
import { AiSection, AI_MIGRATION_NOTICE } from '@/ui/screens/Settings/AiSection';
import { requestOpenRouterHostPermission } from '@/ui/screens/Settings/aiRuntime';
import { formatUsd, jobCostHint, modelPrice } from '@/ui/screens/Settings/openRouterModels';

vi.mock('@/ui/hooks/useAiStatus');
vi.mock('@/ui/screens/Settings/aiRuntime', () => ({
  requestOpenRouterHostPermission: vi.fn(async () => 'granted'),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function model(
  id: string,
  overrides: Partial<OpenRouterModelSummary> = {},
): OpenRouterModelSummary {
  return {
    id: `demo/${id}`,
    name: id,
    contextLength: 32000,
    promptPricePerMillion: 0.2,
    completionPricePerMillion: 0.5,
    isFree: false,
    supportsStructuredOutputs: true,
    supportsResponseFormat: true,
    expirationDate: null,
    ...overrides,
  };
}
const MODELS = [
  model('Cedar'),
  model('Sprout', { isFree: true, promptPricePerMillion: 0, completionPricePerMillion: 0 }),
  model('Atlas', {
    promptPricePerMillion: 2,
    completionPricePerMillion: 8,
    contextLength: 1000000,
    expirationDate: '2027-12-31',
  }),
  model('Fern', {
    isFree: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    supportsStructuredOutputs: false,
  }),
  model('Unknown', {
    promptPricePerMillion: null,
    completionPricePerMillion: null,
    contextLength: null,
  }),
];
let container: HTMLDivElement;
let root: Root;
let controller: AiController;
let app: AppContextValue;
let latest: Settings;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('granted');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = makeSettings({
    ai: {
      enabled: true,
      provider: 'openrouter',
      openRouter: { ...makeSettings().ai.openRouter, model: 'demo/Cedar' },
    },
  });
  app = {
    engine: makeEngineState(),
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    settings: latest,
    settingsLoading: false,
    settingsError: null,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn(),
    applySettings: vi.fn(),
    view: 'settings',
    navigate: vi.fn(),
    notify: vi.fn(),
    bridgeMode: 'live',
    version: 'test',
  };
  controller = {
    status: {
      enabled: true,
      provider: 'openrouter',
      openRouterConfigured: true,
      openRouterPermission: 'granted',
      geminiReplacedNotice: false,
    },
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    saveKey: vi.fn(async () => null),
    clearKey: vi.fn(async () => null),
    test: vi.fn(async () => ({
      provider: 'openrouter' as const,
      ok: true,
      message: 'Connected',
      model: 'demo/Cedar',
      costUsd: 0.0004,
    })),
    loadModels: vi.fn(async () => ({ models: MODELS, fetchedAt: 0 })),
    keyInfo: vi.fn(async () => ({
      label: 'Test key',
      limit: 10,
      limitRemaining: 8,
      usage: 2,
      isFreeTier: false,
      freeDailyRemaining: 42,
    })),
    dismissMigrationNotice: vi.fn(async () => null),
  };
  vi.mocked(useAiStatus).mockImplementation(() => controller);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness() {
  const [draft, setDraft] = useState(latest);
  return (
    <AppContext.Provider value={app}>
      <AiSection
        draft={draft}
        onChange={(patch) => {
          latest = mergeSettings(draft, patch);
          setDraft(latest);
        }}
      />
    </AppContext.Provider>
  );
}
async function render() {
  await act(async () => root.render(<Harness />));
}
function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (node) => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
function field(name: string): HTMLInputElement | HTMLSelectElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent === name,
  );
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement))
    throw new Error(`Missing field: ${name}`);
  return control;
}
async function fill(name: string, value: string) {
  const control = field(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
function toggle(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
    (node) =>
      document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === name,
  );
  if (!found) throw new Error(`Missing switch: ${name}`);
  return found;
}
async function switchValue(name: string) {
  await act(async () => toggle(name).click());
}
function rows(): string[] {
  return Array.from(
    container.querySelectorAll('[aria-label="OpenRouter models"] > li > p:first-child'),
  ).map((node) => node.textContent ?? '');
}

describe('OpenRouter settings', () => {
  it('autoloads only with a key and permission, keeps the selected price visible, and defaults to structured models', async () => {
    await render();
    expect(controller.loadModels).toHaveBeenCalledOnce();
    expect(requestOpenRouterHostPermission).not.toHaveBeenCalled();
    expect(rows()).toEqual(['Sprout', 'Cedar', 'Atlas', 'Unknown']);
    expect(toggle('Structured output only').getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('about $0.0004 per job');
    expect(container.textContent).toContain('$0.20 input / $0.50 output per 1M tokens');
    expect(container.textContent).toContain('expires 2027-12-31');
    expect(container.querySelector('a')?.getAttribute('rel')).toContain('noopener');
    expect(container.querySelector('a')?.target).toBe('_blank');
  });

  it('searches names and IDs without hiding the selected model summary', async () => {
    await render();
    await fill('Search models', 'DEMO/ATLAS');
    expect(rows()).toEqual(['Atlas']);
    expect(
      container.querySelector('[aria-label="Selected OpenRouter model"]')?.textContent,
    ).toContain('Cedar');
    await fill('Search models', 'no matches');
    expect(rows()).toEqual([]);
    expect(container.textContent).toContain('0 models match');
  });

  it('combines free and structured filters and estimates a free match', async () => {
    await render();
    await switchValue('Free only');
    expect(rows()).toEqual(['Sprout']);
    await switchValue('Structured output only');
    expect(rows()).toEqual(['Fern', 'Sprout']);
    await click('Select Sprout');
    expect(latest.ai.openRouter.model).toBe('demo/Sprout');
    expect(container.textContent).toContain('Estimated match cost: free.');
  });

  it('sorts by context, name and price with unknown prices last', async () => {
    await render();
    await fill('Sort models', 'context');
    expect(rows()[0]).toBe('Atlas');
    await fill('Sort models', 'name');
    expect(rows()).toEqual(['Atlas', 'Cedar', 'Sprout', 'Unknown']);
    await fill('Sort models', 'price');
    expect(rows()).toEqual(['Sprout', 'Cedar', 'Atlas', 'Unknown']);
  });

  it('caps fallbacks at two, preserves their order and removes a selected primary from them', async () => {
    await render();
    await click('Fallback Sprout');
    await click('Fallback Atlas');
    expect(latest.ai.openRouter.fallbackModels).toEqual(['demo/Sprout', 'demo/Atlas']);
    expect(button('Fallback Unknown').disabled).toBe(true);
    expect(button('Fallback Cedar').disabled).toBe(true);
    await click('Select Sprout');
    expect(latest.ai.openRouter.fallbackModels).toEqual(['demo/Atlas']);
    await click('Remove fallback Atlas');
    expect(latest.ai.openRouter.fallbackModels).toEqual([]);
    expect(container.textContent).toContain('Fallbacks may cost more');
  });

  it('renders at most fifty catalog rows until Show more is clicked', async () => {
    vi.mocked(controller.loadModels).mockResolvedValue({
      models: Array.from({ length: 125 }, (_, i) => model(`Model ${i}`)),
      fetchedAt: 0,
    });
    await render();
    expect(rows()).toHaveLength(50);
    await click('Show more');
    expect(rows()).toHaveLength(100);
    await fill('Search models', 'Model 124');
    expect(rows()).toEqual(['Model 124']);
  });

  it.each([
    [false, 'openrouter'],
    [true, 'heuristic'],
  ] as const)(
    'does not autoload when matching is %s with provider %s',
    async (enabled, provider) => {
      if (!controller.status) throw new Error('Missing status fixture');
      controller.status.enabled = enabled;
      controller.status.provider = provider;
      await render();
      expect(controller.loadModels).not.toHaveBeenCalled();
      await click('Load models');
      expect(controller.loadModels).toHaveBeenCalledOnce();
    },
  );

  it('renders hostile catalog names and IDs as text, never HTML', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    vi.mocked(controller.loadModels).mockResolvedValue({
      models: [model('hostile', { id: hostile, name: hostile })],
      fetchedAt: 0,
    });
    await render();
    expect(rows()).toEqual([hostile]);
    expect(container.querySelector('img, script')).toBeNull();
    await click(`Select ${hostile}`);
    expect(latest.ai.openRouter.model).toBe(hostile);
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('keeps huge finite prices finite and invalid prices out of the display', () => {
    const huge = model('huge', {
      promptPricePerMillion: 1e307,
      completionPricePerMillion: 1e307,
    });
    expect(jobCostHint(huge)).not.toMatch(/NaN|Infinity|∞/);
    expect(jobCostHint(huge).length).toBeLessThan(50);
    for (const value of [NaN, Infinity, -1]) {
      expect(formatUsd(value)).toBe('unknown');
      const invalid = model('invalid', { promptPricePerMillion: value });
      expect(modelPrice(invalid)).toContain('unknown');
      expect(jobCostHint(invalid)).toBe('cost unavailable');
    }
  });

  it('blocks key storage on permission denial and preserves the editable key', async () => {
    vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('denied');
    await render();
    await fill('API key', 'sk-or-v1-test-key');
    await click('Save key');
    expect(controller.saveKey).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your key was not saved');
    expect(field('API key').value).toBe('sk-or-v1-test-key');
  });

  it('requests permission before saving a trimmed password field and then clears the field', async () => {
    await render();
    await fill('API key', '  sk-or-v1-test-key  ');
    await click('Save key');
    expect(controller.saveKey).toHaveBeenCalledWith('sk-or-v1-test-key');
    expect(vi.mocked(requestOpenRouterHostPermission).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(controller.saveKey).mock.invocationCallOrder[0] ?? 0,
    );
    expect(field('API key').value).toBe('');
    expect(field('API key').type).toBe('password');
  });

  it('warns about an unusual key prefix without rejecting it', async () => {
    await render();
    await fill('API key', 'test-unusual-prefix');
    await click('Save key');
    expect(controller.saveKey).toHaveBeenCalledWith('test-unusual-prefix');
    expect(container.textContent).toContain('usually start with sk-or-');
  });

  it('announces save errors and rejects blank or internally spaced keys', async () => {
    vi.mocked(controller.saveKey).mockResolvedValue(appError('NETWORK', 'Could not save key'));
    await render();
    expect(button('Save key').disabled).toBe(true);
    await fill('API key', 'sk-or invalid');
    expect(button('Save key').disabled).toBe(true);
    await fill('API key', 'sk-or-v1-test-key');
    await click('Save key');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save key');
  });

  it('checks the key and shows credits, label and daily free requests', async () => {
    await render();
    await click('Check key');
    expect(container.textContent).toContain('Key: Test key');
    expect(container.textContent).toContain('Credits remaining: $8.00 / limit: $10.00');
    expect(container.textContent).toContain('Free requests left today: 42');
  });

  it('shows free tier and unknown daily usage without inventing a quota', async () => {
    vi.mocked(controller.keyInfo).mockResolvedValue({
      label: 'Free key',
      limit: null,
      limitRemaining: null,
      usage: 0,
      isFreeTier: true,
      freeDailyRemaining: null,
    });
    await render();
    await click('Check key');
    expect(container.textContent).toContain('Free tier');
    expect(container.textContent).toContain('Free requests left today: not reported');
  });

  it('shows actionable check-key failures', async () => {
    vi.mocked(controller.keyInfo).mockResolvedValue(
      appError('NETWORK', 'OpenRouter key is invalid. Replace it.'),
    );
    await render();
    await click('Check key');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Replace it.');
  });

  it('requires confirmation for removal and clears key diagnostics after removing', async () => {
    await render();
    await click('Check key');
    await click('Remove key');
    expect(controller.clearKey).not.toHaveBeenCalled();
    const confirm = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((node) => node.textContent?.trim() === 'Remove key');
    await act(async () => confirm?.click());
    expect(controller.clearKey).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Key: Test key');
  });

  it('shows the responding model and actual cost after a successful test', async () => {
    await render();
    await click('Test OpenRouter');
    expect(controller.test).toHaveBeenCalledWith('openrouter');
    expect(container.textContent).toContain('Model: demo/Cedar. Cost: $0.0004.');
  });

  it('blocks a test on permission denial', async () => {
    await render();
    vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('denied');
    await click('Test OpenRouter');
    expect(controller.test).not.toHaveBeenCalled();
    expect(container.textContent).toContain('No request was sent.');
  });

  it('requires saving changed model and privacy settings before testing', async () => {
    await render();
    await click('Select Atlas');
    await click('Test OpenRouter');
    expect(controller.test).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Save settings before testing');
  });

  it('renders provider failure messages from both test results and status', async () => {
    if (controller.status)
      controller.status.openRouterMessage = 'Privacy settings exclude all providers of this model.';
    vi.mocked(controller.test).mockResolvedValue({
      provider: 'openrouter',
      ok: false,
      message: 'Out of credits. Add credits on OpenRouter.',
    });
    await render();
    await click('Test OpenRouter');
    expect(container.textContent).toContain('Privacy settings exclude all providers');
    expect(container.textContent).toContain('Out of credits');
  });

  it('defaults privacy controls off, supports a zero price cap and clearing the cap', async () => {
    await render();
    expect(
      toggle('Allow providers that may store or train on job text').getAttribute('aria-checked'),
    ).toBe('false');
    expect(toggle('Zero-data-retention providers only').getAttribute('aria-checked')).toBe('false');
    await switchValue('Allow providers that may store or train on job text');
    await switchValue('Zero-data-retention providers only');
    await fill('Max input price per 1M tokens', '0');
    expect(latest.ai.openRouter.maxPromptPricePerMillion).toBe(0);
    await fill('Max input price per 1M tokens', '');
    expect(latest.ai.openRouter.maxPromptPricePerMillion).toBeNull();
    expect(latest.ai.openRouter.allowDataCollection).toBe(true);
    expect(latest.ai.openRouter.zeroDataRetention).toBe(true);
    expect(container.textContent).toContain(
      "If you choose OpenRouter, Handshook sends the job's title and description plus your resume names and IDs to OpenRouter, which forwards them to the model provider you picked.",
    );
  });

  it('shows and dismisses the migration notice through the RPC controller', async () => {
    if (controller.status) controller.status.geminiReplacedNotice = true;
    vi.mocked(controller.dismissMigrationNotice).mockImplementation(async () => {
      if (controller.status) controller.status.geminiReplacedNotice = false;
      return null;
    });
    await render();
    expect(container.textContent).toContain(AI_MIGRATION_NOTICE);
    await click('Dismiss migration notice');
    expect(controller.dismissMigrationNotice).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(AI_MIGRATION_NOTICE);
  });

  it('does not autoload without permission and explains a denied catalog request', async () => {
    if (controller.status) controller.status.openRouterPermission = 'not_granted';
    vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('denied');
    await render();
    expect(controller.loadModels).not.toHaveBeenCalled();
    await click('Load models');
    expect(controller.loadModels).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Allow access to load models');
  });

  it('recovers from model-list errors and refreshes explicitly', async () => {
    vi.mocked(controller.loadModels).mockResolvedValueOnce(
      appError('NETWORK', 'Catalog unavailable. Try again.'),
    );
    await render();
    expect(container.textContent).toContain('Catalog unavailable');
    await click('Load models');
    expect(rows()).toHaveLength(4);
    await click('Refresh');
    expect(controller.loadModels).toHaveBeenLastCalledWith(true);
  });

  it('does not turn unknown pricing into free matching', () => {
    expect(jobCostHint(model('Unknown', { promptPricePerMillion: null }))).toBe('cost unavailable');
  });
});
