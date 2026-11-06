import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectEmptyState, extractJobCards, findNextPage, scanPage } from '@/handshake/discovery';
import { findFirstStrategy, resetSelectorHealth } from '@/handshake/health';
import {
  CARD_HOOK_SELECTOR,
  cardHookId,
  discoverySelectors,
} from '@/handshake/selectors/discovery';
import { extractJobId } from '@/handshake/urls';

const HOST = 'app.joinhandshake.com';
const SEARCH_URL = 'https://app.joinhandshake.com/job-search?q=data&page=1';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/live/discovery', name), 'utf8');
}

function load(name: string): void {
  document.body.innerHTML = fixture(name);
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

describe('live job-search cards', () => {
  it('extracts every result card identified by the data-hook id', () => {
    load('job-search.html');
    const jobs = extractJobCards(document, HOST);
    expect(jobs.map((job) => job.id)).toEqual(['90000001', '90000002', '90000003']);
    expect(jobs.every((job) => job.host === HOST)).toBe(true);
    expect(jobs[0]?.url).toBe('https://app.joinhandshake.com/jobs/90000001');
  });

  it('reads title, employer and footer location from the live card structure', () => {
    load('job-search.html');
    const [first] = extractJobCards(document, HOST);
    expect(first).toMatchObject({
      id: '90000001',
      title: 'Data Analyst Intern',
      employer: 'Employer A',
      location: 'Austin, TX',
      employmentType: 'Internship',
      salary: '$25-30/hr',
      applyType: 'unknown',
      source: 'search',
    });
    expect(first?.remote).toBeFalsy();
  });

  it('skips a promoted footer label and splits the shared salary/type line', () => {
    load('job-search.html');
    const promoted = extractJobCards(document, HOST).find((job) => job.id === '90000002');
    expect(promoted).toMatchObject({
      title: 'Software Engineer',
      employer: 'Employer B',
      location: 'New York, NY',
      employmentType: 'Full-time',
      salary: '$120-140K/yr',
    });
  });

  it('keeps remote cards without a salary', () => {
    load('job-search.html');
    const remote = extractJobCards(document, HOST).find((job) => job.id === '90000003');
    expect(remote).toMatchObject({
      title: 'Lab Assistant',
      employer: 'Employer C',
      location: 'Remote',
      employmentType: 'Part-time',
      remote: true,
    });
    expect(remote?.salary).toBeUndefined();
  });

  it('does not turn sidebar recommendations into jobs', () => {
    load('job-search.html');
    const ids = extractJobCards(document, HOST).map((job) => job.id);
    expect(ids).not.toContain('90009999');
  });

  it('does not turn split-view similar-job links into result cards', () => {
    load('job-search.html');
    const ids = extractJobCards(document, HOST).map((job) => job.id);
    expect(ids).not.toContain('90008888');
    expect(ids).toHaveLength(3);
  });

  it('matches the verified card hook and extracts its id', () => {
    load('job-search.html');
    const cards = Array.from(document.querySelectorAll(CARD_HOOK_SELECTOR));
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => cardHookId(card))).toEqual(['90000001', '90000002', '90000003']);

    const card = findFirstStrategy(discoverySelectors.jobCard, document);
    expect(card).not.toBeNull();
    expect(cardHookId(card)).toBe('90000001');

    const title = findFirstStrategy(discoverySelectors.title, cards[1] as Element);
    expect(title?.textContent?.trim()).toBe('Software Engineer');
  });
});

describe('live pagination', () => {
  it('finds the enabled next control inside the pagination hook', () => {
    load('job-search.html');
    const next = findNextPage(document);
    expect(next).not.toBeNull();
    expect(next?.getAttribute('aria-label')).toBe('next page');
  });

  it('ignores a disabled next control', () => {
    load('job-search.html');
    const next = document.querySelector(
      '[data-hook="job-search-pagination"] button[aria-label="next page"]',
    );
    expect(next).not.toBeNull();
    next?.setAttribute('disabled', '');
    expect(findNextPage(document)).toBeNull();
  });

  it('derives the next page URL without dropping the search query', () => {
    load('job-search.html');
    const result = scanPage(document, SEARCH_URL, HOST);
    expect(result.empty).toBe(false);
    expect(result.jobs).toHaveLength(3);
    if (!result.nextPageUrl) throw new Error('expected a next page URL');
    const next = new URL(result.nextPageUrl);
    expect(next.searchParams.get('q')).toBe('data');
    expect(next.searchParams.get('page')).toBe('2');
  });
});

describe('empty state from the results announcer', () => {
  it('is false while the announcer reports results', () => {
    load('job-search.html');
    expect(detectEmptyState(document)).toBe(false);
  });

  it('is true when the announcer reports zero jobs', () => {
    load('job-search.html');
    const announcer = document.querySelector('[data-hook="job-search-results-status-announcer"]');
    expect(announcer).not.toBeNull();
    if (announcer) announcer.textContent = '0 jobs found';
    expect(detectEmptyState(document)).toBe(true);
  });
});

describe('live URL shapes', () => {
  it('parses a /job-search/{id} card href', () => {
    expect(extractJobId('/job-search/90000001?page=1&per_page=25')).toBe('90000001');
    expect(extractJobId('/jobs/90000002')).toBe('90000002');
  });

  it('does not treat the bare search route as a job id', () => {
    expect(extractJobId('/job-search')).toBeNull();
    expect(extractJobId('/job-search?page=2')).toBeNull();
  });
});
