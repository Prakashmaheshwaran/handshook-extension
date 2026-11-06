export type PacingSpeed = 1 | 2 | 3 | 4 | 5;

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

/**
 * Time assumed for one full apply cycle outside the paced gap: opening the job,
 * filling the form and submitting. It is an estimate, not a measured value, and
 * is the same for every preset so the derived rates stay comparable.
 */
export const ESTIMATED_APPLY_TIME_MS = 15_000;

/** The pacing knobs that determine applications per hour. */
export interface PacingTimings {
  minDelayMs: number;
  maxDelayMs: number;
  sessionBatchSize: number;
  sessionBreakMinMs: number;
  sessionBreakMaxMs: number;
}

export interface AppRateEstimate {
  min: number;
  max: number;
}

/**
 * Estimated applications per hour for a resolved pacing configuration.
 *
 * One application costs the assumed apply time plus the paced gap; a session
 * break is amortized over the applications in its batch. The lower rate pairs
 * the longest gap with the longest break, the upper rate the shortest with the
 * shortest, so the band reflects real variation rather than a midpoint.
 */
export function estimateAppsPerHour(
  pacing: PacingTimings,
  applyTimeMs: number = ESTIMATED_APPLY_TIME_MS,
): AppRateEstimate {
  const minDelayMs = Math.max(0, Math.min(pacing.minDelayMs, pacing.maxDelayMs));
  const maxDelayMs = Math.max(minDelayMs, pacing.maxDelayMs);
  const batch = Math.max(1, Math.floor(pacing.sessionBatchSize));
  const breakMinMs = Math.max(0, Math.min(pacing.sessionBreakMinMs, pacing.sessionBreakMaxMs));
  const breakMaxMs = Math.max(breakMinMs, pacing.sessionBreakMaxMs);
  const applyMs = Math.max(0, applyTimeMs);

  const fastestCycleMs = applyMs + minDelayMs + breakMinMs / batch;
  const slowestCycleMs = applyMs + maxDelayMs + breakMaxMs / batch;
  const perHour = (cycleMs: number): number => (cycleMs > 0 ? 3_600_000 / cycleMs : 0);

  const a = perHour(fastestCycleMs);
  const b = perHour(slowestCycleMs);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** "About 32–40 applications per hour" — whole numbers, floor/ceil so the band is not overstated. */
export function formatPacingRate(rate: AppRateEstimate): string {
  const low = Math.max(0, Math.floor(rate.min));
  const high = Math.max(low, Math.ceil(rate.max));
  return low === high
    ? `About ${low} applications per hour`
    : `About ${low}–${high} applications per hour`;
}

/** The one sentence shown under the speed slider and in each preset's copy. */
export function describePacingRate(rate: AppRateEstimate): string {
  return `${formatPacingRate(rate)}, including apply time and breaks.`;
}

/** One source for slider labels, default settings and runtime timing. */
export const PACING_PRESETS = {
  1: preset('Very careful', 200, 280, 4, 10, 20, 15, 30, 700, 1800),
  2: preset('Careful', 135, 185, 6, 5, 10, 8, 20, 400, 1200),
  3: preset('Balanced', 70, 90, 8, 5, 10, 6, 15, 350, 1000),
  4: preset('Faster', 63, 73, 10, 2, 4, 4, 10, 300, 900),
  5: preset('Fastest', 11, 16, 12, 0.5, 1, 2, 6, 250, 800),
} as const;

export function pacingTimings(speed: PacingSpeed) {
  const { label, description, ...timings } = PACING_PRESETS[speed];
  void label;
  void description;
  return timings;
}

function preset(
  label: string,
  minSeconds: number,
  maxSeconds: number,
  sessionBatchSize: number,
  breakMinMinutes: number,
  breakMaxMinutes: number,
  scanMinSeconds: number,
  scanMaxSeconds: number,
  humanDelayMinMs: number,
  humanDelayMaxMs: number,
) {
  const timings = {
    minDelayMs: minSeconds * 1000,
    maxDelayMs: maxSeconds * 1000,
    jitterPercent: 20,
    sessionBatchSize,
    sessionBreakMinMs: breakMinMinutes * 60_000,
    sessionBreakMaxMs: breakMaxMinutes * 60_000,
    scanDelayMinMs: scanMinSeconds * 1000,
    scanDelayMaxMs: scanMaxSeconds * 1000,
    humanDelayMinMs,
    humanDelayMaxMs,
  };
  return {
    label,
    description: describePacingRate(estimateAppsPerHour(timings)),
    ...timings,
  };
}
