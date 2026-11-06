import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiKeys, loadSettings, saveAiKey, updateSettings } from '@/core/storage/settings';
import { createFakeBrowser } from './helpers/fakeBrowser';
import { DEFAULT_SETTINGS, parseSettings, parseUiRequest, STORAGE_KEYS } from '@/core/contracts';
import { upgradeStoredSettings } from '@/core/storage/settings-upgrade';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('credential storage isolation', () => {
  it('restricts local storage to trusted extension contexts before writing or reading keys', async () => {
    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await saveAiKey('fixture-key');
    expect(fake.storage.local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    expect(fake.storage.local.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(
      fake.storage.local.set.mock.invocationCallOrder[0] ?? 0,
    );
    expect(storage.get('handshook.ai.keys.v1')).toEqual({ openRouterApiKey: 'fixture-key' });
    expect(await loadAiKeys()).toEqual({ openRouterApiKey: 'fixture-key' });
    expect(fake.storage.local.setAccessLevel).toHaveBeenCalledTimes(2);
  });

  it('refuses key access when Chrome cannot restrict storage', async () => {
    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    fake.storage.local.setAccessLevel.mockRejectedValue(new Error('Access denied'));
    await expect(saveAiKey('fixture-key')).rejects.toThrow('Access denied');
    await expect(loadAiKeys()).rejects.toThrow('Access denied');
    expect(fake.storage.local.get).not.toHaveBeenCalled();
    expect(fake.storage.local.set).not.toHaveBeenCalled();
    expect(storage.has('handshook.ai.keys.v1')).toBe(false);
  });
});

describe('settings safety limits', () => {
  it('defaults full automation and upgrades old safety settings without data loss', async () => {
    const defaults = await loadSettings();
    expect(defaults.mode).toBe('autopilot');
    expect(defaults.safety).toEqual({
      reviewBeforeSubmit: false,
      allowOneClickApply: true,
      allowSensitiveAutoSubmit: true,
      allowEeoAutoFill: true,
      allowFreeTextAutoFill: true,
      stopOnUnknownQuestion: true,
      verifySubmissions: true,
    });
    expect(defaults.ai).toMatchObject({ enabled: true, pageAssist: true });
    expect(defaults.defaultsRevision).toBe(2);

    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const { defaultsRevision: discardedRevision, ...withoutRevision } = DEFAULT_SETTINGS;
    void discardedRevision;
    const old = {
      ...withoutRevision,
      mode: 'review',
      safety: {
        ...DEFAULT_SETTINGS.safety,
        reviewBeforeSubmit: true,
        allowOneClickApply: false,
      },
      documents: { ...DEFAULT_SETTINGS.documents, defaultResumeId: 'saved-resume' },
    };
    storage.set(STORAGE_KEYS.settings, old);
    const loaded = await loadSettings();
    expect(loaded).toMatchObject({
      mode: 'autopilot',
      safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
      documents: { defaultResumeId: 'saved-resume' },
      defaultsRevision: 2,
    });
    expect(parseSettings(upgradeStoredSettings(old))).toEqual({ ok: true, value: loaded });
  });

  it('preserves an explicit one-click opt-out across unrelated safety patches and upgrades', async () => {
    await updateSettings({ safety: { allowOneClickApply: false } });
    const parsed = parseUiRequest({
      type: 'ui.settings.update',
      requestId: 'safety-patch',
      patch: { safety: { reviewBeforeSubmit: true } },
    });
    if (!parsed.ok || parsed.value.type !== 'ui.settings.update') throw new Error('Rejected patch');
    expect(parsed.value.patch.safety).not.toHaveProperty('allowOneClickApply');
    const settings = await updateSettings(parsed.value.patch);
    expect(settings.safety.allowOneClickApply).toBe(false);
    expect(parseSettings(upgradeStoredSettings(settings))).toEqual({ ok: true, value: settings });
    expect(
      (await updateSettings({ safety: { allowOneClickApply: true } })).safety.allowOneClickApply,
    ).toBe(true);
  });

  it('rejects non-boolean one-click consent', () => {
    expect(
      parseSettings({
        ...DEFAULT_SETTINGS,
        safety: { ...DEFAULT_SETTINGS.safety, allowOneClickApply: 'yes' },
      }).ok,
    ).toBe(false);
    expect(
      parseUiRequest({
        type: 'ui.settings.update',
        requestId: 'bad',
        patch: { safety: { allowOneClickApply: 1 } },
      }).ok,
    ).toBe(false);
  });

  it('does not reset beta collection when an unrelated search patch crosses the UI schema', async () => {
    await updateSettings({ search: { collectExternalJobs: true } });
    const parsed = parseUiRequest({
      type: 'ui.settings.update',
      requestId: 'search-patch',
      patch: { search: { minFitScore: 0.3 } },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'ui.settings.update')
      throw new Error('Settings patch rejected');
    expect(parsed.value.patch.search).not.toHaveProperty('collectExternalJobs');
    expect((await updateSettings(parsed.value.patch)).search.collectExternalJobs).toBe(true);
  });
  it('defaults external-link collection to off for new settings', async () => {
    expect((await loadSettings()).search.collectExternalJobs).toBe(false);
  });

  it('upgrades missing external-link collection without losing existing choices', async () => {
    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const { collectExternalJobs: discarded, ...search } = DEFAULT_SETTINGS.search;
    void discarded;
    const old = { ...DEFAULT_SETTINGS, search: { ...search, includeKeywords: ['design'] } };
    storage.set(STORAGE_KEYS.settings, old);
    const loaded = await loadSettings();
    expect(loaded.search.collectExternalJobs).toBe(false);
    expect(loaded.search.includeKeywords).toEqual(['design']);
    expect(parseSettings(upgradeStoredSettings(old))).toEqual({ ok: true, value: loaded });
    expect(parseSettings(old)).toEqual({ ok: true, value: loaded });
  });

  it('round-trips the explicit beta collection setting and preserves it in upgrades', async () => {
    const settings = await updateSettings({ search: { collectExternalJobs: true } });
    expect((await loadSettings()).search.collectExternalJobs).toBe(true);
    expect(parseSettings(upgradeStoredSettings(settings))).toEqual({ ok: true, value: settings });
    expect(
      (await updateSettings({ search: { collectExternalJobs: false } })).search.collectExternalJobs,
    ).toBe(false);
  });

  it('rejects a non-boolean external collection setting', () => {
    expect(
      parseSettings({
        ...DEFAULT_SETTINGS,
        search: { ...DEFAULT_SETTINGS.search, collectExternalJobs: 'yes' },
      }).ok,
    ).toBe(false);
  });

  it('clamps the daily cap to the hard cap', async () => {
    const settings = await updateSettings({ pacing: { dailyCap: 40, hardCap: 60 } });

    expect(settings.pacing.dailyCap).toBe(40);
    expect(settings.pacing.hardCap).toBe(60);
  });

  it('cannot raise the hard cap above 100 through a settings update', async () => {
    const settings = await updateSettings({ pacing: { dailyCap: 500, hardCap: 500 } });

    expect(settings.pacing.hardCap).toBe(100);
    expect(settings.pacing.dailyCap).toBe(100);
    expect((await loadSettings()).pacing.hardCap).toBe(100);
  });

  it('keeps max delay at or above min delay', async () => {
    const settings = await updateSettings({ pacing: { minDelayMs: 30_000, maxDelayMs: 10_000 } });

    expect(settings.pacing.maxDelayMs).toBe(30_000);
  });
});
