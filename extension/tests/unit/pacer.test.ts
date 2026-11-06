import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import type { Clock } from '@/core/orchestrator/clock';
import { MAX_BACKOFF_DELAY_MS, createPacer, type Pacer } from '@/core/orchestrator/pacer';

const HOUR_MS = 3_600_000;

class FakeClock implements Clock {
  private current: number;
  private randomValue: number;

  constructor(current: number, randomValue = 0.5) {
    this.current = current;
    this.randomValue = randomValue;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.current += Math.max(0, ms);
    return Promise.resolve();
  }

  random(): number {
    return this.randomValue;
  }

  setNow(value: number): void {
    this.current = value;
  }

  setRandom(value: number): void {
    this.randomValue = value;
  }
}

function localTime(hours: number, minutes = 0): number {
  return new Date(2026, 9, 25, hours, minutes, 0, 0).getTime();
}

function makeSettings(patch: SettingsPatch = {}): Settings {
  // These tests exercise the pre-existing custom timing/backoff algorithm.
  const base = mergeSettings(structuredClone(DEFAULT_SETTINGS), {
    pacing: {
      useAdvanced: true,
      dailyCap: 25,
      minDelayMs: 60_000,
      maxDelayMs: 120_000,
      jitterPercent: 10,
      sessionBatchSize: 10,
      sessionBreakMinMs: 300_000,
      sessionBreakMaxMs: 600_000,
    },
  });
  return mergeSettings(base, patch);
}

function makePacer(options: { settings?: SettingsPatch; at?: number; random?: number } = {}): {
  pacer: Pacer;
  clock: FakeClock;
} {
  const clock = new FakeClock(options.at ?? localTime(12), options.random ?? 0.5);
  return { pacer: createPacer(makeSettings(options.settings), clock), clock };
}

describe('canApplyToday', () => {
  it('allows applications below the daily cap and blocks at or above it', () => {
    const { pacer } = makePacer();
    expect(pacer.canApplyToday(0)).toBe(true);
    expect(pacer.canApplyToday(24)).toBe(true);
    expect(pacer.canApplyToday(25)).toBe(false);
    expect(pacer.canApplyToday(26)).toBe(false);
  });

  it('uses the smaller of dailyCap and hardCap', () => {
    const { pacer } = makePacer({ settings: { pacing: { dailyCap: 100, hardCap: 30 } } });
    expect(pacer.canApplyToday(29)).toBe(true);
    expect(pacer.canApplyToday(30)).toBe(false);
  });
});

describe('nextDelayMs', () => {
  it('returns the midpoint of min/max with neutral jitter', () => {
    const { pacer } = makePacer({ random: 0.5 });
    expect(pacer.nextDelayMs(0, 0)).toBe(90_000);
  });

  it('stays inside the jitter band at the random extremes', () => {
    const low = makePacer({ random: 0 }).pacer;
    const high = makePacer({ random: 1 }).pacer;
    expect(low.nextDelayMs(0, 0)).toBe(54_000);
    expect(high.nextDelayMs(0, 0)).toBe(132_000);
  });

  it('is deterministic for a fixed clock and random source', () => {
    const { pacer } = makePacer({ random: 0.37 });
    expect(pacer.nextDelayMs(3, 1)).toBe(pacer.nextDelayMs(3, 1));
  });

  it('ignores jitter when jitterPercent is zero', () => {
    const { pacer } = makePacer({ settings: { pacing: { jitterPercent: 0 } }, random: 0.25 });
    expect(pacer.nextDelayMs(0, 0)).toBe(75_000);
  });

  it('applies exponential backoff capped at 16x', () => {
    const { pacer } = makePacer({ random: 0.5 });
    expect(pacer.nextDelayMs(0, 0)).toBe(90_000);
    expect(pacer.nextDelayMs(0, 1)).toBe(180_000);
    expect(pacer.nextDelayMs(0, 2)).toBe(360_000);
    expect(pacer.nextDelayMs(0, 3)).toBe(720_000);
    expect(pacer.nextDelayMs(0, 4)).toBe(1_440_000);
    expect(pacer.nextDelayMs(0, 5)).toBe(1_440_000);
    expect(pacer.nextDelayMs(0, 10)).toBe(pacer.nextDelayMs(0, 4));
  });

  it('never exceeds the hard delay ceiling', () => {
    const { pacer } = makePacer({
      settings: { pacing: { jitterPercent: 50 } },
      random: 1,
    });
    expect(pacer.nextDelayMs(0, 10)).toBe(MAX_BACKOFF_DELAY_MS);
  });

  it('returns zero when the daily cap is already reached', () => {
    const { pacer } = makePacer({ random: 0.5 });
    expect(pacer.nextDelayMs(25, 0)).toBe(0);
  });

  it('treats negative failure counts as zero', () => {
    const { pacer } = makePacer({ random: 0.5 });
    expect(pacer.nextDelayMs(0, -3)).toBe(90_000);
  });
});

describe('active hours', () => {
  it.each([0, 3, 7, 8, 12, 21, 22, 23])('allows starts at %s:00 with legacy windows', (hour) => {
    for (const activeHours of [
      null,
      { start: '08:00', end: '22:00' },
      { start: '22:00', end: '06:00' },
    ]) {
      const { pacer } = makePacer({
        settings: { pacing: { activeHours } },
        at: localTime(hour),
      });
      expect(pacer.evaluateStart(0)).toEqual({ allowed: true });
      expect(pacer.evaluateStart(25).reason?.code).toBe('CAP_REACHED');
    }
  });
});

describe('session breaks', () => {
  it('takes a break every sessionBatchSize applications', () => {
    const { pacer } = makePacer();
    expect(pacer.shouldTakeBreak(0)).toBe(false);
    expect(pacer.shouldTakeBreak(9)).toBe(false);
    expect(pacer.shouldTakeBreak(10)).toBe(true);
    expect(pacer.shouldTakeBreak(20)).toBe(true);
  });

  it('honours a custom batch size', () => {
    const { pacer } = makePacer({ settings: { pacing: { sessionBatchSize: 5 } } });
    expect(pacer.shouldTakeBreak(4)).toBe(false);
    expect(pacer.shouldTakeBreak(5)).toBe(true);
  });

  it('randomizes the break inside the configured range', () => {
    expect(makePacer({ random: 0 }).pacer.sessionBreakMs()).toBe(300_000);
    expect(makePacer({ random: 0.5 }).pacer.sessionBreakMs()).toBe(450_000);
    expect(makePacer({ random: 1 }).pacer.sessionBreakMs()).toBe(600_000);
  });

  it('normalizes an inverted break range', () => {
    const { pacer } = makePacer({
      settings: { pacing: { sessionBreakMinMs: 600_000, sessionBreakMaxMs: 300_000 } },
      random: 0,
    });
    expect(pacer.sessionBreakMs()).toBe(300_000);
  });
});

describe('evaluateStart', () => {
  it('allows a start below the caps', () => {
    const { pacer } = makePacer({ at: localTime(12) });
    const decision = pacer.evaluateStart(0);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('blocks at the daily cap', () => {
    const { pacer } = makePacer();
    const decision = pacer.evaluateStart(25);
    expect(decision.allowed).toBe(false);
    expect(decision.reason?.code).toBe('CAP_REACHED');
    expect(decision.reason?.message).toContain('Daily cap reached (25/25)');
    expect(decision.reason?.retryable).toBe(false);
  });

  it('reports the hard cap when it is lower than the daily cap', () => {
    const { pacer } = makePacer({ settings: { pacing: { dailyCap: 100, hardCap: 30 } } });
    const decision = pacer.evaluateStart(30);
    expect(decision.allowed).toBe(false);
    expect(decision.reason?.code).toBe('CAP_REACHED');
    expect(decision.reason?.message).toContain('Hard cap reached (30/30)');
  });

  it('allows a start at night', () => {
    const { pacer } = makePacer({ at: localTime(3) });
    const decision = pacer.evaluateStart(0);
    expect(decision).toEqual({ allowed: true });
  });

  it('does not depend on real time advancing', () => {
    const { pacer, clock } = makePacer({ at: localTime(12) });
    expect(pacer.evaluateStart(0).allowed).toBe(true);
    clock.setNow(localTime(12) + HOUR_MS);
    expect(pacer.evaluateStart(0).allowed).toBe(true);
  });
});
