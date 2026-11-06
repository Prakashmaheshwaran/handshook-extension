import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  parseSettings,
  type Settings,
} from '@/core/contracts';
import { resetDb } from '@/core/storage/db';
import { upgradeStoredSettings } from '@/core/storage/settings-upgrade';
import { loadOnboarding, loadSettings, updateSettings } from '@/core/storage/settings';
import { createFakeBrowser } from './helpers/fakeBrowser';

beforeEach(async () => {
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('storage upgrade from a previous shape', () => {
  it('keeps valid old settings and fills fields added later', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await fake.storage.local.set({
      [STORAGE_KEYS.settings]: {
        // Previous shape: no host/ui/safety, and search lacks newer fields.
        schemaVersion: 1,
        mode: 'autopilot',
        onboardingComplete: true,
        search: { includeKeywords: ['data'], maxPagesPerRun: 2 },
      },
    });

    const settings = await loadSettings();

    expect(settings.mode).toBe('autopilot');
    expect(settings.onboardingComplete).toBe(true);
    expect(settings.search.includeKeywords).toEqual(['data']);
    expect(settings.search.maxPagesPerRun).toBe(2);
    // Fields added after the old shape come from defaults.
    expect(settings.host).toBe(DEFAULT_SETTINGS.host);
    expect(settings.safety).toEqual(DEFAULT_SETTINGS.safety);
    expect(settings.ui).toEqual(DEFAULT_SETTINGS.ui);
    expect(settings.search.employmentTypes).toEqual([]);
  });

  it('upgrades an onboarding record that predates session fields', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await fake.storage.local.set({
      [STORAGE_KEYS.onboarding]: { version: 1, step: 'documents' },
    });

    await expect(loadOnboarding()).resolves.toMatchObject({
      step: 'documents',
      sessionStatus: 'unknown',
    });
  });

  it('still falls back to defaults for a corrupt settings object', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await fake.storage.local.set({
      [STORAGE_KEYS.settings]: { mode: 'not-a-mode', pacing: 'broken' },
    });

    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('retired on-device AI settings', () => {
  it('maps a stored nano provider to auto and drops the opt-in', () => {
    const upgraded = upgradeStoredSettings({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, provider: 'nano', nanoOptIn: true },
    });
    expect(upgraded).toMatchObject({ ai: { provider: 'auto' } });
    expect((upgraded as Settings).ai).not.toHaveProperty('nanoOptIn');
    expect(parseSettings(upgraded).ok).toBe(true);
  });

  it('drops the retired AI resume allow-list without resetting document fields', () => {
    const upgraded = upgradeStoredSettings({
      ...DEFAULT_SETTINGS,
      documents: {
        ...DEFAULT_SETTINGS.documents,
        defaultResumeId: 'doc-1',
        defaultResumeName: 'Main Resume',
        coverLetterId: 'doc-2',
        additionalResumes: [{ id: 'doc-3', name: 'Extra Resume' }],
        aiResumeIds: ['doc-9'],
      },
    });
    expect(parseSettings(upgraded)).toMatchObject({
      ok: true,
      value: {
        documents: {
          defaultResumeId: 'doc-1',
          defaultResumeName: 'Main Resume',
          coverLetterId: 'doc-2',
          additionalResumes: [{ id: 'doc-3', name: 'Extra Resume' }],
        },
      },
    });
    expect((upgraded as Settings).documents).not.toHaveProperty('aiResumeIds');
  });
});

describe('revision 2 full-automation defaults', () => {
  /** An install saved before revision 2: Review mode, conservative switches, no revision. */
  function preRevisionTwo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { defaultsRevision: discardedRevision, ...base } = DEFAULT_SETTINGS;
    void discardedRevision;
    return {
      ...base,
      mode: 'review',
      safety: {
        ...DEFAULT_SETTINGS.safety,
        reviewBeforeSubmit: true,
        allowOneClickApply: false,
        allowSensitiveAutoSubmit: false,
        allowEeoAutoFill: false,
        allowFreeTextAutoFill: false,
      },
      ai: { ...DEFAULT_SETTINGS.ai, enabled: false, pageAssist: false },
      ...overrides,
    };
  }

  function upgradedSettings(raw: Record<string, unknown>): Settings {
    const parsed = parseSettings(upgradeStoredSettings(raw));
    if (!parsed.ok) throw new Error(`Upgrade produced invalid settings: ${parsed.error.message}`);
    return parsed.value;
  }

  it('turns Review into Autopilot and switches automation on once', () => {
    const upgraded = upgradedSettings(preRevisionTwo());
    expect(upgraded.mode).toBe('autopilot');
    expect(upgraded.defaultsRevision).toBe(2);
    expect(upgraded.safety).toEqual({
      reviewBeforeSubmit: false,
      allowOneClickApply: true,
      allowSensitiveAutoSubmit: true,
      allowEeoAutoFill: true,
      allowFreeTextAutoFill: true,
      stopOnUnknownQuestion: true,
      verifySubmissions: true,
    });
    expect(upgraded.ai).toMatchObject({ enabled: true, pageAssist: true });
  });

  it('leaves an explicit Dry run alone', () => {
    expect(upgradedSettings(preRevisionTwo({ mode: 'dry_run' })).mode).toBe('dry_run');
  });

  it('preselects DeepSeek only when no model was chosen', () => {
    const chosen = upgradedSettings(
      preRevisionTwo({
        ai: {
          ...DEFAULT_SETTINGS.ai,
          openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: 'fixture/custom-model' },
        },
      }),
    );
    expect(chosen.ai.openRouter.model).toBe('fixture/custom-model');

    const unchosen = upgradedSettings(
      preRevisionTwo({
        ai: {
          ...DEFAULT_SETTINGS.ai,
          openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: null },
        },
      }),
    );
    expect(unchosen.ai.openRouter.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it('does not break validation when DeepSeek is already a fallback', () => {
    const upgraded = upgradedSettings(
      preRevisionTwo({
        ai: {
          ...DEFAULT_SETTINGS.ai,
          openRouter: {
            ...DEFAULT_SETTINGS.ai.openRouter,
            model: null,
            fallbackModels: [DEFAULT_OPENROUTER_MODEL],
          },
        },
      }),
    );
    expect(upgraded.ai.openRouter.model).toBeNull();
    expect(upgraded.ai.openRouter.fallbackModels).toEqual([DEFAULT_OPENROUTER_MODEL]);
  });

  it('is a no-op when the stored defaults revision is already 2', () => {
    const once = upgradeStoredSettings(preRevisionTwo()) as Record<string, unknown>;
    expect(upgradeStoredSettings(once)).toEqual(once);
  });

  it('keeps a later explicit Review choice when the settings are loaded again', async () => {
    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    storage.set(STORAGE_KEYS.settings, preRevisionTwo());
    expect((await loadSettings()).mode).toBe('autopilot');
    expect((await updateSettings({ mode: 'review' })).mode).toBe('review');
    const reloaded = await loadSettings();
    expect(reloaded.mode).toBe('review');
    expect(reloaded.defaultsRevision).toBe(2);
    expect(reloaded.safety.reviewBeforeSubmit).toBe(false);
  });
});

describe('stored document rows', () => {
  it('drops invalid additional resumes instead of resetting every setting', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await fake.storage.local.set({
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        mode: 'autopilot',
        documents: {
          ...DEFAULT_SETTINGS.documents,
          defaultResumeId: 'doc-1',
          additionalResumes: [
            { id: 'doc-2', name: 'Good Resume' },
            { id: '', name: 'Missing id' },
            { id: 'doc-3' },
            'junk',
          ],
        },
      },
    });

    const settings = await loadSettings();
    expect(settings.mode).toBe('autopilot');
    expect(settings.documents.defaultResumeId).toBe('doc-1');
    expect(settings.documents.additionalResumes).toEqual([{ id: 'doc-2', name: 'Good Resume' }]);
  });

  it('caps a stored additional-resume list at the contract limit', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `doc-${index}`,
      name: `Resume ${index}`,
    }));
    const upgraded = upgradeStoredSettings({
      ...DEFAULT_SETTINGS,
      documents: { ...DEFAULT_SETTINGS.documents, additionalResumes: rows },
    });
    expect(parseSettings(upgraded).ok).toBe(true);
    expect((upgraded as Settings).documents.additionalResumes).toHaveLength(5);
  });
});
