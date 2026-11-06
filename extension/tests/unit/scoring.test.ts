import { describe, expect, it } from 'vitest';
import {
  FIT_WEIGHTS,
  findMatchedKeywords,
  freshnessScore,
  scoreFit,
  tokenize,
} from '@/core/scoring';

const NOW = 1_000 * 86_400_000;
const DAY_MS = 86_400_000;

describe('findMatchedKeywords', () => {
  it('de-duplicates keywords case-insensitively and preserves configuration order', () => {
    expect(findMatchedKeywords('Python and python', ['Python', 'python', 'go'])).toEqual([
      'Python',
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(findMatchedKeywords('', ['engineer'])).toEqual([]);
    expect(findMatchedKeywords('engineer', [])).toEqual([]);
  });
});

describe('tokenize', () => {
  it('drops stop words and single characters', () => {
    expect(tokenize('A C++ engineer at the company')).toEqual(['c++', 'engineer', 'company']);
  });
});

describe('freshnessScore', () => {
  it('scores recent postings highest', () => {
    expect(freshnessScore(NOW - DAY_MS, NOW)).toEqual({ score: 1, reason: 'Posted recently' });
    expect(freshnessScore(NOW - 5 * DAY_MS, NOW).score).toBe(0.85);
    expect(freshnessScore(NOW - 10 * DAY_MS, NOW).score).toBe(0.7);
    expect(freshnessScore(NOW - 20 * DAY_MS, NOW).score).toBe(0.5);
    expect(freshnessScore(NOW - 60 * DAY_MS, NOW).score).toBe(0.25);
    expect(freshnessScore(NOW - 200 * DAY_MS, NOW).score).toBe(0.1);
  });

  it('is neutral when the reference time or posting date is unknown', () => {
    expect(freshnessScore(undefined, NOW).score).toBe(0.5);
    expect(freshnessScore(NOW, undefined).score).toBe(0.5);
    expect(freshnessScore(undefined, NOW).reason).toBe('Freshness unknown');
  });
});

describe('scoreFit', () => {
  it('applies the documented weights to keyword coverage', () => {
    const result = scoreFit({
      title: 'Software Engineer Intern',
      description: 'Python and SQL.',
      includeKeywords: ['engineer', 'python'],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });

    // 0.6 * (1/2) + 0.25 * (1/2) + 0.15 * 1
    expect(result.score).toBe(0.575);
    expect(result.breakdown).toEqual({ title: 0.5, description: 0.5, freshness: 1 });
    expect(result.reasons).toEqual([
      'Title matches: engineer',
      'Description matches: python',
      'Posted recently',
    ]);
  });

  it('weights title matches above description matches', () => {
    const titleMatch = scoreFit({
      title: 'Python Developer',
      description: 'No keywords here.',
      includeKeywords: ['python'],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });
    const descriptionMatch = scoreFit({
      title: 'Developer',
      description: 'Python.',
      includeKeywords: ['python'],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });

    expect(titleMatch.score).toBeGreaterThan(descriptionMatch.score);
    expect(titleMatch.score).toBe(0.75);
    expect(descriptionMatch.score).toBe(0.4);
  });

  it('stays within 0..1 and clamps rounding noise', () => {
    const perfect = scoreFit({
      title: 'Engineer',
      description: 'Engineer',
      includeKeywords: ['engineer'],
      discoveredAt: NOW,
      now: NOW,
    });
    const empty = scoreFit({ title: '', description: '', includeKeywords: ['engineer'], now: NOW });

    expect(perfect.score).toBe(1);
    expect(empty.score).toBeGreaterThanOrEqual(0);
    expect(empty.score).toBeLessThanOrEqual(1);
  });

  it('scores listing quality instead of zero when no keywords are configured', () => {
    const supported = scoreFit({
      title: 'Backend Engineer',
      description: 'Backend engineer role.',
      includeKeywords: [],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });
    expect(supported.score).toBe(1);
    expect(supported.reasons).toEqual([
      'No target keywords set',
      'Description supports the title',
      'Posted recently',
    ]);

    const sparse = scoreFit({
      title: 'Backend Engineer',
      description: 'We are hiring.',
      includeKeywords: [],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });
    expect(sparse.score).toBe(0.75);
    expect(sparse.reasons).toContain('Description has little detail');
  });

  it('explains a missing title match', () => {
    const result = scoreFit({
      title: 'Product Designer',
      description: 'Work with Python.',
      includeKeywords: ['python'],
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    });

    expect(result.reasons[0]).toBe('No title keyword match');
    expect(result.reasons).toContain('Description matches: python');
  });

  it('marks freshness as unknown when no reference time is provided', () => {
    const result = scoreFit({
      title: 'Engineer',
      description: '',
      includeKeywords: ['engineer'],
      discoveredAt: NOW,
    });

    expect(result.breakdown.freshness).toBe(0.5);
    expect(result.reasons).toContain('Freshness unknown');
  });

  it('mentions remote when the job is remote', () => {
    const result = scoreFit({
      title: 'Engineer',
      description: '',
      includeKeywords: ['engineer'],
      remote: true,
      discoveredAt: NOW - 60 * DAY_MS,
      now: NOW,
    });

    expect(result.reasons).toContain('Remote');
  });

  it('is deterministic and returns at most three reasons', () => {
    const input = {
      title: 'Software Engineer',
      description: 'Python and Go.',
      includeKeywords: ['engineer', 'python'],
      remote: true,
      discoveredAt: NOW - DAY_MS,
      now: NOW,
    };
    const first = scoreFit(input);
    const second = scoreFit(input);

    expect(first).toEqual(second);
    expect(first.reasons.length).toBeLessThanOrEqual(3);
  });

  it('exposes weights that sum to one', () => {
    expect(FIT_WEIGHTS.title + FIT_WEIGHTS.description + FIT_WEIGHTS.freshness).toBeCloseTo(1);
  });
});
