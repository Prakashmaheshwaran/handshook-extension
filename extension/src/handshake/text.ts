/**
 * Text normalization and matching helpers shared by every Handshake adapter.
 *
 * Matching is deliberately punctuation- and case-insensitive: Handshake's
 * rendered labels vary (`Quick Apply`, `Quick apply *`, `Quick Apply
 * (required)`) while meaning the same action.
 */

export type TextMatcher = string | RegExp | ((normalized: string, raw: string) => boolean);

const REQUIRED_MARKERS = /[*\u2731\u2020\u2021\u204e]/g;
const REQUIRED_PARENTHETICAL = /\((?:required|mandatory)\)|\[(?:required|mandatory)\]/gi;
const APOSTROPHES = /['\u2019]/g;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const WHITESPACE = /\s+/g;

/** Collapse runs of whitespace without changing case or punctuation. */
export function collapseWhitespace(input: string): string {
  return input.replace(WHITESPACE, ' ').trim();
}

/**
 * Lowercase, strip required markers and punctuation, collapse whitespace.
 * `"Software Engineer * (Required)"` -> `"software engineer"`.
 */
export function normalizeText(input: string): string {
  return input
    .replace(REQUIRED_PARENTHETICAL, ' ')
    .replace(REQUIRED_MARKERS, ' ')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Normalized words, preserving order and duplicates. */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

export interface MatchesAnyOptions {
  /** Require every pattern to match instead of at least one. */
  readonly all?: boolean;
}

/**
 * Normalized keyword matching. String patterns match whole tokens (so
 * `"intern"` does not match `"internship"`); multi-word strings match as a
 * contiguous phrase. Regular expressions are tested against both the raw and
 * normalized text.
 */
export function matchesAny(
  text: string,
  patterns: readonly (string | RegExp)[],
  options: MatchesAnyOptions = {},
): boolean {
  if (patterns.length === 0) return false;
  const normalized = normalizeText(text);
  const tokens = normalized.length === 0 ? [] : normalized.split(' ');
  const results = patterns.map((pattern) => {
    if (typeof pattern === 'string') {
      const needle = normalizeText(pattern);
      if (needle.length === 0) return false;
      if (needle.includes(' ')) return normalized.includes(needle);
      return tokens.includes(needle);
    }
    return testRegExp(pattern, text) || testRegExp(pattern, normalized);
  });
  return options.all === true ? results.every(Boolean) : results.some(Boolean);
}

/** Jaccard token overlap in `[0, 1]`. Empty input scores `0`. */
export function overlapScore(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Levenshtein edit distance with a two-row rolling buffer. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    const first = current;
    first[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (first[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + substitutionCost;
      first[j] = Math.min(deletion, insertion, substitution);
    }
    current = previous;
    previous = first;
  }

  return previous[b.length] ?? 0;
}

/** Truncate by code units, appending an ellipsis when shortened. */
export function truncate(text: string, maxLength: number, ellipsis = '\u2026'): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  if (maxLength <= ellipsis.length) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - ellipsis.length).trimEnd()}${ellipsis}`;
}

function testRegExp(pattern: RegExp, value: string): boolean {
  const safe =
    pattern.global || pattern.sticky
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      : pattern;
  return safe.test(value);
}

function isFormControl(el: Element): boolean {
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
}

/**
 * Accessible name approximation in priority order:
 * `aria-label`, `aria-labelledby`, `label[for]`, wrapping `<label>`, text.
 *
 * Form controls without a label return `''` rather than their option text, so
 * a `<select>` is not named after its first option.
 */
export function getAccessibleName(el: Element | null | undefined): string {
  if (!el) return '';

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && collapseWhitespace(ariaLabel).length > 0) {
    return collapseWhitespace(ariaLabel);
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = el.ownerDocument;
    const names = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .filter((value) => value.trim().length > 0);
    if (names.length > 0) return collapseWhitespace(names.join(' '));
  }

  const id = el.getAttribute('id');
  if (id) {
    const labels = Array.from(el.ownerDocument.querySelectorAll('label[for]'));
    const match = labels.find((label) => label.getAttribute('for') === id);
    const text = match?.textContent ?? '';
    if (text.trim().length > 0) return collapseWhitespace(text);
  }

  const wrappingLabel = el.closest('label');
  const wrappingText = wrappingLabel?.textContent ?? '';
  if (wrappingText.trim().length > 0) return collapseWhitespace(wrappingText);

  if (isFormControl(el)) return '';
  return collapseWhitespace(el.textContent ?? '');
}
