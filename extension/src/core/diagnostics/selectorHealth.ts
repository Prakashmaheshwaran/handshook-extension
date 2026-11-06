/**
 * Persistent selector health reported by the content script.
 *
 * The content adapter owns collection (`handshake/health.ts`); the background
 * persists reviewed keys and outcomes only. Entries arrive one at a time or as
 * a whole `getSelectorHealth()` snapshot; validation and projection remove page
 * text before storage because the message boundary is untrusted.
 */

import { selectorHealthSchema, type SelectorHealth } from '@/core/contracts';
import { getMeta, setMeta } from '@/core/storage/db';
import { diagnosticLabel } from './privacy';
import {
  parseActionAreaOutline,
  SELECTOR_KEYS,
  STRATEGY_KEYS,
  type ActionAreaOutline,
} from './selectorKeys';

const META_KEY = 'selectorHealth';
export const MAX_SELECTOR_HEALTH_ENTRIES = 200;

function normalize(input: unknown): SelectorHealth[] {
  const entries = Array.isArray(input) ? input : [input];
  const valid: SelectorHealth[] = [];
  for (const entry of entries) {
    const parsed = selectorHealthSchema.safeParse(entry);
    if (parsed.success) {
      const data = parsed.data;
      const outline =
        data.page === 'job' &&
        !data.ok &&
        (data.selector === 'job.readiness' || data.selector === 'job.applyButton') &&
        data.strategy === 'dom:action-area'
          ? parseActionAreaOutline(data.detail)
          : undefined;
      valid.push({
        at: parsed.data.at,
        page: parsed.data.page,
        selector: diagnosticLabel(parsed.data.selector, SELECTOR_KEYS),
        strategy: diagnosticLabel(parsed.data.strategy, STRATEGY_KEYS),
        ok: parsed.data.ok,
        ...(outline ? { detail: JSON.stringify(outline) } : {}),
      });
    }
  }
  return valid;
}

export async function listSelectorHealth(): Promise<SelectorHealth[]> {
  const stored = await getMeta<unknown>(META_KEY);
  if (!Array.isArray(stored)) return [];
  // Re-project older entries too: pre-redaction history may contain page text.
  return normalize(stored).slice(-MAX_SELECTOR_HEALTH_ENTRIES);
}

/** Only reviewed structural outlines may accompany the aggregate counts. */
export function summarizeSelectorHealth(entries: SelectorHealth[]) {
  const groups = new Map<
    string,
    {
      page: SelectorHealth['page'];
      selector: string;
      strategy: string;
      successes: number;
      failures: number;
      lastAt: number;
      actionArea?: ActionAreaOutline;
    }
  >();
  for (const entry of normalize(entries)) {
    const key = JSON.stringify([entry.page, entry.selector, entry.strategy]);
    const current = groups.get(key) ?? {
      page: entry.page,
      selector: entry.selector,
      strategy: entry.strategy,
      successes: 0,
      failures: 0,
      lastAt: entry.at,
    };
    if (entry.ok) current.successes += 1;
    else current.failures += 1;
    current.lastAt = Math.max(current.lastAt, entry.at);
    const outline = parseActionAreaOutline(entry.detail);
    if (outline && entry.at === current.lastAt) current.actionArea = outline;
    groups.set(key, current);
  }
  return [...groups.values()];
}

/** Appends validated entries, keeping the newest `MAX_SELECTOR_HEALTH_ENTRIES`. */
export async function recordSelectorHealthEntries(input: unknown): Promise<SelectorHealth[]> {
  const received = normalize(input);
  if (received.length === 0) return listSelectorHealth();
  const current = await listSelectorHealth();
  const next = [...current, ...received].slice(-MAX_SELECTOR_HEALTH_ENTRIES);
  await setMeta(META_KEY, next);
  return next;
}

export async function clearSelectorHealth(): Promise<void> {
  await setMeta(META_KEY, []);
}
