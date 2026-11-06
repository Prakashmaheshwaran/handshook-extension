import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  mergeSettings,
  parseSettings,
  parseUiRequest,
} from '@/core/contracts';
import {
  loadAiKeys,
  loadSettings,
  saveAiKey,
  updateSettings,
  hasAiMigrationNotice,
} from '@/core/storage/settings';
import {
  applyLegacyImport,
  parseLegacyFile,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from '@/core/migration';
import { handleUi } from '@/background/router';
import { resetDb } from '@/core/storage/db';
import { createFakeBrowser } from './helpers/fakeBrowser';
import { KEY, MODEL, ROUTING } from './helpers/openrouter';

let storage: Map<string, unknown>;
beforeEach(async () => {
  const browser = createFakeBrowser();
  storage = browser.storage;
  vi.stubGlobal('browser', browser.fake);
  localStorage.clear();
  await resetDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function legacySettings() {
  return {
    ...DEFAULT_SETTINGS,
    ai: {
      enabled: true,
      provider: 'gemini',
      minConfidence: 0.75,
      nanoOptIn: true,
    },
  };
}

describe('OpenRouter contracts', () => {
  it('preselects DeepSeek V4.1 Flash without extra billing or privacy consent', () => {
    expect(DEFAULT_SETTINGS.ai.openRouter).toEqual({
      model: DEFAULT_OPENROUTER_MODEL,
      fallbackModels: [],
      allowDataCollection: false,
      zeroDataRetention: false,
      maxPromptPricePerMillion: null,
    });
    expect(DEFAULT_OPENROUTER_MODEL).toBe('deepseek/deepseek-v4.1-flash');
    expect(DEFAULT_SETTINGS.ai).toMatchObject({ enabled: true, pageAssist: true });
    expect(parseSettings(DEFAULT_SETTINGS).ok).toBe(true);
  });
  it.each([
    { fallbackModels: [MODEL] },
    { fallbackModels: ['fixture/fallback', 'fixture/fallback'] },
    { fallbackModels: ['fixture/one', 'fixture/two', 'fixture/three'] },
    { fallbackModels: ['  '] },
    { maxPromptPricePerMillion: -1 },
    { maxPromptPricePerMillion: Infinity },
    { model: '' },
  ])('rejects invalid routing settings', async (patch) => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      ai: { openRouter: { ...ROUTING, ...patch } },
    });
    expect(parseSettings(settings).ok).toBe(false);
  });
  it('accepts free variants and a zero-dollar price ceiling', () => {
    expect(
      parseSettings(
        mergeSettings(DEFAULT_SETTINGS, {
          ai: {
            provider: 'openrouter',
            openRouter: { ...ROUTING, model: 'fixture/model:free', maxPromptPricePerMillion: 0 },
          },
        }),
      ).ok,
    ).toBe(true);
  });
  it.each([
    { type: 'ui.ai.openrouter.models', refresh: true },
    { type: 'ui.ai.openrouter.models' },
    { type: 'ui.ai.openrouter.keyInfo' },
    { type: 'ui.ai.dismissMigrationNotice' },
    { type: 'ui.ai.test', provider: 'openrouter' },
  ])('validates the new panel request %s', (request) => {
    expect(parseUiRequest({ ...request, requestId: 'request' }).ok).toBe(true);
  });
  it.each([
    { type: 'ui.ai.openrouter.models', refresh: 'true' },
    { type: 'ui.ai.test', provider: 'gemini' },
    { type: 'ui.ai.setKey', apiKey: '   ' },
    { type: 'ui.ai.setKey', apiKey: 'key with spaces' },
  ])('rejects malformed AI requests', (request) => {
    expect(parseUiRequest({ ...request, requestId: 'request' }).ok).toBe(false);
  });
  it('trims keys at the message boundary and does not reject unusual prefixes', async () => {
    expect(
      parseUiRequest({ type: 'ui.ai.setKey', requestId: 'trim', apiKey: '  fixture-key  ' }),
    ).toMatchObject({
      ok: true,
      value: { apiKey: 'fixture-key' },
    });
    await saveAiKey('  fixture-key  ');
    expect(await loadAiKeys()).toEqual({ openRouterApiKey: 'fixture-key' });
    await expect(saveAiKey('  ')).rejects.toThrow(/without whitespace/i);
    await expect(saveAiKey('fixture key')).rejects.toThrow(/without whitespace/i);
  });
});

describe('legacy cloud settings and credentials', () => {
  it('maps a stored Gemini provider, deletes its key, fills defaults and records a one-time notice', async () => {
    storage.set(STORAGE_KEYS.settings, legacySettings());
    storage.set(STORAGE_KEYS.aiKeys, { geminiApiKey: 'legacy-deleted-test-key' });
    const settings = await loadSettings();
    expect(settings.ai).toEqual({
      ...DEFAULT_SETTINGS.ai,
      enabled: true,
      provider: 'openrouter',
      minConfidence: 0.75,
    });
    expect(settings.ai).not.toHaveProperty('nanoOptIn');
    expect(await loadAiKeys()).toEqual({});
    expect(JSON.stringify(storage.get(STORAGE_KEYS.settings))).not.toContain(
      'legacy-deleted-test-key',
    );
    expect(storage.get(STORAGE_KEYS.aiKeys)).toEqual({});
    expect(storage.get(STORAGE_KEYS.aiMigration)).toEqual({
      geminiReplaced: true,
      notified: false,
    });
    expect(await handleUi({ type: 'ui.ai.status', requestId: 'notice' })).toMatchObject({
      data: { geminiReplacedNotice: true },
    });
    expect(
      await handleUi({ type: 'ui.ai.dismissMigrationNotice', requestId: 'dismiss' }),
    ).toMatchObject({ ok: true, data: { dismissed: true } });
    expect(storage.get(STORAGE_KEYS.aiMigration)).toEqual({ geminiReplaced: true, notified: true });
    await loadSettings();
    expect(await hasAiMigrationNotice()).toBe(false);
  });
  it('removes legacy keys without deleting an already configured OpenRouter key', async () => {
    storage.set(STORAGE_KEYS.aiKeys, {
      geminiApiKey: 'legacy-deleted-test-key',
      openRouterApiKey: KEY,
    });
    expect(await loadAiKeys()).toEqual({ openRouterApiKey: KEY });
    expect(storage.get(STORAGE_KEYS.aiKeys)).toEqual({ openRouterApiKey: KEY });
    expect(await hasAiMigrationNotice()).toBe(true);
  });
  it('detects an old key even when settings are absent', async () => {
    storage.set(STORAGE_KEYS.aiKeys, { geminiApiKey: 'legacy-deleted-test-key' });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await hasAiMigrationNotice()).toBe(true);
  });
  it('records the migration when Save replaces an old key before settings are loaded', async () => {
    storage.set(STORAGE_KEYS.aiKeys, { geminiApiKey: 'legacy-deleted-test-key' });
    await saveAiKey(KEY);
    expect(storage.get(STORAGE_KEYS.aiKeys)).toEqual({ openRouterApiKey: KEY });
    expect(await hasAiMigrationNotice()).toBe(true);
  });
  it('preserves preexisting preferences when new settings are missing', async () => {
    const old = legacySettings();
    old.ai.provider = 'auto';
    storage.set(STORAGE_KEYS.settings, old);
    expect((await loadSettings()).ai).toMatchObject({
      provider: 'auto',
      minConfidence: 0.75,
      openRouter: DEFAULT_SETTINGS.ai.openRouter,
    });
    expect(await hasAiMigrationNotice()).toBe(false);
  });
  it('imports old backups cleanly and never restores credentials', async () => {
    storage.set(STORAGE_KEYS.aiKeys, { geminiApiKey: 'legacy-deleted-test-key' });
    const parsed = parseLegacyFile(
      'backup',
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        settings: legacySettings(),
        aiKeys: {
          geminiApiKey: 'legacy-deleted-test-key',
          openRouterApiKey: 'sk-or-do-not-import',
        },
        answers: [],
        documents: [],
        jobs: [],
        tracker: [],
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        kind: 'backup',
        geminiReplaced: true,
        settings: { ai: { provider: 'openrouter', openRouter: DEFAULT_SETTINGS.ai.openRouter } },
      },
    });
    if (!parsed.ok) throw new Error('Invalid backup fixture');
    expect(JSON.stringify(parsed.value)).not.toContain('legacy-deleted-test-key');
    expect(JSON.stringify(parsed.value)).not.toContain('sk-or-do-not-import');
    expect((await applyLegacyImport(parsed.value)).ok).toBe(true);
    expect(storage.get(STORAGE_KEYS.aiKeys)).toEqual({});
    expect(await loadAiKeys()).toEqual({});
    expect((await loadSettings()).ai.provider).toBe('openrouter');
    expect(await hasAiMigrationNotice()).toBe(true);
  });
  it('never turns the notice back on after a dismissed user imports another old backup', async () => {
    storage.set(STORAGE_KEYS.aiMigration, { geminiReplaced: true, notified: true });
    storage.set(STORAGE_KEYS.settings, legacySettings());
    await loadSettings();
    expect(await hasAiMigrationNotice()).toBe(false);
  });
  it('retains the selected model when an unrelated AI preference changes', async () => {
    await updateSettings({ ai: { openRouter: ROUTING } });
    expect((await updateSettings({ ai: { minConfidence: 0.8 } })).ai.openRouter).toEqual(ROUTING);
  });
});
