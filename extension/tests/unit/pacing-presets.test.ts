import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  PACING_PRESETS,
  describePacingRate,
  estimateAppsPerHour,
  formatPacingRate,
  type PacingSpeed,
} from '@/core/contracts';
import { resolvePacing } from '@/core/orchestrator/pacing-settings';
import { createPacer } from '@/core/orchestrator/pacer';
import { makeSettings } from '@/test/factories';

/** Product targets the presets must stay inside (applications per hour). */
const TARGET_RATES: Record<PacingSpeed, readonly [number, number]> = {
  1: [6, 10],
  2: [12, 18],
  3: [20, 30],
  4: [32, 40],
  5: [100, 130],
};

describe('speed presets', () => {
  it.each([1, 2, 3, 4, 5] as PacingSpeed[])('derives all timing knobs for speed %s', (speed) => {
    const pacing = resolvePacing(
      makeSettings({
        pacing: {
          speed,
          useAdvanced: false,
          minDelayMs: 10_000,
          scanDelayMinMs: 0,
          dailyCap: 37,
          hardCap: 60,
          activeHours: null,
        },
      }).pacing,
    );
    const { label, description, ...timings } = PACING_PRESETS[speed];
    expect(label).toBeTruthy();
    expect(description).toContain('per hour');
    expect(pacing).toMatchObject(timings);
    expect(pacing).toMatchObject({ dailyCap: 37, hardCap: 60, activeHours: null });
  });

  it.each([1, 2, 3, 4, 5] as PacingSpeed[])(
    'estimates speed %s inside its product throughput band',
    (speed) => {
      const estimate = estimateAppsPerHour(PACING_PRESETS[speed]);
      const [min, max] = TARGET_RATES[speed];
      expect(estimate.min).toBeGreaterThanOrEqual(min);
      expect(estimate.max).toBeLessThanOrEqual(max);
    },
  );

  it('keeps presets strictly monotonic as speed rises', () => {
    for (const speed of [1, 2, 3, 4] as PacingSpeed[]) {
      const slower = PACING_PRESETS[speed];
      const faster = PACING_PRESETS[(speed + 1) as PacingSpeed];
      expect(faster.minDelayMs).toBeLessThan(slower.minDelayMs);
      expect(faster.maxDelayMs).toBeLessThan(slower.maxDelayMs);
      expect(faster.sessionBatchSize).toBeGreaterThanOrEqual(slower.sessionBatchSize);
      expect(faster.sessionBreakMinMs).toBeLessThanOrEqual(slower.sessionBreakMinMs);
      expect(faster.sessionBreakMaxMs).toBeLessThanOrEqual(slower.sessionBreakMaxMs);
      expect(faster.scanDelayMinMs).toBeLessThanOrEqual(slower.scanDelayMinMs);
      expect(faster.scanDelayMaxMs).toBeLessThanOrEqual(slower.scanDelayMaxMs);
      expect(faster.humanDelayMinMs).toBeLessThanOrEqual(slower.humanDelayMinMs);
      expect(faster.humanDelayMaxMs).toBeLessThanOrEqual(slower.humanDelayMaxMs);
      expect(estimateAppsPerHour(faster).min).toBeGreaterThanOrEqual(
        estimateAppsPerHour(slower).min,
      );
      expect(estimateAppsPerHour(faster).max).toBeGreaterThanOrEqual(
        estimateAppsPerHour(slower).max,
      );
    }
  });

  it('derives every label description from the shared estimator', () => {
    for (const speed of [1, 2, 3, 4, 5] as PacingSpeed[]) {
      expect(PACING_PRESETS[speed].description).toBe(
        describePacingRate(estimateAppsPerHour(PACING_PRESETS[speed])),
      );
    }
  });

  it('formats the estimated band with whole, non-overstated numbers', () => {
    expect(formatPacingRate({ min: 35.29, max: 45 })).toBe('About 35–45 applications per hour');
    expect(formatPacingRate({ min: 90, max: 90 })).toBe('About 90 applications per hour');
    expect(describePacingRate({ min: 6.05, max: 9.86 })).toBe(
      'About 6–10 applications per hour, including apply time and breaks.',
    );
  });

  it('defaults to the 32–40/hour preset, 15 per day and its derived timing', () => {
    expect(DEFAULT_SETTINGS.pacing).toMatchObject({
      speed: 4,
      useAdvanced: false,
      dailyCap: 15,
      hardCap: 100,
      minDelayMs: 63_000,
      maxDelayMs: 73_000,
      sessionBatchSize: 10,
      sessionBreakMinMs: 120_000,
      sessionBreakMaxMs: 240_000,
    });
    const estimate = estimateAppsPerHour(DEFAULT_SETTINGS.pacing);
    expect(estimate.min).toBeGreaterThan(31);
    expect(estimate.max).toBeLessThanOrEqual(40);

    const pacer = createPacer(DEFAULT_SETTINGS, {
      now: () => 0,
      random: () => 0.5,
      sleep: async () => undefined,
    });
    expect(pacer.nextDelayMs(0, 0)).toBe(68_000);
    expect(pacer.inspectionDelayMs()).toBe(7_000);
    expect(pacer.humanDelay).toEqual({ minMs: 300, maxMs: 900 });
    expect(pacer.shouldTakeBreak(9)).toBe(false);
    expect(pacer.shouldTakeBreak(10)).toBe(true);
    expect(pacer.sessionBreakMs()).toBe(180_000);
  });

  it('estimates custom advanced timings instead of reusing the preset rate', () => {
    const custom = makeSettings({
      pacing: {
        speed: 4,
        useAdvanced: true,
        minDelayMs: 25_000,
        maxDelayMs: 25_000,
        jitterPercent: 0,
        sessionBatchSize: 1,
        sessionBreakMinMs: 0,
        sessionBreakMaxMs: 0,
      },
    });
    const estimate = estimateAppsPerHour(resolvePacing(custom.pacing));
    expect(estimate.min).toBeCloseTo(90, 5);
    expect(estimate.max).toBeCloseTo(90, 5);
    expect(formatPacingRate(estimate)).not.toBe(
      formatPacingRate(estimateAppsPerHour(PACING_PRESETS[4])),
    );
  });

  it('uses explicit fields only when advanced is enabled', () => {
    const settings = makeSettings({
      pacing: {
        speed: 1,
        useAdvanced: true,
        minDelayMs: 20_000,
        maxDelayMs: 20_000,
        jitterPercent: 0,
        scanDelayMinMs: 1000,
        scanDelayMaxMs: 2000,
        humanDelayMinMs: 50,
        humanDelayMaxMs: 100,
      },
    });
    const pacer = createPacer(settings, {
      now: () => 0,
      random: () => 0.5,
      sleep: async () => undefined,
    });
    expect(pacer.nextDelayMs(0, 0)).toBe(20_000);
    expect(pacer.inspectionDelayMs()).toBe(1500);
    expect(pacer.humanDelay).toEqual({ minMs: 50, maxMs: 100 });
  });

  it('bounds scan randomness and backoff at both extremes', () => {
    for (const random of [-1, 2]) {
      const pacer = createPacer(DEFAULT_SETTINGS, {
        now: () => 0,
        random: () => random,
        sleep: async () => undefined,
      });
      expect(pacer.inspectionDelayMs()).toBeGreaterThanOrEqual(4000);
      expect(pacer.inspectionDelayMs()).toBeLessThanOrEqual(10_000);
      expect(pacer.nextDelayMs(0, 0)).toBeGreaterThanOrEqual(63_000);
      expect(pacer.nextDelayMs(0, 0)).toBeLessThanOrEqual(73_000);
      expect(pacer.nextDelayMs(0, 100)).toBeLessThanOrEqual(1_800_000);
    }
  });

  it('bounds even an oversized advanced break to three hours', () => {
    const pacer = createPacer(
      makeSettings({
        pacing: {
          useAdvanced: true,
          sessionBreakMinMs: 99_000_000,
          sessionBreakMaxMs: 99_000_000,
        },
      }),
      { now: () => 0, random: () => 0.5, sleep: async () => undefined },
    );
    expect(pacer.sessionBreakMs()).toBe(180 * 60_000);
  });
});
