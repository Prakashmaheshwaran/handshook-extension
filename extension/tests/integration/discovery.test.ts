import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildNextPageUrl,
  detectEmptyState,
  extractJobCards,
  findNextPage,
  scanPage,
} from '@/handshake/discovery';
import { resetSelectorHealth } from '@/handshake/health';

const HOST = 'app.joinhandshake.com';
const SEARCH_URL = 'https://app.joinhandshake.com/job-search?q=engineer&page=1';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/synthetic/discovery', name), 'utf8');
}

function load(name: string): void {
  document.body.innerHTML = fixture(name);
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

describe('job-search pages (/job-search)', () => {
  it('classifies each card independently and recognizes employer-site labels without clicking', () => {
    document.body.innerHTML = `<main>
      <article><a href="/jobs/1001"><h2>External role</h2></a><span>Apply on employer's site</span></article>
      <article><a href="/jobs/1002"><h2>Internal role</h2></a><button>Quick apply</button></article>
      <article><a href="/jobs/1003"><h2>Unclassified role</h2></a></article>
      <article><a href="/jobs/1004"><h2>Direct external role</h2></a><a href="https://careers.example.test/apply">Apply</a></article>
    </main>`;
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    expect(extractJobCards(document, HOST).map((job) => job.applyType)).toEqual([
      'external',
      'quick_apply',
      'unknown',
      'external',
    ]);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('does not classify an external company website or a hidden badge as an application link', () => {
    document.body.innerHTML = `<article><a href="/jobs/1001"><h2>Internal role</h2></a>
      <a href="https://company.example.test">Company website</a><span hidden>Apply externally</span>
      <button>Apply</button></article>`;
    expect(extractJobCards(document, HOST)[0]?.applyType).toBe('handshake_form');
  });

  it('does not mistake incidental job copy for an external application action', () => {
    document.body.innerHTML = `<article><a href="/jobs/1001"><h2>External applications engineer</h2></a>
      <p>Help customers apply on the company site with our software.</p>
      <button>Apply</button></article>`;
    expect(extractJobCards(document, HOST)[0]?.applyType).toBe('handshake_form');
  });

  it('extracts deduplicated jobs in document order with canonical URLs', () => {
    load('job-search.html');
    const jobs = extractJobCards(document, HOST);

    expect(jobs.map((job) => job.id)).toEqual(['1001', '1002']);
    const [first, second] = jobs;
    expect(first).toMatchObject({
      id: '1001',
      host: HOST,
      title: 'Software Engineer Intern',
      employer: 'Acme Robotics',
      url: 'https://app.joinhandshake.com/jobs/1001',
      source: 'search',
      applyType: 'unknown',
      description: '',
      requiredDocumentTypes: [],
    });
    expect(first?.location).toBe('Remote (US)');
    expect(first?.employmentType).toBe('Internship');
    expect(first?.salary).toBe('$30 / hour');
    expect(first?.remote).toBe(true);
    expect(second).toMatchObject({
      id: '1002',
      title: 'Data Analyst',
      employer: 'Beta Analytics',
      location: 'Boston, MA',
      url: 'https://app.joinhandshake.com/jobs/1002',
    });
  });

  it('ignores malformed cards and links outside the result list', () => {
    load('job-search.html');
    const ids = extractJobCards(document, HOST).map((job) => job.id);
    expect(ids).not.toContain('0');
    expect(ids).not.toContain('1003');
    expect(ids).not.toContain('9999');
  });

  it('derives the next page URL without dropping the search query', () => {
    load('job-search.html');
    const result = scanPage(document, SEARCH_URL, HOST);
    expect(result.empty).toBe(false);
    expect(result.nextPageUrl).not.toBeNull();
    if (!result.nextPageUrl) return;
    const next = new URL(result.nextPageUrl);
    expect(next.searchParams.get('q')).toBe('engineer');
    expect(next.searchParams.get('page')).toBe('2');
  });

  it('does not click job cards while scanning', () => {
    load('job-search.html');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    scanPage(document, SEARCH_URL, HOST);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('reports no empty state when cards are present', () => {
    load('job-search.html');
    expect(detectEmptyState(document)).toBe(false);
  });
});

describe('postings pages (/postings)', () => {
  it('extracts cards identified by data-job-id and embedded JSON', () => {
    load('postings.html');
    const jobs = extractJobCards(document, HOST);

    expect(jobs.map((job) => job.id)).toEqual(['2001', '2002']);
    expect(jobs[0]).toMatchObject({
      id: '2001',
      title: 'Mechanical Engineer',
      employer: 'Gamma Motors',
      location: 'Detroit, MI',
      employmentType: 'Full-time',
    });
    expect(jobs[1]).toMatchObject({
      id: '2002',
      title: 'Lab Technician',
      employer: 'Delta Labs',
      location: 'Remote',
    });
    expect(jobs[1]?.remote).toBe(true);
  });

  it('returns no next URL when the Next control is disabled', () => {
    load('postings.html');
    expect(findNextPage(document)).toBeNull();
    const result = scanPage(document, 'https://app.joinhandshake.com/postings', HOST);
    expect(result.nextPageUrl).toBeNull();
    expect(result.jobs).toHaveLength(2);
  });
});

describe('empty and terminal pages', () => {
  it('detects the empty state and stops pagination', () => {
    load('empty.html');
    const result = scanPage(document, 'https://app.joinhandshake.com/job-search', HOST);
    expect(result.jobs).toEqual([]);
    expect(result.empty).toBe(true);
    expect(result.nextPageUrl).toBeNull();
    expect(detectEmptyState(document)).toBe(true);
  });

  it('finds an enabled Next button and returns its element', () => {
    load('job-search.html');
    const next = findNextPage(document);
    expect(next).not.toBeNull();
    expect(next?.textContent).toContain('Next');
  });

  it('rejects an invalid host instead of guessing URLs', () => {
    load('job-search.html');
    expect(() => extractJobCards(document, 'evil.com')).toThrow(TypeError);
    expect(() => scanPage(document, SEARCH_URL, 'joinhandshake.com.evil.com')).toThrow(TypeError);
  });
});

describe('pagination URLs', () => {
  it('increments an existing page parameter', () => {
    const next = new URL(
      buildNextPageUrl('https://app.joinhandshake.com/job-search?q=design&page=1', 2),
    );
    expect(next.searchParams.get('page')).toBe('2');
    expect(next.searchParams.get('q')).toBe('design');
  });

  it('uses paged when the page already uses paged', () => {
    const next = new URL(
      buildNextPageUrl('https://app.joinhandshake.com/postings?paged=1&location=Remote', 2),
    );
    expect(next.searchParams.get('paged')).toBe('2');
    expect(next.searchParams.has('page')).toBe(false);
    expect(next.searchParams.get('location')).toBe('Remote');
  });

  it('adds page when no pagination parameter exists', () => {
    const next = new URL(buildNextPageUrl('https://app.joinhandshake.com/postings?q=data', 3));
    expect(next.searchParams.get('page')).toBe('3');
    expect(next.searchParams.get('q')).toBe('data');
  });

  it('rejects a non-positive page number', () => {
    expect(() => buildNextPageUrl(SEARCH_URL, 0)).toThrow(RangeError);
    expect(() => buildNextPageUrl(SEARCH_URL, 1.5)).toThrow(RangeError);
  });
});
