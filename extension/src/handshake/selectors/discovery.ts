/**
 * Discovery selector strategies (search results, cards, pagination).
 *
 * Verified against a sanitized live capture from app.joinhandshake.com on
 * 2026-10-25 (Chrome 155.0.8059.86). Result cards expose
 * `data-hook="job-result-card | {id}"`; the card's leading anchor uses
 * `/job-search/{id}` on the live tenant. Strategies are ordered fallbacks and
 * a miss in every strategy means `UI_CHANGED`, not "no jobs".
 */

import type { SelectorStrategy } from '@/core/contracts';
import { findAllByText, findByText } from '../dom';
import { collapseWhitespace, getAccessibleName, normalizeText } from '../text';
import { extractJobId } from '../urls';

function definitionValue(root: ParentNode, labels: readonly string[]): Element | null {
  for (const term of Array.from(root.querySelectorAll('dt, th, label, [role="term"]'))) {
    const text = normalizeText(term.textContent ?? '');
    if (!labels.some((label) => text === label || text.startsWith(`${label} `))) continue;
    const sibling = term.nextElementSibling;
    if (sibling) return sibling;
    const parent = term.parentElement;
    const value = parent?.querySelector('dd, td');
    if (value) return value;
  }
  return null;
}

const LOCATION_LABELS = ['location', 'locations', 'job location'] as const;
const EMPLOYMENT_LABELS = ['employment type', 'job type', 'type', 'commitment'] as const;
const SALARY_LABELS = ['salary', 'compensation', 'pay', 'pay rate', 'hourly rate'] as const;

/** Live result-card hook: `job-result-card | 12345678`. */
export const CARD_HOOK_SELECTOR = '[data-hook^="job-result-card | "]';
const CARD_HOOK_PATTERN = /^job-result-card\s*\|\s*(\d+)$/;

/** Numeric job ID encoded in a live result-card hook, or `null`. */
export function cardHookId(el: Element | null | undefined): string | null {
  const hook = el?.getAttribute('data-hook') ?? '';
  const match = CARD_HOOK_PATTERN.exec(hook.trim());
  return match?.[1] ?? null;
}

function cardsIn(root: ParentNode): Element[] {
  const list: Element[] = [];
  if (root instanceof Element && root.matches(CARD_HOOK_SELECTOR)) list.push(root);
  list.push(...Array.from(root.querySelectorAll(CARD_HOOK_SELECTOR)));
  return list;
}

function cardScope(root: ParentNode): Element | null {
  if (root instanceof Element && root.matches(CARD_HOOK_SELECTOR)) return root;
  return root.querySelector(CARD_HOOK_SELECTOR);
}

const MONEY_PATTERN = /\$\s?\d|\d+\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|week)/;
const EMPLOYMENT_PATTERN =
  /\b(internship|intern|full[- ]?time|part[- ]?time|contract|temporary|co[- ]?op|fellowship|seasonal)\b/i;
const LOCATION_PATTERN = /^(remote|hybrid|onsite)\b|^[^,]{2,48},\s*[A-Z]{2}(?:\s|,|$)/i;

function leafElements(root: ParentNode | null): Element[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll('div, span')).filter(
    (el) => el.childElementCount === 0 && collapseWhitespace(el.textContent ?? '').length > 0,
  );
}

function firstCardTitle(root: ParentNode): Element | null {
  const card = cardScope(root);
  if (!card) return null;
  // The clickable overlay is an <a aria-label>; the title is the first
  // non-anchor element carrying the same label text.
  return card.querySelector('div[aria-label]') ?? card.querySelector('h1, h2, h3, h4, h5, h6');
}

function firstNonEmptySpan(root: ParentNode): Element | null {
  const card = cardScope(root);
  if (!card) return null;
  for (const span of Array.from(card.querySelectorAll('span'))) {
    if (collapseWhitespace(span.textContent ?? '').length > 0) return span;
  }
  return null;
}

/**
 * Location is not positional: promoted cards prepend a "Promoted" footer span
 * before the real location. Classify footer spans instead of taking the first.
 */
function footerLocation(root: ParentNode): Element | null {
  const card = cardScope(root);
  const footer = card?.querySelector('[data-hook="job-result-card-footer"]');
  if (!footer) return null;
  return (
    Array.from(footer.querySelectorAll('span')).find((span) =>
      LOCATION_PATTERN.test(collapseWhitespace(span.textContent ?? '')),
    ) ?? null
  );
}

function cardMetaValue(root: ParentNode, kind: 'salary' | 'employment'): Element | null {
  const card = cardScope(root);
  if (!card) return null;
  const leaves = leafElements(card);
  const titleText = normalizeText(firstCardTitle(card)?.textContent ?? '');

  if (kind === 'salary') {
    return leaves.find((el) => MONEY_PATTERN.test(el.textContent ?? '')) ?? null;
  }

  const compound = leaves.filter(
    (el) =>
      EMPLOYMENT_PATTERN.test(el.textContent ?? '') &&
      (/·/.test(el.textContent ?? '') ||
        MONEY_PATTERN.test(el.textContent ?? '') ||
        el.children.length === 0),
  );
  const preferred = compound.find((el) => /·/.test(el.textContent ?? ''));
  if (preferred) return preferred;
  return (
    leaves.find((el) => {
      const text = collapseWhitespace(el.textContent ?? '');
      return (
        EMPLOYMENT_PATTERN.test(text) &&
        text.length <= 48 &&
        normalizeText(text) !== titleText &&
        (MONEY_PATTERN.test(text) || !LOCATION_PATTERN.test(text))
      );
    }) ?? null
  );
}

const jobLinks = (root: ParentNode): Element[] =>
  Array.from(root.querySelectorAll('a[href]')).filter(
    (anchor) => extractJobId(anchor.getAttribute('href')) !== null,
  );

const cardAnchors = (root: ParentNode): Element[] =>
  cardsIn(root)
    .map((card) => card.querySelector('a[href]'))
    .filter((anchor): anchor is Element => anchor !== null);

const jobLinkStrategy: SelectorStrategy = {
  name: 'link:href-job-id',
  kind: 'css',
  description: 'Anchors whose href contains a numeric /jobs/, /stu/jobs/ or /job-search/ ID',
  find: (root) => jobLinks(root)[0] ?? null,
  findAll: jobLinks,
};

const dataJobIdStrategy: SelectorStrategy = {
  name: 'css:data-job-id',
  kind: 'css',
  description: 'Card or anchor carrying data-job-id',
  find: (root) => root.querySelector('[data-job-id], [data-jobid]'),
  findAll: (root) => Array.from(root.querySelectorAll('[data-job-id], [data-jobid]')),
};

export const discoverySelectors = {
  jobLink: [
    {
      name: 'css:card-hook-anchor',
      kind: 'css',
      description: 'Leading anchor of a live data-hook result card (verified 2026-10-25)',
      find: (root) => cardAnchors(root)[0] ?? null,
      findAll: cardAnchors,
    },
    jobLinkStrategy,
    {
      name: 'link:data-job-id',
      kind: 'css',
      description: 'Anchor with a data-job-id attribute',
      find: (root) => root.querySelector('a[data-job-id], a[data-jobid]'),
      findAll: (root) => Array.from(root.querySelectorAll('a[data-job-id], a[data-jobid]')),
    },
    dataJobIdStrategy,
  ],
  jobCard: [
    {
      name: 'css:result-card-hook',
      kind: 'css',
      description: 'Live result card: [data-hook="job-result-card | {id}"] (verified 2026-10-25)',
      find: (root) => cardScope(root),
      findAll: cardsIn,
    },
    {
      name: 'css:semantic-list-item',
      kind: 'css',
      description: 'article, li, or role=listitem result rows',
      find: (root) => root.querySelector('article, li, [role="listitem"]'),
      findAll: (root) => Array.from(root.querySelectorAll('article, li, [role="listitem"]')),
    },
    {
      name: 'css:card-testid',
      kind: 'css',
      description: 'Card-like container by test id or job id (not present on the live tenant)',
      find: (root) =>
        root.querySelector(
          '[data-testid*="job-card" i], [data-testid*="jobCard" i], [data-job-id]',
        ),
      findAll: (root) =>
        Array.from(
          root.querySelectorAll(
            '[data-testid*="job-card" i], [data-testid*="jobCard" i], [data-job-id]',
          ),
        ),
    },
  ],
  title: [
    {
      name: 'css:card-aria-title',
      kind: 'aria',
      description: 'Title element labelled inside a live result card (verified 2026-10-25)',
      find: firstCardTitle,
      findAll: (root) =>
        cardsIn(root)
          .map((card) => firstCardTitle(card))
          .filter((el): el is Element => el !== null),
    },
    {
      name: 'css:heading',
      kind: 'role',
      description: 'First heading in the card',
      find: (root) => root.querySelector('h1, h2, h3, h4, h5, h6'),
      findAll: (root) => Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')),
    },
    {
      name: 'css:title-testid',
      kind: 'css',
      description: 'Element with a title test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="job-title" i], [data-testid*="jobTitle" i], [data-testid*="title" i]',
        ),
    },
    {
      name: 'link:job-anchor',
      kind: 'text',
      description: 'Accessible name of the job anchor itself',
      find: (root) => {
        const anchor = jobLinks(root)[0];
        if (!anchor || getAccessibleName(anchor).length === 0) return null;
        return anchor;
      },
    },
  ],
  employer: [
    {
      name: 'css:card-first-span',
      kind: 'css',
      description: 'First text span in a live card is the employer (verified 2026-10-25)',
      find: firstNonEmptySpan,
      findAll: (root) =>
        cardsIn(root)
          .map((card) => firstNonEmptySpan(card))
          .filter((el): el is Element => el !== null),
    },
    {
      name: 'css:employer-testid',
      kind: 'css',
      description: 'Employer/company test id',
      find: (root) => root.querySelector('[data-testid*="employer" i], [data-testid*="company" i]'),
    },
    {
      name: 'css:company-link',
      kind: 'css',
      description: 'Company profile link',
      find: (root) =>
        root.querySelector('a[href^="/e/"], a[href*="/companies/"], a[href*="/employers/"]'),
    },
    {
      name: 'css:card-paragraph',
      kind: 'css',
      description: 'First paragraph in the card (tenant text fallback)',
      find: (root) => root.querySelector('p, [class*="employer" i], [class*="company" i]'),
    },
  ],
  location: [
    {
      name: 'css:footer-location',
      kind: 'aria',
      description:
        'Location span inside [data-hook="job-result-card-footer"] (verified 2026-10-25)',
      find: footerLocation,
      findAll: (root) =>
        cardsIn(root)
          .map((card) => footerLocation(card))
          .filter((el): el is Element => el !== null),
    },
    {
      name: 'css:location-testid',
      kind: 'css',
      description: 'Location test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="location" i], [data-testid*="job-location" i], [aria-label*="location" i]',
        ),
    },
    {
      name: 'label:definition-location',
      kind: 'label',
      description: 'Definition-list value following a Location term',
      find: (root) => definitionValue(root, LOCATION_LABELS),
    },
    {
      name: 'css:location-class',
      kind: 'css',
      description: 'Class-based fallback (not present on the live tenant; retained for variants)',
      find: (root) => root.querySelector('[class*="location" i]'),
    },
  ],
  employmentType: [
    {
      name: 'css:card-meta-employment',
      kind: 'css',
      description: 'Salary/type meta line in a live card (verified 2026-10-25)',
      find: (root) => cardMetaValue(root, 'employment'),
      findAll: (root) =>
        cardsIn(root)
          .map((card) => cardMetaValue(card, 'employment'))
          .filter((el): el is Element => el !== null),
    },
    {
      name: 'css:employment-testid',
      kind: 'css',
      description: 'Employment type test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="employment" i], [data-testid*="job-type" i], [data-testid*="commitment" i]',
        ),
    },
    {
      name: 'label:definition-employment',
      kind: 'label',
      description: 'Definition-list value following an Employment type term',
      find: (root) => definitionValue(root, EMPLOYMENT_LABELS),
    },
  ],
  salary: [
    {
      name: 'css:card-meta-salary',
      kind: 'css',
      description: 'Currency meta line in a live card (verified 2026-10-25)',
      find: (root) => cardMetaValue(root, 'salary'),
      findAll: (root) =>
        cardsIn(root)
          .map((card) => cardMetaValue(card, 'salary'))
          .filter((el): el is Element => el !== null),
    },
    {
      name: 'css:salary-testid',
      kind: 'css',
      description: 'Salary/compensation test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="salary" i], [data-testid*="compensation" i], [data-testid*="pay" i]',
        ),
    },
    {
      name: 'label:definition-salary',
      kind: 'label',
      description: 'Definition-list value following a Salary term',
      find: (root) => definitionValue(root, SALARY_LABELS),
    },
    {
      name: 'css:salary-class',
      kind: 'css',
      description: 'Class-based fallback (not present on the live tenant; retained for variants)',
      find: (root) => root.querySelector('[class*="salary" i], [class*="compensation" i]'),
    },
  ],
  nextPage: [
    {
      name: 'aria:pagination-next',
      kind: 'aria',
      description: 'Next control inside [data-hook="job-search-pagination"] (verified 2026-10-25)',
      find: (root) =>
        root.querySelector(
          '[data-hook="job-search-pagination"] button[aria-label="next page" i], [data-hook="job-search-pagination"] a[aria-label="next page" i]',
        ),
    },
    {
      name: 'text:next',
      kind: 'text',
      description: 'Button or link named Next / Next page / arrow',
      find: (root) =>
        findByText(root, /^(next|next page|next ›|next >|›|»|→)$/, {
          candidates: 'button, a, [role="button"], [role="link"]',
        }),
      findAll: (root) =>
        findAllByText(root, /^(next|next page|next ›|next >|›|»|→)$/, {
          candidates: 'button, a, [role="button"], [role="link"]',
        }),
    },
    {
      name: 'aria:next-label',
      kind: 'aria',
      description: 'Control with an aria-label containing next',
      find: (root) => root.querySelector('button[aria-label*="next" i], a[aria-label*="next" i]'),
    },
    {
      name: 'css:rel-next',
      kind: 'css',
      description: 'Link with rel=next',
      find: (root) => root.querySelector('a[rel~="next" i]'),
    },
  ],
  emptyState: [
    {
      name: 'css:results-status',
      kind: 'aria',
      description: 'Results status announcer reporting zero jobs (hook verified 2026-10-25)',
      find: (root) => {
        const el = root.querySelector('[data-hook="job-search-results-status-announcer"]');
        if (!el) return null;
        const text = normalizeText(el.textContent ?? '');
        return /\b(0|no)\b.*\b(jobs?|results?|postings?)\b/.test(text) ? el : null;
      },
    },
    {
      name: 'text:no-results',
      kind: 'text',
      description: 'No jobs/results message',
      find: (root) =>
        findByText(
          root,
          /no (jobs|results|postings|opportunities) (found|match)|nothing (found|here)|try (adjusting|changing) (your )?filters/,
        ),
    },
    {
      name: 'css:empty-testid',
      kind: 'css',
      description: 'Empty-state test id',
      find: (root) => root.querySelector('[data-testid*="empty" i], [data-testid*="no-results" i]'),
    },
    {
      name: 'text:no-opportunities',
      kind: 'text',
      description: 'Alternate empty-state copy',
      find: (root) => findByText(root, /no opportunities|start (a )?new search/),
    },
  ],
  appliedBanner: [
    {
      name: 'css:applied-testid',
      kind: 'css',
      description: 'Applied/application status test id',
      find: (root) =>
        root.querySelector('[data-testid*="applied" i], [data-testid*="application-status" i]'),
    },
    {
      name: 'text:you-applied',
      kind: 'text',
      description: 'You applied on / application submitted copy',
      find: (root) => findByText(root, /\byou applied on\b|\bapplication (submitted|sent)\b/),
    },
    {
      name: 'text:applied-chip',
      kind: 'text',
      description: 'Applied badge',
      find: (root) =>
        findByText(root, /^applied$/, {
          candidates: 'button, a, [role="status"], [role="button"], span',
          exact: true,
        }),
    },
  ],
} satisfies Record<string, readonly SelectorStrategy[]>;

export type DiscoverySelectorGroup = keyof typeof discoverySelectors;
