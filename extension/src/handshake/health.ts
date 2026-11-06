/**
 * In-memory selector health. The content script owns one instance; diagnostics
 * reads it, and repeated failures on the same group are the UI_CHANGED signal.
 */

import type { SelectorHealth, SelectorStrategy } from '@/core/contracts';

export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
export const MAX_SELECTOR_HEALTH_ENTRIES = 200;

type PageType = SelectorHealth['page'];

let history: SelectorHealth[] = [];
const consecutiveFailures = new Map<string, number>();
const lastSuccess = new Map<string, SelectorHealth>();

export function recordSelectorHealth(health: SelectorHealth): void {
  history.push({ ...health });
  if (history.length > MAX_SELECTOR_HEALTH_ENTRIES) {
    history = history.slice(history.length - MAX_SELECTOR_HEALTH_ENTRIES);
  }
  if (health.ok) {
    consecutiveFailures.set(health.selector, 0);
    lastSuccess.set(health.selector, { ...health });
  } else {
    consecutiveFailures.set(health.selector, (consecutiveFailures.get(health.selector) ?? 0) + 1);
  }
}

/** Newest-last snapshot; callers cannot mutate the internal buffer. */
export function getSelectorHealth(): readonly SelectorHealth[] {
  return history.map((entry) => ({ ...entry }));
}

export function getConsecutiveFailures(selector: string): number {
  return consecutiveFailures.get(selector) ?? 0;
}

export function getLastSuccessfulStrategy(selector: string): string | undefined {
  return lastSuccess.get(selector)?.strategy;
}

export function isSelectorUnhealthy(
  selector: string,
  threshold = CONSECUTIVE_FAILURE_THRESHOLD,
): boolean {
  return getConsecutiveFailures(selector) >= threshold;
}

export function resetSelectorHealth(): void {
  history = [];
  consecutiveFailures.clear();
  lastSuccess.clear();
}

/** Pure first-match helper for per-card lookups that must not spam health. */
export function findFirstStrategy(
  strategies: readonly SelectorStrategy[],
  root: ParentNode,
): Element | null {
  for (const strategy of strategies) {
    const el = strategy.find(root);
    if (el) return el;
  }
  return null;
}

export interface StrategyMatch {
  readonly el: Element;
  readonly strategy: string;
}

/**
 * Try strategies in order. Records exactly one health entry per group attempt:
 * a success naming the winning strategy, or one failure with every tried name.
 */
export function runStrategy(
  group: string,
  strategies: readonly SelectorStrategy[],
  root: ParentNode,
  page: PageType,
  accept?: (element: Element) => boolean,
): StrategyMatch | null {
  const tried: string[] = [];

  for (const strategy of strategies) {
    tried.push(strategy.name);
    let el: Element | null;
    try {
      el = strategy.find(root);
    } catch {
      el = null;
    }
    if (el && accept && !accept(el)) el = null;
    if (el) {
      recordSelectorHealth({
        at: Date.now(),
        page,
        selector: group,
        strategy: strategy.name,
        ok: true,
      });
      return { el, strategy: strategy.name };
    }
  }

  recordSelectorHealth({
    at: Date.now(),
    page,
    selector: group,
    strategy: 'none',
    ok: false,
    detail: `Tried: ${tried.join(', ')}`,
  });
  return null;
}
