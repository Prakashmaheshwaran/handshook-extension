import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Job,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { evaluateJob, matchesAnyKeyword } from '@/core/filters';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '1001',
    host: 'app.joinhandshake.com',
    title: 'Software Engineer Intern',
    employer: 'Acme',
    url: 'https://app.joinhandshake.com/jobs/1001',
    description: 'Build TypeScript services with the team.',
    location: 'San Francisco, CA',
    employmentType: 'Internship',
    remote: false,
    applyType: 'quick_apply',
    requiredDocumentTypes: [],
    source: 'search',
    discoveredAt: 1_000,
    ...overrides,
  };
}

function makeSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(structuredClone(DEFAULT_SETTINGS), patch);
}

const NOW = 1_000 * 86_400_000;

describe('matchesAnyKeyword', () => {
  it('matches case-insensitively', () => {
    expect(matchesAnyKeyword('Senior SOFTWARE Engineer', ['engineer'])).toBe(true);
    expect(matchesAnyKeyword('senior software engineer', ['SOFTWARE'])).toBe(true);
  });

  it('respects word boundaries', () => {
    expect(matchesAnyKeyword('Engineering Internship', ['engineer'])).toBe(false);
    expect(matchesAnyKeyword('Cartography Analyst', ['art'])).toBe(false);
    expect(matchesAnyKeyword('Support Engineer', ['engineer'])).toBe(true);
  });

  it('matches multi-word keywords across any whitespace', () => {
    expect(matchesAnyKeyword('Machine   Learning Engineer', ['machine learning'])).toBe(true);
    expect(matchesAnyKeyword('machine\nlearning', ['machine learning'])).toBe(true);
    expect(matchesAnyKeyword('Machine Operator', ['machine learning'])).toBe(false);
  });

  it('handles punctuation-heavy keywords', () => {
    expect(matchesAnyKeyword('C++ Developer', ['c++'])).toBe(true);
    expect(matchesAnyKeyword('Node.js Engineer', ['node.js'])).toBe(true);
  });

  it('ignores blank patterns and returns false for no patterns', () => {
    expect(matchesAnyKeyword('Software Engineer', [])).toBe(false);
    expect(matchesAnyKeyword('Software Engineer', ['   ', ''])).toBe(false);
  });
});

describe('evaluateJob keyword filters', () => {
  it('excludes a job when an exclude keyword appears in the title', () => {
    const settings = makeSettings({ search: { excludeKeywords: ['senior'] } });
    const result = evaluateJob(makeJob({ title: 'Senior Software Engineer' }), settings);

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/excluded keyword: senior/i);
  });

  it('excludes a job when an exclude keyword appears in the description', () => {
    const settings = makeSettings({ search: { excludeKeywords: ['clearance'] } });
    const result = evaluateJob(
      makeJob({ description: 'Requires an active security clearance.' }),
      settings,
    );

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/excluded keyword: clearance/i);
  });

  it('passes when no include keywords are configured', () => {
    const result = evaluateJob(makeJob(), makeSettings());
    expect(result.pass).toBe(true);
  });

  it('ignores blank include keywords instead of failing everything', () => {
    const settings = makeSettings({ search: { includeKeywords: ['   ', ''] } });
    expect(evaluateJob(makeJob(), settings).pass).toBe(true);
  });

  it('passes when at least one include keyword matches', () => {
    const settings = makeSettings({
      search: { includeKeywords: ['designer', 'engineer'], minFitScore: 0 },
    });
    const result = evaluateJob(makeJob(), settings, NOW);
    expect(result.pass).toBe(true);
  });

  it('fails when no include keyword matches title or description', () => {
    const settings = makeSettings({ search: { includeKeywords: ['nurse'] } });
    const result = evaluateJob(makeJob(), settings, NOW);

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no include keyword matched/i);
  });
});

describe('evaluateJob location, remote, and employment type filters', () => {
  it('passes a location that matches the configured list', () => {
    const settings = makeSettings({ search: { locations: ['new york', 'san francisco'] } });
    const result = evaluateJob(makeJob({ location: 'San Francisco, CA' }), settings, NOW);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails a location outside the configured list', () => {
    const settings = makeSettings({ search: { locations: ['new york'] } });
    const result = evaluateJob(makeJob({ location: 'Austin, TX' }), settings, NOW);

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/location not in your list: austin, tx/i);
  });

  it('matches when the configured location is more specific than the posting', () => {
    const settings = makeSettings({ search: { locations: ['san francisco, ca'] } });
    expect(evaluateJob(makeJob({ location: 'San Francisco' }), settings, NOW).pass).toBe(true);
  });

  it('does not treat a short location as a substring of a longer city', () => {
    const settings = makeSettings({ search: { locations: ['austin'] } });
    const result = evaluateJob(makeJob({ location: 'US' }), settings, NOW);

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/location not in your list: us/i);
  });

  it('ignores blank location and employment-type entries', () => {
    const settings = makeSettings({
      search: { locations: ['  '], employmentTypes: [''] },
    });
    const result = evaluateJob(
      makeJob({ location: undefined, employmentType: undefined }),
      settings,
    );
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('passes an unknown location with a warning', () => {
    const settings = makeSettings({ search: { locations: ['new york'] } });
    const result = evaluateJob(makeJob({ location: undefined }), settings, NOW);

    expect(result.pass).toBe(true);
    expect(result.reasons).toContain('Location unknown');
  });

  it('treats a blank location as unknown', () => {
    const settings = makeSettings({ search: { locations: ['new york'] } });
    const result = evaluateJob(makeJob({ location: '   ' }), settings, NOW);
    expect(result.pass).toBe(true);
    expect(result.reasons).toContain('Location unknown');
  });

  it('requires remote jobs when remoteOnly is set', () => {
    const settings = makeSettings({ search: { remoteOnly: true } });
    expect(evaluateJob(makeJob({ remote: true }), settings, NOW).pass).toBe(true);

    const office = evaluateJob(makeJob({ remote: false }), settings, NOW);
    expect(office.pass).toBe(false);
    expect(office.reasons.join(' ')).toMatch(/not a remote job/i);
  });

  it('passes an unknown remote status with a warning', () => {
    const settings = makeSettings({ search: { remoteOnly: true } });
    const result = evaluateJob(makeJob({ remote: undefined }), settings, NOW);

    expect(result.pass).toBe(true);
    expect(result.reasons).toContain('Remote status unknown');
  });

  it('matches employment types case-insensitively', () => {
    const settings = makeSettings({ search: { employmentTypes: ['internship'] } });
    expect(evaluateJob(makeJob({ employmentType: 'Internship' }), settings, NOW).pass).toBe(true);
  });

  it('fails an employment type outside the configured list', () => {
    const settings = makeSettings({ search: { employmentTypes: ['Internship'] } });
    const result = evaluateJob(makeJob({ employmentType: 'Full-time' }), settings, NOW);

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/employment type not in your list: full-time/i);
  });

  it('passes an unknown employment type with a warning', () => {
    const settings = makeSettings({ search: { employmentTypes: ['Internship'] } });
    const result = evaluateJob(makeJob({ employmentType: undefined }), settings, NOW);

    expect(result.pass).toBe(true);
    expect(result.reasons).toContain('Employment type unknown');
  });
});

describe('evaluateJob fit scoring', () => {
  it('fails a job below minFitScore and explains why', () => {
    const settings = makeSettings({
      search: {
        includeKeywords: ['engineer', 'python', 'rust', 'golang'],
        minFitScore: 0.55,
      },
    });
    const result = evaluateJob(
      makeJob({ description: 'Build things.', discoveredAt: NOW - 2 * 86_400_000 }),
      settings,
      NOW,
    );

    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/fit score 0\.30 is below the minimum 0\.55/i);
  });

  it('passes a job at or above minFitScore', () => {
    const settings = makeSettings({
      search: { includeKeywords: ['engineer', 'python'], minFitScore: 0.55 },
    });
    const result = evaluateJob(
      makeJob({
        title: 'Software Engineer',
        description: 'Python services for the platform.',
        discoveredAt: NOW - 86_400_000,
      }),
      settings,
      NOW,
    );

    expect(result.pass).toBe(true);
    expect(result.fitScore).toBeGreaterThanOrEqual(0.55);
  });

  it('returns the top fit reasons for the queue UI', () => {
    const settings = makeSettings({ search: { includeKeywords: ['engineer', 'python'] } });
    const result = evaluateJob(
      makeJob({
        description: 'Python services for the platform.',
        remote: true,
        discoveredAt: NOW - 86_400_000,
      }),
      settings,
      NOW,
    );

    expect(result.fitReasons.length).toBeLessThanOrEqual(3);
    expect(result.fitReasons[0]).toBe('Title matches: engineer');
    expect(result.fitReasons[1]).toBe('Description matches: python');
    expect(result.fitReasons[2]).toBe('Posted recently');
  });

  it('is deterministic for the same job, settings, and reference time', () => {
    const settings = makeSettings({ search: { includeKeywords: ['engineer'], minFitScore: 0 } });
    const job = makeJob({ remote: true });
    expect(evaluateJob(job, settings, NOW)).toEqual(evaluateJob(job, settings, NOW));
  });

  it('does not drop a plain job under default settings', () => {
    const result = evaluateJob(
      makeJob({ title: 'Barista', description: 'Make coffee.', remote: undefined }),
      makeSettings(),
      NOW,
    );
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
