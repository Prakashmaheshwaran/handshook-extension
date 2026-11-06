/**
 * Handshake host and URL helpers. Only HTTPS Handshake hosts are accepted;
 * everything else is treated as an external site.
 */

export const HANDSHAKE_APEX_DOMAINS = ['joinhandshake.com', 'joinhandshake.co.uk'] as const;

export type HandshakePageType = 'search' | 'job' | 'documents' | 'my_jobs' | 'login' | 'unknown';

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const JOB_PATH = /^\/(?:stu\/)?jobs\/\d+(?:\/|$)/;
const SEARCH_PATHS = new Set([
  '/job-search',
  '/job_search',
  '/jobs',
  '/jobs/search',
  '/postings',
  '/search',
  '/stu/jobs',
  '/stu/search',
]);
const DOCUMENT_PATH = /^\/(?:(?:stu\/|profile\/)?documents?|docs)(?:\/|$)/;
const MY_JOBS_PATH = /^\/(?:my[-_]jobs|my[-_]applications|applications|stu\/applications)(?:\/|$)/;
const LOGIN_PATH = /^\/(?:login|log[-_]?in|signin|sign[-_]in|sso|auth|users\/sign_in)(?:\/|$)/;

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/** True for the apex domains and any subdomain of them. */
export function parseHandshakeHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || host.length > 253) return false;
  if (host.includes('..')) return false;
  const labels = host.split('.');
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  return HANDSHAKE_APEX_DOMAINS.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/** Lowercased hostname from a `Location`-like object. */
export function currentHost(
  locationLike: Pick<Location, 'hostname'> = globalThis.location,
): string {
  return normalizeHostname(locationLike?.hostname ?? '');
}

/** Numeric Handshake job IDs, stored as strings. */
export function isValidJobId(id: string): boolean {
  if (!/^\d{1,20}$/.test(id)) return false;
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function assertHandshakeHost(host: string): string {
  const normalized = normalizeHostname(host);
  if (!parseHandshakeHost(normalized)) {
    throw new TypeError('Refusing to build a URL for a non-Handshake host');
  }
  return normalized;
}

export function buildJobUrl(host: string, id: string): string {
  const safeHost = assertHandshakeHost(host);
  if (!isValidJobId(id)) {
    throw new TypeError('Invalid Handshake job ID');
  }
  return `https://${safeHost}/jobs/${id}`;
}

export type SearchParamsInput = Record<string, string | number | boolean | undefined | null>;

export type SearchPath = '/job-search' | '/postings';

export function buildSearchUrl(
  host: string,
  params: SearchParamsInput = {},
  path: SearchPath = '/job-search',
): string {
  const safeHost = assertHandshakeHost(host);
  const url = new URL(path, `https://${safeHost}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isAllowedHandshakeUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    parseHandshakeHost(url.hostname)
  );
}

/**
 * Remove pagination, referral, and analytics parameters while preserving
 * every other query parameter. Throws on non-HTTPS or non-Handshake URLs.
 */
export function sanitizeSearchUrl(input: string): string {
  const url = new URL(input);
  if (!isAllowedHandshakeUrl(url)) {
    throw new TypeError('Not a Handshake URL');
  }
  const dropped = new Set(['page', 'paged', 'ref', 'referrer']);
  for (const key of Array.from(url.searchParams.keys())) {
    const lower = key.toLowerCase();
    if (dropped.has(lower) || lower.startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.hash = '';
  return url.toString();
}

/** True only for absolute HTTPS URLs on an allowed Handshake host. */
export function isHandshakeUrl(input: string): boolean {
  try {
    return isAllowedHandshakeUrl(new URL(input));
  } catch {
    return false;
  }
}

function pathnameOf(pathnameOrUrl: string): string {
  const value = pathnameOrUrl.trim();
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

/** Classify a pathname (or absolute URL) into the adapter that owns it. */
export function detectPageType(pathnameOrUrl: string): HandshakePageType {
  const path = pathnameOf(pathnameOrUrl).toLowerCase();
  if (path.length === 0) return 'unknown';
  if (JOB_PATH.test(path)) return 'job';
  if (SEARCH_PATHS.has(path) || path.startsWith('/job-search/') || path.startsWith('/postings/')) {
    return 'search';
  }
  if (DOCUMENT_PATH.test(path)) return 'documents';
  if (MY_JOBS_PATH.test(path)) return 'my_jobs';
  if (LOGIN_PATH.test(path)) return 'login';
  return 'unknown';
}
