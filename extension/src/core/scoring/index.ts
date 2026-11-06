/**
 * Deterministic, explainable fit scoring.
 *
 * This module owns the keyword-matching primitives as well as the fit score, so
 * `filters` can import it without creating a cycle (filters -> scoring only).
 *
 * Formula (see ARCHITECTURE.md §4 "Filters and fit scoring"):
 *   fitScore = 0.60 * titleOverlap + 0.25 * descriptionOverlap + 0.15 * freshness
 *
 * "Overlap" is coverage of the user's include keywords. With no keywords
 * configured, the title component is neutral (1) and the description component
 * measures how well the listing description backs up the title. That keeps the
 * default configuration (no keywords, `minFitScore: 0.55`) from silently
 * dropping every job. No AI, no network, no clock reads: callers pass `now`.
 */

export const FIT_WEIGHTS = {
  title: 0.6,
  description: 0.25,
  freshness: 0.15,
} as const;

const DAY_MS = 86_400_000;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'our',
  'the',
  'to',
  'we',
  'with',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles one keyword into a case-insensitive, word-boundary-aware matcher.
 * Multi-word keywords match any whitespace run between words. Returns null for
 * blank keywords.
 */
function keywordRegExp(keyword: string): RegExp | null {
  const parts = keyword.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  // \p{L}\p{N} keeps boundaries Unicode-aware; the trailing lookahead avoids
  // consuming the following character so adjacent keywords still match.
  const body = parts.map(escapeRegExp).join('\\s+');
  try {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  } catch {
    return null;
  }
}

function fallbackMatches(text: string, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  return needle.length > 0 && text.toLowerCase().includes(needle);
}

/**
 * Returns the configured keywords that appear in `text`, de-duplicated and in
 * configuration order. Matching is case-insensitive and whole-word (or
 * whole-phrase for multi-word keywords), so "engineer" does not match
 * "engineering".
 */
export function findMatchedKeywords(text: string, patterns: readonly string[]): string[] {
  if (text.length === 0 || patterns.length === 0) return [];
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const pattern of patterns) {
    const keyword = pattern.trim();
    if (keyword.length === 0) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    const regex = keywordRegExp(keyword);
    const hit = regex ? regex.test(text) : fallbackMatches(text, keyword);
    if (hit) {
      seen.add(key);
      matched.push(keyword);
    }
  }
  return matched;
}

export function matchesAnyKeyword(text: string, patterns: readonly string[]): boolean {
  return findMatchedKeywords(text, patterns).length > 0;
}

/** Lower-cased word tokens, used for the keyword-free description check. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#.]*/g)) {
    const token = match[0].replace(/\.+$/, '');
    if (token.length >= 2 && !STOP_WORDS.has(token)) tokens.push(token);
  }
  return tokens;
}

export interface FreshnessResult {
  score: number;
  reason: string;
}

/**
 * Freshness is resume-agnostic and only compares `discoveredAt` to the caller's
 * `now`. Without both values the score is neutral; it never reads the clock.
 */
export function freshnessScore(discoveredAt?: number, now?: number): FreshnessResult {
  if (discoveredAt === undefined || now === undefined) {
    return { score: 0.5, reason: 'Freshness unknown' };
  }
  const ageDays = (now - discoveredAt) / DAY_MS;
  if (ageDays <= 3) return { score: 1, reason: 'Posted recently' };
  if (ageDays <= 7) return { score: 0.85, reason: 'Posted this week' };
  if (ageDays <= 14) return { score: 0.7, reason: 'Posted in the last two weeks' };
  if (ageDays <= 30) return { score: 0.5, reason: 'Posted this month' };
  if (ageDays <= 90) return { score: 0.25, reason: 'Posted over a month ago' };
  return { score: 0.1, reason: 'Posted over three months ago' };
}

export interface FitScoreInput {
  title: string;
  description: string;
  includeKeywords?: readonly string[];
  remote?: boolean;
  discoveredAt?: number;
  postedAt?: string;
  /** Epoch ms supplied by the caller so scoring stays pure and deterministic. */
  now?: number;
}

export interface FitScoreBreakdown {
  title: number;
  description: number;
  freshness: number;
}

export interface FitScoreResult {
  /** 0..1, rounded to three decimals. */
  score: number;
  /** Up to three user-facing "why" lines. */
  reasons: string[];
  breakdown: FitScoreBreakdown;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function descriptionCoverage(title: string, description: string): number {
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return 1;
  const descriptionTokens = new Set(tokenize(description));
  const covered = titleTokens.filter((token) => descriptionTokens.has(token)).length;
  return covered / titleTokens.length;
}

export function scoreFit(input: FitScoreInput): FitScoreResult {
  const keywords = (input.includeKeywords ?? [])
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  const postedAt = input.postedAt ? Date.parse(input.postedAt) : NaN;
  const freshness = freshnessScore(
    Number.isFinite(postedAt) ? postedAt : input.discoveredAt,
    input.now,
  );

  let titleScore: number;
  let descriptionScore: number;
  let titleMatches: string[] = [];
  let descriptionMatches: string[] = [];

  if (keywords.length > 0) {
    titleMatches = findMatchedKeywords(input.title, keywords);
    descriptionMatches = findMatchedKeywords(input.description, keywords);
    titleScore = titleMatches.length / keywords.length;
    descriptionScore = descriptionMatches.length / keywords.length;
  } else {
    // No preferences configured: score listing quality instead of dropping jobs.
    titleScore = 1;
    descriptionScore = descriptionCoverage(input.title, input.description);
  }

  const raw =
    FIT_WEIGHTS.title * titleScore +
    FIT_WEIGHTS.description * descriptionScore +
    FIT_WEIGHTS.freshness * freshness.score;

  const reasons: string[] = [];
  if (keywords.length === 0) {
    reasons.push('No target keywords set');
    reasons.push(
      descriptionScore >= 0.5 ? 'Description supports the title' : 'Description has little detail',
    );
  } else if (titleMatches.length > 0) {
    reasons.push(`Title matches: ${titleMatches.slice(0, 2).join(', ')}`);
    const extraDescriptionMatches = descriptionMatches.filter(
      (keyword) => !titleMatches.includes(keyword),
    );
    if (extraDescriptionMatches.length > 0) {
      reasons.push(`Description matches: ${extraDescriptionMatches.slice(0, 2).join(', ')}`);
    }
  } else {
    reasons.push('No title keyword match');
    if (descriptionMatches.length > 0) {
      reasons.push(`Description matches: ${descriptionMatches.slice(0, 2).join(', ')}`);
    }
  }

  reasons.push(freshness.reason);
  if (input.remote === true) reasons.push('Remote');

  return {
    score: clamp01(round3(raw)),
    reasons: reasons.slice(0, 3),
    breakdown: {
      title: round3(titleScore),
      description: round3(descriptionScore),
      freshness: freshness.score,
    },
  };
}
