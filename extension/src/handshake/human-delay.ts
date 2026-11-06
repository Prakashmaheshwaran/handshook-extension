import type { DelayRange } from '@/core/contracts';
import { sleep } from '@/core/util/time';

/** Short form pauses belong to the cancellable content operation, never the worker. */
export async function humanDelay(range?: DelayRange, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!range) return;
  const low = Math.max(0, Math.min(3000, range.minMs, range.maxMs));
  const high = Math.max(low, Math.min(3000, Math.max(range.minMs, range.maxMs)));
  await sleep(Math.round(low + (high - low) * Math.random()), signal);
}
