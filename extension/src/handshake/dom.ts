/**
 * Shared DOM primitives for Handshake adapters.
 *
 * Design rules (docs/SELECTORS.md):
 * - wait for positive conditions, never fixed sleeps;
 * - every wait accepts an AbortSignal and rejects with `CancelledError`;
 * - React inputs are written with the native prototype setter + events;
 * - disabled or invisible elements are never clicked.
 */

import { collapseWhitespace, getAccessibleName, type TextMatcher } from './text';

export { getAccessibleName };

export class CancelledError extends Error {
  readonly code = 'CANCELLED' as const;

  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export class WaitTimeoutError extends Error {
  readonly code = 'TIMEOUT' as const;

  constructor(message = 'Timed out waiting for condition') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface TextQueryOptions {
  /** CSS selector limiting the elements considered. */
  readonly candidates?: string;
  /** Match the whole normalized text instead of a substring. */
  readonly exact?: boolean;
  /** Skip hidden elements (default `true`). */
  readonly visibleOnly?: boolean;
  readonly limit?: number;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_WAIT_INTERVAL_MS = 50;

export const DEFAULT_TEXT_CANDIDATES = [
  'a',
  'button',
  '[role]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'li',
  'p',
  'span',
  'div',
  'td',
  'th',
  'dt',
  'dd',
  'legend',
  'option',
  'small',
  'strong',
  'summary',
  'time',
].join(',');

const NON_TEXT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'PATH',
  'HEAD',
  'META',
  'LINK',
]);

const INVISIBLE_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

export function isInteractiveElement(el: Element): boolean {
  return el.matches(INTERACTIVE_SELECTOR);
}

export function isDisabledElement(el: Element | null | undefined): boolean {
  if (!el) return true;
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.getAttribute('data-disabled') === 'true') return true;
  if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'SELECT') {
    if ((el as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled) return true;
  }
  const className = typeof el.className === 'string' ? el.className : '';
  return /\b(?:is-)?disabled\b/i.test(className);
}

/**
 * Viewport-independent visibility: connected, not `hidden`, no
 * `display:none`/`visibility:hidden`/`opacity:0` on the element or an
 * ancestor. jsdom has no layout, so dimensions are intentionally not used.
 */
export function isVisible(el: Element | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return false;
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return false;

  for (let node: Element | null = el; node; node = node.parentElement) {
    if (INVISIBLE_TAGS.has(node.tagName)) return false;
    if (node.hasAttribute('hidden')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    const style = view.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity.length > 0 && Number(style.opacity) === 0) return false;
    if (node === doc.body) break;
  }
  return true;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new CancelledError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll a condition until it returns a truthy value. Rejects with
 * `WaitTimeoutError` on timeout and `CancelledError` when aborted.
 */
export async function waitFor<T>(
  check: () => T | null | undefined | false,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  const signal = options.signal;
  const startedAt = Date.now();

  for (;;) {
    throwIfAborted(signal);
    const result = check();
    if (result !== null && result !== undefined && result !== false) return result;

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) throw new WaitTimeoutError();
    await delay(Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)), signal);
  }
}

/**
 * Observe DOM changes as well as polling. Background tabs throttle timers, but
 * a newly rendered control should wake the waiter as soon as its mutation is
 * delivered. Every exit disconnects the observer, timer, and abort listener.
 */
export function waitForDom<T>(
  doc: Document,
  check: () => T | null | undefined | false,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  const startedAt = Date.now();
  const { signal } = options;

  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    let settled = false;
    let checked = false;
    const cleanup = () => {
      settled = true;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new CancelledError());
    const probe = () => {
      if (settled) return;
      try {
        throwIfAborted(signal);
        if (checked && Date.now() - startedAt >= timeoutMs) throw new WaitTimeoutError();
        checked = true;
        const result = check();
        if (result !== null && result !== undefined && result !== false) {
          cleanup();
          resolve(result);
        } else if (Date.now() - startedAt >= timeoutMs) {
          fail(new WaitTimeoutError());
        }
      } catch (error) {
        fail(error);
      }
    };
    const poll = () => {
      probe();
      if (!settled) {
        timer = setTimeout(poll, Math.min(intervalMs, timeoutMs - (Date.now() - startedAt)));
      }
    };

    const Observer = doc.defaultView?.MutationObserver;
    if (Observer) {
      observer = new Observer(probe);
      observer.observe(doc, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    poll();
  });
}

/**
 * Resolve once the probe is falsy (or no longer connected). Accepts a probe
 * function or an element for the common disappearance check.
 */
export async function waitForGone(
  probe: (() => unknown) | Element | null | undefined,
  options: WaitOptions = {},
): Promise<void> {
  await waitFor(() => {
    if (typeof probe === 'function') {
      return probe() ? null : true;
    }
    if (!probe) return true;
    return probe.isConnected && isVisible(probe) ? null : true;
  }, options);
}

function testMatcher(value: string, matcher: TextMatcher, exact: boolean): boolean {
  const normalized = collapseWhitespace(value);
  if (typeof matcher === 'string') {
    const needle = collapseWhitespace(matcher);
    if (needle.length === 0) return false;
    return exact ? normalized === needle : normalized.includes(needle);
  }
  if (matcher instanceof RegExp) {
    const safe =
      matcher.global || matcher.sticky
        ? new RegExp(matcher.source, matcher.flags.replace(/[gy]/g, ''))
        : matcher;
    if (safe.test(normalized.toLowerCase())) return true;
    if (safe.test(normalized)) return true;
    return normalized !== value && safe.test(value);
  }
  return matcher(normalized, value);
}

function textMatches(el: Element, matcher: TextMatcher, exact: boolean): boolean {
  const name = getAccessibleName(el);
  if (name.length > 0 && testMatcher(name, matcher, exact)) return true;
  if (el.children.length === 0) {
    const raw = collapseWhitespace(el.textContent ?? '');
    return raw.length > 0 && testMatcher(raw, matcher, exact);
  }
  return false;
}

/**
 * All elements whose accessible name (or leaf text) matches. Ancestor wrappers
 * are dropped unless they are interactive, so `button > span` returns the
 * button while a banner `<div>` still matches.
 */
export function findAllByText(
  root: ParentNode,
  matcher: TextMatcher,
  options: TextQueryOptions = {},
): Element[] {
  const candidates = options.candidates ?? DEFAULT_TEXT_CANDIDATES;
  const exact = options.exact ?? false;
  const visibleOnly = options.visibleOnly ?? true;
  const matches: Element[] = [];

  for (const el of Array.from(root.querySelectorAll(candidates))) {
    if (NON_TEXT_TAGS.has(el.tagName)) continue;
    if (!textMatches(el, matcher, exact)) continue;
    if (visibleOnly && !isVisible(el)) continue;
    matches.push(el);
  }

  const preferred = matches.filter(
    (el) =>
      isInteractiveElement(el) || !matches.some((other) => other !== el && el.contains(other)),
  );
  const limit = options.limit;
  return typeof limit === 'number' ? preferred.slice(0, Math.max(0, limit)) : preferred;
}

export function findByText(
  root: ParentNode,
  matcher: TextMatcher,
  options: TextQueryOptions = {},
): Element | null {
  return findAllByText(root, matcher, { ...options, limit: 1 })[0] ?? null;
}

export interface ClickOptions {
  /** Scroll the element into view before clicking (default `true`). */
  readonly scroll?: boolean;
}

/** Scroll into view and click. Returns `false` for missing/disabled elements. */
export function clickElement(el: Element | null | undefined, options: ClickOptions = {}): boolean {
  if (!el || !isVisible(el) || isDisabledElement(el)) return false;

  const clickable = el as HTMLElement;
  if (options.scroll !== false && typeof clickable.scrollIntoView === 'function') {
    try {
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {
      // Older jsdom/synthetic DOMs may not implement options; click still works.
    }
  }

  if (typeof clickable.click === 'function') {
    clickable.click();
  } else {
    el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: el.ownerDocument.defaultView,
      }),
    );
  }
  return true;
}

function dispatchInputAndChange(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function valuePrototype(el: HTMLInputElement | HTMLTextAreaElement): object {
  const view = el.ownerDocument.defaultView;
  if (el.tagName === 'TEXTAREA') {
    return (view?.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype;
  }
  return (view?.HTMLInputElement ?? HTMLInputElement).prototype;
}

/**
 * React-safe value assignment: use the native prototype setter so React's
 * value tracker sees a change, then dispatch bubbling `input` and `change`.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(valuePrototype(el), 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  dispatchInputAndChange(el);
}

/** Focus a text control and replace its value. Returns `false` if unusable. */
export function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  text: string,
): boolean {
  if (!el || !isVisible(el) || isDisabledElement(el)) return false;
  el.focus();
  setNativeValue(el, text);
  return true;
}

function pickOptionByLabel(select: HTMLSelectElement, value: string): HTMLOptionElement | null {
  const wanted = collapseWhitespace(value).toLowerCase();
  return (
    Array.from(select.options).find(
      (option) =>
        option.value === value ||
        collapseWhitespace(option.textContent ?? '').toLowerCase() === wanted,
    ) ?? null
  );
}

/** Select a native option by value or label and dispatch `input`/`change`. */
export function selectNative(select: HTMLSelectElement | null | undefined, value: string): boolean {
  if (!select || !isVisible(select) || isDisabledElement(select)) return false;
  const option = pickOptionByLabel(select, value);
  if (!option) return false;

  const selectConstructor =
    select.ownerDocument.defaultView?.HTMLSelectElement ?? HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(selectConstructor.prototype, 'value')?.set;
  if (setter) setter.call(select, option.value);
  else select.value = option.value;
  dispatchInputAndChange(select);
  return true;
}

export interface OpenComboboxOptions extends WaitOptions {
  /** Override how the listbox is located after the click. */
  readonly listbox?: () => Element | null;
}

function defaultListbox(trigger: Element): Element | null {
  const doc = trigger.ownerDocument;
  const controlledId = trigger.getAttribute('aria-controls');
  if (controlledId) {
    const controlled = doc.getElementById(controlledId);
    if (controlled && isVisible(controlled)) return controlled;
  }
  const listboxes = Array.from(
    doc.querySelectorAll('[role="listbox"], [role="menu"], [data-testid*="listbox" i]'),
  );
  return listboxes.find((el) => isVisible(el)) ?? null;
}

/**
 * Click a combobox trigger and wait for its listbox. Returns `null` when the
 * listbox never appears or the trigger cannot be clicked. Aborting rejects.
 */
export async function openCombobox(
  trigger: Element | null | undefined,
  options: OpenComboboxOptions = {},
): Promise<Element | null> {
  if (!trigger) return null;
  const locate = () => {
    if (options.listbox) return options.listbox();
    return defaultListbox(trigger);
  };

  const existing = locate();
  if (existing && isVisible(existing)) return existing;
  if (!clickElement(trigger)) return null;

  try {
    return await waitFor(() => {
      const listbox = locate();
      return listbox && isVisible(listbox) ? listbox : null;
    }, options);
  } catch (error) {
    if (error instanceof WaitTimeoutError) return null;
    throw error;
  }
}

function optionMatches(el: Element, matcher: TextMatcher, exact: boolean): boolean {
  const values = [
    getAccessibleName(el),
    el.getAttribute('data-value') ?? '',
    el.getAttribute('value') ?? '',
  ];
  return values.some((value) => value.length > 0 && testMatcher(value, matcher, exact));
}

/**
 * Find and activate an option by normalized text or `data-value`/`value`.
 * Native `<option>` elements are selected through their parent `<select>`.
 */
export function pickOption(
  root: ParentNode | null | undefined,
  matcher: TextMatcher,
  options: { readonly visibleOnly?: boolean } = {},
): Element | null {
  if (!root) return null;
  const visibleOnly = options.visibleOnly ?? true;
  const candidates = Array.from(
    root.querySelectorAll('[role="option"], option, li, [data-value], button'),
  ).filter((el) => !visibleOnly || isVisible(el));
  if (candidates.length === 0) return null;

  const usable = candidates.filter((el) => !isDisabledElement(el));
  const exact = usable.find((el) => optionMatches(el, matcher, true));
  const target = exact ?? usable.find((el) => optionMatches(el, matcher, false));
  if (!target) return null;

  if (target.tagName === 'OPTION') {
    const select = target.closest('select');
    if (select && selectNative(select, (target as HTMLOptionElement).value)) return target;
    return null;
  }
  return clickElement(target) ? target : null;
}

/** Nearest fieldset or ARIA group around a control. */
export function closestFieldset(el: Element | null | undefined): Element | null {
  if (!el) return null;
  return el.closest('fieldset') ?? el.closest('[role="group"], [role="radiogroup"]');
}

/**
 * Query including open shadow roots. Portals in `document.body` are covered by
 * a normal query; this adds shadow DOM support where the platform allows it.
 */
export function queryAllDeep(root: ParentNode, selector: string): Element[] {
  const found = new Set<Element>();

  const visit = (node: ParentNode): void => {
    for (const match of Array.from(node.querySelectorAll(selector))) found.add(match);
    for (const el of Array.from(node.querySelectorAll('*'))) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };

  visit(root);
  if (root instanceof Element && root.matches(selector)) found.add(root);
  return Array.from(found);
}
