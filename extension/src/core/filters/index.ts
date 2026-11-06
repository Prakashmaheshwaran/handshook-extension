/**
 * Deterministic job filtering and fit scoring.
 *
 * Pure functions only: no storage, network, AI, or clock reads. `now` is
 * optional so callers can pass the reference time for freshness scoring (tests
 * and the engine do; the UI may omit it).
 *
 * Result shape:
 * - `pass === false` -> `reasons` are exclusion reasons (one per failed rule).
 * - `pass === true`  -> `reasons` are informational warnings, e.g. an unknown
 *   location. Unknown values pass: we do not silently drop jobs we cannot
 *   evaluate (T25 acceptance criteria).
 */

import type { Job, Settings } from '@/core/contracts';
import {
  findMatchedKeywords,
  matchesAnyKeyword,
  scoreFit,
  type FitScoreResult,
} from '@/core/scoring';

export { findMatchedKeywords, matchesAnyKeyword };

export interface JobFilterResult {
  pass: boolean;
  /** Exclusion reasons when `pass` is false; warnings when `pass` is true. */
  reasons: string[];
  /** 0..1 deterministic fit score. */
  fitScore: number;
  /** Up to three user-facing fit reasons. */
  fitReasons: string[];
}

const MAX_KEYWORD_REASONS = 2;

function cleanKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
  }
  return cleaned;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function locationMatches(jobLocation: string, wanted: readonly string[]): boolean {
  const haystack = normalize(jobLocation);
  if (haystack.length === 0) return false;
  return wanted.some((entry) => {
    const needle = normalize(entry);
    if (needle.length === 0) return false;
    if (haystack.includes(needle)) return true;
    // The setting may be more specific than the posting ("San Francisco, CA"
    // vs "San Francisco"). Only allow that direction for real place names, so a
    // two-letter job location cannot match "austin" through "us".
    return haystack.length >= 4 && needle.includes(haystack);
  });
}

function employmentTypeMatches(jobType: string, wanted: readonly string[]): boolean {
  const haystack = normalize(jobType);
  return wanted.some((entry) => {
    const needle = normalize(entry);
    return needle.length > 0 && (haystack === needle || haystack.includes(needle));
  });
}

function describeKeywords(keywords: readonly string[]): string {
  return keywords.slice(0, MAX_KEYWORD_REASONS).join(', ');
}

export function evaluateJob(
  job: Job,
  settings: Settings,
  now?: number,
  stage: 'discovery' | 'details' = 'details',
): JobFilterResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const includeKeywords = cleanKeywords(settings.search.includeKeywords);
  const excludeKeywords = cleanKeywords(settings.search.excludeKeywords);
  const locations = cleanKeywords(settings.search.locations);
  const employmentTypes = cleanKeywords(settings.search.employmentTypes);
  const haystack = stage === 'discovery' ? job.title : `${job.title}\n${job.description}`;

  const excludedMatches = findMatchedKeywords(haystack, excludeKeywords);
  if (excludedMatches.length > 0) {
    failures.push(`Excluded keyword: ${describeKeywords(excludedMatches)}`);
  }

  // A card cannot prove that an include keyword is absent from the full page.
  if (stage === 'details' && includeKeywords.length > 0) {
    const includedMatches = findMatchedKeywords(haystack, includeKeywords);
    if (includedMatches.length === 0) {
      failures.push(`No include keyword matched (${describeKeywords(includeKeywords)})`);
    }
  }

  if (locations.length > 0) {
    if (!job.location || job.location.trim().length === 0) {
      warnings.push('Location unknown');
    } else if (!locationMatches(job.location, locations)) {
      failures.push(`Location not in your list: ${job.location}`);
    }
  }

  if (settings.search.remoteOnly) {
    if (job.remote === undefined) {
      warnings.push('Remote status unknown');
    } else if (!job.remote) {
      failures.push('Not a remote job');
    }
  }

  if (employmentTypes.length > 0) {
    if (!job.employmentType || job.employmentType.trim().length === 0) {
      warnings.push('Employment type unknown');
    } else if (!employmentTypeMatches(job.employmentType, employmentTypes)) {
      failures.push(`Employment type not in your list: ${job.employmentType}`);
    }
  }

  const fit: FitScoreResult = scoreFit({
    title: job.title,
    description: job.description,
    includeKeywords,
    remote: job.remote,
    discoveredAt: job.discoveredAt,
    postedAt: job.postedAt,
    now,
  });

  const minFitScore = settings.search.minFitScore;
  if (stage === 'details' && minFitScore > 0 && fit.score < minFitScore) {
    failures.push(
      `Fit score ${fit.score.toFixed(2)} is below the minimum ${minFitScore.toFixed(2)}`,
    );
  }

  const pass = failures.length === 0;
  return {
    pass,
    reasons: pass ? warnings : failures,
    fitScore: fit.score,
    fitReasons: fit.reasons,
  };
}
