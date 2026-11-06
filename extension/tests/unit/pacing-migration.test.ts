import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/core/contracts';
import { loadSettings, saveSettings } from '@/core/storage/settings';
import { upgradeStoredSettings } from '@/core/storage/settings-upgrade';
import { resolvePacing } from '@/core/orchestrator/pacing-settings';

const oldPacing = {
  minDelayMs: 60_000,
  maxDelayMs: 120_000,
  jitterPercent: 10,
  dailyCap: 25,
  hardCap: 100,
  sessionBatchSize: 10,
  sessionBreakMinMs: 300_000,
  sessionBreakMaxMs: 600_000,
  activeHours: { start: '08:00', end: '22:00' },
  maxConsecutiveFailures: 3,
  maxAttemptsPerJob: 2,
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('pacing upgrade', () => {
  it('migrates unchanged old defaults to the faster preset and persists without lowering the cap', async () => {
    localStorage.setItem(
      `handshook.fallback.${STORAGE_KEYS.settings}`,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        pacing: oldPacing,
      }),
    );
    const settings = await loadSettings();
    expect(settings.pacing).toMatchObject({ speed: 4, useAdvanced: false, dailyCap: 25 });
    expect(resolvePacing(settings.pacing).minDelayMs).toBe(63_000);
    expect(await loadSettings()).toEqual(settings);
    expect(
      JSON.parse(localStorage.getItem(`handshook.fallback.${STORAGE_KEYS.settings}`) ?? '{}').pacing
        .speed,
    ).toBe(4);
  });

  it.each([
    'minDelayMs',
    'maxDelayMs',
    'jitterPercent',
    'sessionBatchSize',
    'sessionBreakMinMs',
    'sessionBreakMaxMs',
  ] as const)('retains a customized %s in advanced mode', async (key) => {
    const previous = { ...oldPacing, [key]: oldPacing[key] + 1, dailyCap: 42 };
    const upgraded = upgradeStoredSettings({ ...DEFAULT_SETTINGS, pacing: previous });
    const settings = await saveSettings(upgraded as typeof DEFAULT_SETTINGS);
    expect(settings.pacing).toMatchObject({
      ...previous,
      activeHours: null,
      speed: 4,
      useAdvanced: true,
    });
    expect(resolvePacing(settings.pacing)[key]).toBe(previous[key]);
  });

  it('preserves an existing custom cap without treating it as custom timing', () => {
    expect(upgradeStoredSettings({ pacing: { ...oldPacing, dailyCap: 7 } })).toMatchObject({
      pacing: { dailyCap: 7, speed: 4, useAdvanced: false },
    });
    expect(upgradeStoredSettings({ mode: 'review' })).toMatchObject({ pacing: { dailyCap: 25 } });
  });

  it('retains customized safety limits as advanced settings', () => {
    expect(
      upgradeStoredSettings({ pacing: { ...oldPacing, activeHours: null, maxAttemptsPerJob: 4 } }),
    ).toMatchObject({
      pacing: { useAdvanced: true, activeHours: null, maxAttemptsPerJob: 4, minDelayMs: 60_000 },
    });
  });

  it('recognizes the same old active hours regardless of JSON key order', () => {
    expect(
      upgradeStoredSettings({
        pacing: {
          ...oldPacing,
          activeHours: { end: '22:00', start: '08:00' },
        },
      }),
    ).toMatchObject({ pacing: { useAdvanced: false, speed: 4 } });
  });

  it.each([
    { start: '08:00', end: '22:00' },
    { start: '22:00', end: '06:00' },
  ])(
    'clears saved and imported windows without changing timing choices: %j',
    async (activeHours) => {
      const previous = structuredClone(DEFAULT_SETTINGS);
      previous.pacing = {
        ...previous.pacing,
        activeHours,
        speed: 5,
        useAdvanced: true,
        dailyCap: 7,
      };
      localStorage.setItem(`handshook.fallback.${STORAGE_KEYS.settings}`, JSON.stringify(previous));
      const expected = { ...previous.pacing, activeHours: null };
      expect((await loadSettings()).pacing).toEqual(expected);
      expect(
        JSON.parse(localStorage.getItem(`handshook.fallback.${STORAGE_KEYS.settings}`) ?? '{}')
          .pacing,
      ).toEqual(expected);
      expect(upgradeStoredSettings(previous)).toMatchObject({ pacing: expected });
      expect((await saveSettings(previous)).pacing).toEqual(expected);
    },
  );

  it('does not enable custom timing for a legacy schedule change alone', () => {
    expect(upgradeStoredSettings({ pacing: { ...oldPacing, activeHours: null } })).toMatchObject({
      pacing: { activeHours: null, useAdvanced: false, speed: 4 },
    });
  });

  it('only applies the lower cap to a new install and retains saved speed/custom choices', async () => {
    expect((await loadSettings()).pacing.dailyCap).toBe(15);
    const saved = structuredClone(DEFAULT_SETTINGS);
    saved.pacing.speed = 5;
    saved.pacing.useAdvanced = true;
    await saveSettings(saved);
    expect(await loadSettings()).toEqual(saved);
  });
});
