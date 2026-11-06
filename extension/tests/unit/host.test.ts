import { describe, expect, it } from 'vitest';
import {
  buildJobUrl,
  buildSearchUrl,
  currentHost,
  detectPageType,
  isHandshakeUrl,
  isValidJobId,
  parseHandshakeHost,
  sanitizeSearchUrl,
} from '@/handshake/host';

describe('Handshake host parsing', () => {
  it('accepts the apex domains and school subdomains', () => {
    expect(parseHandshakeHost('joinhandshake.com')).toBe(true);
    expect(parseHandshakeHost('app.joinhandshake.com')).toBe(true);
    expect(parseHandshakeHost('careers.engineering.joinhandshake.com')).toBe(true);
    expect(parseHandshakeHost('joinhandshake.co.uk')).toBe(true);
    expect(parseHandshakeHost('app.joinhandshake.co.uk')).toBe(true);
  });

  it('normalizes case and a trailing dot', () => {
    expect(parseHandshakeHost('  APP.JoinHandshake.COM. ')).toBe(true);
  });

  it('rejects unrelated, lookalike, and malformed hosts', () => {
    expect(parseHandshakeHost('evil.com')).toBe(false);
    expect(parseHandshakeHost('joinhandshake.com.evil.com')).toBe(false);
    expect(parseHandshakeHost('notjoinhandshake.com')).toBe(false);
    expect(parseHandshakeHost('joinhandshake.co')).toBe(false);
    expect(parseHandshakeHost('')).toBe(false);
    expect(parseHandshakeHost('app..joinhandshake.com')).toBe(false);
    expect(parseHandshakeHost('-app.joinhandshake.com')).toBe(false);
  });

  it('reads the current host in lowercase', () => {
    expect(currentHost({ hostname: 'APP.JoinHandshake.com' })).toBe('app.joinhandshake.com');
    expect(currentHost({ hostname: '' })).toBe('');
  });
});

describe('job IDs and URLs', () => {
  it('accepts positive safe numeric IDs only', () => {
    expect(isValidJobId('1')).toBe(true);
    expect(isValidJobId('1001')).toBe(true);
    expect(isValidJobId('0')).toBe(false);
    expect(isValidJobId('01a')).toBe(false);
    expect(isValidJobId('-1')).toBe(false);
    expect(isValidJobId('  12 ')).toBe(false);
  });

  it('builds canonical HTTPS job URLs', () => {
    expect(buildJobUrl('app.joinhandshake.com', '1001')).toBe(
      'https://app.joinhandshake.com/jobs/1001',
    );
  });

  it('refuses to build URLs for other hosts or malformed IDs', () => {
    expect(() => buildJobUrl('evil.com', '1001')).toThrow(TypeError);
    expect(() => buildJobUrl('app.joinhandshake.com', 'abc')).toThrow(TypeError);
  });

  it('builds search URLs and skips empty parameters', () => {
    const url = new URL(
      buildSearchUrl('app.joinhandshake.com', {
        q: 'software engineer',
        location: 'Boston',
        page: 2,
        empty: '',
        missing: undefined,
      }),
    );
    expect(url.origin).toBe('https://app.joinhandshake.com');
    expect(url.pathname).toBe('/job-search');
    expect(url.searchParams.get('q')).toBe('software engineer');
    expect(url.searchParams.get('location')).toBe('Boston');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('empty')).toBe(false);
    expect(url.searchParams.has('missing')).toBe(false);
    expect(buildSearchUrl('app.joinhandshake.com')).toBe(
      'https://app.joinhandshake.com/job-search',
    );
    const postings = new URL(buildSearchUrl('app.joinhandshake.com', { q: 'data' }, '/postings'));
    expect(postings.pathname).toBe('/postings');
    expect(postings.searchParams.get('q')).toBe('data');
    expect(() => buildSearchUrl('evil.com')).toThrow(TypeError);
  });
});

describe('search URL sanitization', () => {
  it('strips pagination, referrals, and UTM parameters but keeps the query', () => {
    const sanitized = new URL(
      sanitizeSearchUrl(
        'https://app.joinhandshake.com/job-search?q=engineer&page=2&paged=3&ref=nav&utm_source=email&utm_medium=digest&location=Remote#results',
      ),
    );
    expect(sanitized.searchParams.get('q')).toBe('engineer');
    expect(sanitized.searchParams.get('location')).toBe('Remote');
    expect(sanitized.searchParams.has('page')).toBe(false);
    expect(sanitized.searchParams.has('paged')).toBe(false);
    expect(sanitized.searchParams.has('ref')).toBe(false);
    expect(sanitized.searchParams.has('utm_source')).toBe(false);
    expect(sanitized.searchParams.has('utm_medium')).toBe(false);
    expect(sanitized.hash).toBe('');
  });

  it('rejects non-HTTPS and non-Handshake URLs', () => {
    expect(() => sanitizeSearchUrl('http://app.joinhandshake.com/job-search')).toThrow(TypeError);
    expect(() => sanitizeSearchUrl('https://evil.com/job-search')).toThrow(TypeError);
    expect(() => sanitizeSearchUrl('not a url')).toThrow();
  });

  it('validates absolute URLs', () => {
    expect(isHandshakeUrl('https://app.joinhandshake.com/jobs/1')).toBe(true);
    expect(isHandshakeUrl('https://joinhandshake.co.uk/postings')).toBe(true);
    expect(isHandshakeUrl('http://app.joinhandshake.com/jobs/1')).toBe(false);
    expect(isHandshakeUrl('https://evil.com/jobs/1')).toBe(false);
    expect(isHandshakeUrl('https://user:pass@app.joinhandshake.com/jobs/1')).toBe(false);
    expect(isHandshakeUrl('/jobs/1')).toBe(false);
    expect(isHandshakeUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('page type detection', () => {
  it('classifies search variants including both historical URL forms', () => {
    expect(detectPageType('/job-search')).toBe('search');
    expect(detectPageType('/job-search?q=design')).toBe('search');
    expect(detectPageType('/postings')).toBe('search');
    expect(detectPageType('/postings/2')).toBe('search');
    expect(detectPageType('/stu/jobs')).toBe('search');
    expect(detectPageType('https://app.joinhandshake.com/job-search?q=x')).toBe('search');
  });

  it('classifies job detail paths, including school variants', () => {
    expect(detectPageType('/jobs/1001')).toBe('job');
    expect(detectPageType('/jobs/1001/apply')).toBe('job');
    expect(detectPageType('/stu/jobs/1001')).toBe('job');
  });

  it('classifies documents, my jobs, and login', () => {
    expect(detectPageType('/profile/documents')).toBe('documents');
    expect(detectPageType('/documents/')).toBe('documents');
    expect(detectPageType('/docs')).toBe('documents');
    expect(detectPageType('/my-jobs')).toBe('my_jobs');
    expect(detectPageType('/applications')).toBe('my_jobs');
    expect(detectPageType('/login')).toBe('login');
    expect(detectPageType('/sign_in')).toBe('login');
  });

  it('returns unknown for unrelated paths', () => {
    expect(detectPageType('/')).toBe('unknown');
    expect(detectPageType('/companies/acme')).toBe('unknown');
    expect(detectPageType('/jobs')).not.toBe('job');
  });
});
