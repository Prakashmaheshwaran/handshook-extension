/**
 * Search-page discovery: extract job cards, detect pagination and empty
 * states. This module never navigates and never clicks a job card; the content
 * runner owns pagination.
 */

import type { Job } from '@/core/contracts';
import { collapseWhitespace, getAccessibleName, normalizeText } from './text';
import { findFirstStrategy, runStrategy } from './health';
import { buildJobUrl, parseHandshakeHost } from './host';
import { CARD_HOOK_SELECTOR, cardHookId, discoverySelectors } from './selectors/discovery';
import { extractEmbeddedJobId, extractJobId, readPageNumber } from './urls';
import { isDisabledElement } from './dom';
import { classifyCardApplyType, externalApplyUrl } from './applyType';

const MAX_CARD_WALK_DEPTH = 12;

export interface ScanResult {
  readonly jobs: Job[];
  readonly nextPageUrl: string | null;
  readonly empty: boolean;
  /** How the list looked while reading it; live diagnosis only. */
  readonly diagnostics?: {
    readonly probes: number;
    readonly firstCount: number;
    readonly scrolled: boolean;
  };
}

interface CardCandidate {
  readonly id: string;
  readonly anchor: Element | null;
  readonly card: Element;
}

const EMPLOYMENT_WORD =
  /\b(internship|intern|full[- ]?time|part[- ]?time|contract|temporary|co[- ]?op|fellowship|seasonal)\b/i;
const SALARY_PATTERN = /\$\s?\d|\d+\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|week)/;
const POSTED_PREFIX = /^(posted|posted on|posted at|new|easy apply|save|view)\b/;
const META_SEPARATOR = /\s*[·|]\s*/;

/**
 * Live cards combine salary, employment type and dates into one line such as
 * `"$25-30/hr · Internship · Jun 1—Aug 1"`. Keep only the segment matching the
 * requested field so the Job record stays clean.
 */
function fieldSegment(value: string, pattern: RegExp): string {
  const parts = value.split(META_SEPARATOR);
  if (parts.length < 2) return value;
  return parts.find((part) => pattern.test(part))?.trim() ?? value;
}

function isCardLike(el: Element): boolean {
  if (el.matches(CARD_HOOK_SELECTOR)) return true;
  if (el.tagName === 'ARTICLE' || el.tagName === 'LI') return true;
  if (el.getAttribute('role') === 'listitem') return true;
  if (el.hasAttribute('data-job-id')) return true;
  const testId = normalizeText(el.getAttribute('data-testid') ?? '');
  const className = normalizeText(el.getAttribute('class') ?? '');
  return (
    testId.includes('job card') ||
    testId.includes('jobcard') ||
    className.includes('job card') ||
    className.includes('jobcard')
  );
}

function findCardContainer(el: Element): Element | null {
  const doc = el.ownerDocument;
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < MAX_CARD_WALK_DEPTH) {
    if (node === doc.body || node === doc.documentElement) break;
    if (isCardLike(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  const fallback = el.parentElement;
  if (!fallback || fallback === doc.body || fallback === doc.documentElement) return null;
  return fallback;
}

function isUnrelatedAnchor(anchor: Element): boolean {
  const chrome = anchor.closest('nav, header, footer, aside');
  if (!chrome) return false;
  return !anchor.closest(
    'article, li, [role="listitem"], [data-job-id], [data-testid*="job" i], [data-testid*="card" i]',
  );
}

function idsIn(card: Element): Set<string> {
  const ids = new Set<string>();
  const hookId = cardHookId(card);
  if (hookId) ids.add(hookId);
  for (const anchor of Array.from(card.querySelectorAll('a[href]'))) {
    const id = extractJobId(anchor.getAttribute('href'));
    if (id) ids.add(id);
  }
  for (const el of Array.from(card.querySelectorAll('[data-job-id], [data-jobid]'))) {
    const id = extractJobId(el.getAttribute('data-job-id') ?? el.getAttribute('data-jobid'));
    if (id) ids.add(id);
  }
  return ids;
}

function collectCardCandidates(doc: Document): CardCandidate[] {
  const candidates: CardCandidate[] = [];

  const push = (id: string | null, anchor: Element | null, card: Element | null): void => {
    if (!id || !card) return;
    candidates.push({ id, anchor, card });
  };

  // Live result cards carry their own stable identity, independent of the
  // anchor shape (the tenant links cards to `/job-search/{id}`).
  const liveCards = Array.from(doc.querySelectorAll(CARD_HOOK_SELECTOR));
  for (const card of liveCards) {
    const id = cardHookId(card);
    if (!id) continue;
    push(id, card.querySelector('a[href]'), card);
  }

  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const id = extractJobId(anchor.getAttribute('href'));
    if (!id || isUnrelatedAnchor(anchor)) continue;
    // On a live split-view search page, "Similar Jobs" links point at real
    // `/jobs/{id}` routes but are not results. When result cards exist, only
    // anchors inside a card are card candidates.
    if (liveCards.length > 0 && !anchor.closest(CARD_HOOK_SELECTOR)) continue;
    let card = findCardContainer(anchor);
    if (card && idsIn(card).size > 1 && !isCardLike(card)) {
      card = anchor.parentElement ?? card;
    }
    push(id, anchor, card);
  }

  for (const el of Array.from(doc.querySelectorAll('[data-job-id], [data-jobid]'))) {
    if (el.tagName === 'A' && el.hasAttribute('href')) continue;
    const id = extractJobId(el.getAttribute('data-job-id') ?? el.getAttribute('data-jobid'));
    if (!id) continue;
    const card = isCardLike(el) ? el : findCardContainer(el);
    push(id, null, card);
  }

  // Embedded JSON is only trusted inside a single card, never for a global
  // page payload (which would yield one nonsense card for the whole page).
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const text = script.textContent ?? '';
    if (text.length === 0) continue;
    const id = extractEmbeddedJobId(text);
    if (!id) continue;
    const card = findCardContainer(script);
    if (!card || !isCardLike(card) || idsIn(card).size > 1) continue;
    push(id, null, card);
  }

  return candidates;
}

function cardTextLines(card: Element): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(card.querySelectorAll('p, span, small, time, div, li'))) {
    if (el.childElementCount > 0) continue;
    const text = collapseWhitespace(el.textContent ?? '');
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines;
}

function looksLikeLocation(line: string): boolean {
  const normalized = normalizeText(line);
  if (normalized.length === 0) return false;
  if (normalized === 'remote' || normalized.startsWith('remote ')) return true;
  return /^[^,]{2,48},\s*[a-z]{2}(?:\s|,|$)/i.test(line);
}

function readField(card: Element, group: keyof typeof discoverySelectors): string {
  const el = findFirstStrategy(discoverySelectors[group], card);
  return collapseWhitespace(el?.textContent ?? '');
}

function buildJob(candidate: CardCandidate, host: string): Job | null {
  const { id, anchor, card } = candidate;
  // Live cards put the readable name only in the overlay anchor's aria-label;
  // its text content is empty, so read the accessible name as the fallback.
  const title =
    readField(card, 'title') ||
    collapseWhitespace(anchor?.textContent ?? '') ||
    collapseWhitespace(getAccessibleName(anchor));
  if (title.length === 0) return null;

  const lines = cardTextLines(card).filter((line) => normalizeText(line) !== normalizeText(title));
  const employerField = readField(card, 'employer');
  const locationField = readField(card, 'location');
  const employmentField = readField(card, 'employmentType');
  const salaryField = readField(card, 'salary');

  const location =
    locationField ||
    lines.find(
      (line) =>
        looksLikeLocation(line) &&
        normalizeText(line) !== normalizeText(employerField) &&
        !SALARY_PATTERN.test(line),
    );

  const employmentLine =
    employmentField ||
    lines.find(
      (line) =>
        line.length <= 48 && EMPLOYMENT_WORD.test(normalizeText(line)) && !looksLikeLocation(line),
    );
  const employmentType = employmentLine ? fieldSegment(employmentLine, EMPLOYMENT_WORD) : undefined;

  const salaryLine = salaryField || lines.find((line) => SALARY_PATTERN.test(line));
  const salary = salaryLine ? fieldSegment(salaryLine, SALARY_PATTERN) : undefined;

  const employer =
    employerField ||
    lines.find((line) => {
      if (line.length < 2 || line.length > 120) return false;
      if (line === location || line === employmentType || line === salary) return false;
      const normalized = normalizeText(line);
      if (normalized.length === 0) return false;
      if (POSTED_PREFIX.test(normalized)) return false;
      if (EMPLOYMENT_WORD.test(normalized) && line.length <= 48) return false;
      if (SALARY_PATTERN.test(line) || looksLikeLocation(line)) return false;
      if (/\b(apply|save|share|view job)\b/.test(normalized)) return false;
      return true;
    }) ||
    '';

  const timeValue = card.querySelector('time[datetime]')?.getAttribute('datetime');
  let postedAt: string | undefined;
  if (timeValue) {
    const parsed = new Date(timeValue);
    if (!Number.isNaN(parsed.getTime())) postedAt = parsed.toISOString();
  }

  const remote = normalizeText(`${location ?? ''} ${employmentType ?? ''}`).includes('remote');

  return {
    id,
    host,
    title,
    employer,
    url: buildJobUrl(host, id),
    description: '',
    applyType: classifyCardApplyType(card),
    externalUrl: externalApplyUrl(card),
    requiredDocumentTypes: [],
    source: 'search',
    discoveredAt: Date.now(),
    ...(location ? { location } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(salary ? { salary } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(remote ? { remote } : {}),
  };
}

function richness(job: Job): number {
  return [job.title, job.employer, job.location, job.employmentType, job.salary].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  ).length;
}

/**
 * Extract every valid job card on the page, deduplicated by ID and in document
 * order. The richest duplicate wins; malformed cards are ignored.
 */
export function extractJobCards(doc: Document, host: string): Job[] {
  if (!parseHandshakeHost(host)) {
    throw new TypeError('extractJobCards requires a Handshake host');
  }

  const byId = new Map<string, Job>();
  const order: string[] = [];

  for (const candidate of collectCardCandidates(doc)) {
    const job = buildJob(candidate, host);
    if (!job) continue;
    if (!byId.has(job.id)) {
      byId.set(job.id, job);
      order.push(job.id);
      continue;
    }
    const existing = byId.get(job.id);
    if (existing) {
      const preferred = richness(job) > richness(existing) ? job : existing;
      byId.set(
        job.id,
        existing.applyType === 'external' || job.applyType === 'external'
          ? {
              ...preferred,
              applyType: 'external',
              externalUrl: job.externalUrl ?? existing.externalUrl,
            }
          : preferred,
      );
    }
  }

  return order.map((id) => byId.get(id)).filter((job): job is Job => job !== undefined);
}

/** Enabled Next/Next-page control, or `null` when absent/disabled/last page. */
export function findNextPage(doc: Document): HTMLElement | null {
  const match = runStrategy('discovery.nextPage', discoverySelectors.nextPage, doc, 'search');
  if (!match) return null;
  if (isDisabledElement(match.el)) return null;
  return match.el instanceof HTMLElement ? match.el : null;
}

/** True when the page renders an explicit empty-state message. */
export function detectEmptyState(doc: Document): boolean {
  return runStrategy('discovery.emptyState', discoverySelectors.emptyState, doc, 'search') !== null;
}

/** Preserve existing params and advance `page`/`paged` by one. */
export function buildNextPageUrl(currentUrl: string, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('Page number must be a positive integer');
  }
  const url = new URL(currentUrl);
  if (url.searchParams.has('page')) url.searchParams.set('page', String(page));
  if (url.searchParams.has('paged')) url.searchParams.set('paged', String(page));
  if (!url.searchParams.has('page') && !url.searchParams.has('paged')) {
    url.searchParams.set('page', String(page));
  }
  url.hash = '';
  return url.toString();
}

/**
 * One page of discovery. Pagination is expressed as a URL for the caller to
 * navigate; no DOM navigation or clicks happen here.
 */
export function scanPage(doc: Document, currentUrl: string, host: string): ScanResult {
  if (!parseHandshakeHost(host)) {
    throw new TypeError('scanPage requires a Handshake host');
  }
  const jobs = extractJobCards(doc, host);
  const empty = jobs.length === 0 && detectEmptyState(doc);
  const next = empty ? null : findNextPage(doc);
  const nextPageUrl = next ? buildNextPageUrl(currentUrl, readPageNumber(currentUrl) + 1) : null;
  return { jobs, nextPageUrl, empty };
}
