import { sleep } from '@/core/util/time';

/**
 * Injectable time source for pacing. Production code uses `realClock`; tests
 * provide a deterministic fake so no unit test depends on wall-clock time or
 * real timers (ARCHITECTURE.md §14).
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolves after `ms`, rejecting with an `AbortError` when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Uniform random in [0, 1); the pacer's jitter source. */
  random(): number;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, signal),
  random: () => Math.random(),
};
