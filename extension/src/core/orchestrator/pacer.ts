/**
 * Deterministic pacing and start gating.
 *
 * Ports `rate_limiter.py` (docs/PORT-NOTES.md §8) onto the extension defaults in
 * `DEFAULT_SETTINGS`: min/max delay, ±jitter, exponential backoff capped at 16×,
 * daily + hard caps, and session batches/breaks.
 *
 * All time enters through the injected `Clock`; this module never calls
 * `Date.now`, `setTimeout`, or `Math.random` directly. The pacer snapshots the
 * pacing settings when it is created, so recreate it after a settings change.
 */

import { appError, type AppError, type Settings } from '@/core/contracts';
import type { Clock } from '@/core/orchestrator/clock';
import { clamp } from '@/core/util/time';
import { resolvePacing } from './pacing-settings';

/** Backoff multiplier ceiling for consecutive failures (ARCHITECTURE.md §14). */
export const MAX_BACKOFF_MULTIPLIER = 16;

/** Ceiling on any single wait, including jittered backoff. */
export const MAX_BACKOFF_DELAY_MS = 30 * 60_000;

export interface StartDecision {
  allowed: boolean;
  reason?: AppError;
}

export interface Pacer {
  /** Bounded random pause before another search page or job inspection. */
  inspectionDelayMs(): number;
  humanDelay: { minMs: number; maxMs: number };
  /** True while today's count is below the effective cap (min of daily/hard). */
  canApplyToday(todayCount: number): boolean;
  /**
   * Human-like delay before the next application. Returns 0 when the daily cap
   * is already reached: the engine should stop rather than wait.
   */
  nextDelayMs(todayCount: number, consecutiveFailures: number): number;
  /** True on the Nth application of a session batch. */
  shouldTakeBreak(applicationsThisSession: number): boolean;
  /** Randomized session break duration in milliseconds. */
  sessionBreakMs(): number;
  /** Start preconditions owned by pacing: daily and hard caps. */
  evaluateStart(todayCount: number): StartDecision;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function createPacer(
  settings: Settings,
  clock: Clock,
  random: () => number = () => clock.random(),
): Pacer {
  const pacing = resolvePacing(settings.pacing);
  const minDelayMs = Math.max(0, Math.min(pacing.minDelayMs, pacing.maxDelayMs));
  const maxDelayMs = Math.max(minDelayMs, pacing.maxDelayMs);
  const jitter = clamp(pacing.jitterPercent, 0, 50) / 100;
  const effectiveCap = Math.max(0, Math.min(pacing.dailyCap, pacing.hardCap));
  const sessionBatchSize = Math.max(1, pacing.sessionBatchSize);
  const sessionBreakMinMs = Math.max(
    0,
    Math.min(pacing.sessionBreakMinMs, pacing.sessionBreakMaxMs),
  );
  const sessionBreakMaxMs = Math.max(sessionBreakMinMs, pacing.sessionBreakMaxMs);

  function canApplyToday(todayCount: number): boolean {
    return todayCount < effectiveCap;
  }

  function nextDelayMs(todayCount: number, consecutiveFailures: number): number {
    if (!canApplyToday(todayCount)) return 0;
    const base = minDelayMs + (maxDelayMs - minDelayMs) * clamp01(random());
    const jitterFactor = 1 + (clamp01(random()) * 2 - 1) * jitter;
    const failures = Math.max(0, Math.floor(consecutiveFailures));
    const backoff = Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER);
    // Preset ranges are the allowed envelope. Keep jitter within those edges;
    // custom timing retains its existing ±jitter semantics.
    const jittered = settings.pacing.useAdvanced
      ? base * jitterFactor
      : clamp(base * jitterFactor, minDelayMs, maxDelayMs);
    const delay = Math.round(jittered * backoff);
    return clamp(delay, 0, MAX_BACKOFF_DELAY_MS);
  }

  function shouldTakeBreak(applicationsThisSession: number): boolean {
    return applicationsThisSession > 0 && applicationsThisSession % sessionBatchSize === 0;
  }

  function sessionBreakMs(): number {
    const value = sessionBreakMinMs + (sessionBreakMaxMs - sessionBreakMinMs) * clamp01(random());
    return clamp(Math.round(value), 0, 180 * 60_000);
  }

  function evaluateStart(todayCount: number): StartDecision {
    if (todayCount >= pacing.hardCap) {
      return {
        allowed: false,
        reason: appError(
          'CAP_REACHED',
          `Hard cap reached (${todayCount}/${pacing.hardCap}). No more applications today.`,
        ),
      };
    }
    if (todayCount >= pacing.dailyCap) {
      return {
        allowed: false,
        reason: appError(
          'CAP_REACHED',
          `Daily cap reached (${todayCount}/${pacing.dailyCap}). Start again after local midnight.`,
        ),
      };
    }
    return { allowed: true };
  }

  return {
    inspectionDelayMs: () =>
      Math.round(
        Math.min(pacing.scanDelayMinMs, pacing.scanDelayMaxMs) +
          Math.abs(pacing.scanDelayMaxMs - pacing.scanDelayMinMs) * clamp01(random()),
      ),
    humanDelay: {
      minMs: Math.min(pacing.humanDelayMinMs, pacing.humanDelayMaxMs),
      maxMs: Math.max(pacing.humanDelayMinMs, pacing.humanDelayMaxMs),
    },
    canApplyToday,
    nextDelayMs,
    shouldTakeBreak,
    sessionBreakMs,
    evaluateStart,
  };
}
