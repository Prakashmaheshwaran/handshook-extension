/**
 * Job-detail selector strategies.
 *
 * Verified against sanitized live captures from app.joinhandshake.com on
 * 2026-10-25 (Chrome 155.0.8059.86), for both a Handshake apply page and an
 * external apply page. The live detail root is
 * `[data-hook="job-details-page"]`; field sections are anchored by their
 * visible headings ("At a glance", "Job description").
 *
 * Applied-on banner, Withdraw application and disabled Apply were relayed from
 * the owner's supervised 2026-10-27 observation. Closed,
 * not-open, login and challenge pages. The application modal was deliberately
 * never opened.
 */

import type { SelectorStrategy } from '@/core/contracts';
import { sanitizeActionAreaOutline, type ActionAreaOutline } from '@/core/diagnostics/selectorKeys';
import { findAllByText, findByText, isDisabledElement, isVisible } from '../dom';
import { collapseWhitespace, normalizeText } from '../text';

/**
 * Regions that may state an application status. Job descriptions are excluded:
 * a posting that says "you will be responsible for already-applied migrations"
 * or "applications are closed on weekends" must not mark the job final.
 */
const DESCRIPTION_SCOPE = [
  '[data-testid*="description" i]',
  '[aria-label*="description" i]',
  '[data-testid*="job-detail-description" i]',
  '.job-description',
  '.description',
].join(',');

const STATUS_SCOPE = [
  '[role="status"]',
  '[role="alert"]',
  '[data-testid*="status" i]',
  '[data-testid*="applied" i]',
  '[data-testid*="closed" i]',
  '[data-testid*="not-open" i]',
  '[data-testid*="not_open" i]',
  '[data-testid*="apply" i]',
  '[aria-label*="application status" i]',
  '[aria-label*="apply" i]',
  'header',
  '[role="banner"]',
  '.banner',
  '.rosetta-banner',
  '.toast',
].join(',');

/** True when the element is inside a status/action region and not a description. */
export function isStatusRegion(element: Element): boolean {
  if (element.closest(DESCRIPTION_SCOPE)) return false;
  return Boolean(element.closest(STATUS_SCOPE));
}

/** Text search limited to status regions (descriptions cannot match). */
function findStatusText(
  root: ParentNode,
  matcher: RegExp,
  candidates = 'a, button, [role], h1, h2, h3, h4, h5, h6, label, li, p, span, div, td, th',
): Element | null {
  for (const element of findAllByText(root, matcher, { candidates, visibleOnly: true })) {
    if (isStatusRegion(element)) return element;
  }
  return null;
}

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

const ACTION_CANDIDATES = 'button, a, [role="button"], [role="link"]';

export const EXTERNAL_APPLY_COPY =
  /apply externally|apply external|external application|apply on (the )?(company|employer) (site|website)/i;
export const QUICK_APPLY_COPY = /\bquick apply\b/i;
export const INTERNAL_APPLY_COPY = /^(apply|apply now|apply to (this )?job|apply for this job)$/i;

/** Live job-detail root. */
export const JOB_PAGE_HOOK = '[data-hook="job-details-page"]';

const MONEY_PATTERN = /\$\s?\d|\d+\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|week)/;
const LOCATION_PATTERN = /^(remote|hybrid|onsite)\b|^[^,]{2,48},\s*[A-Z]{2}(?:\s|,|$)/i;
const EMPLOYMENT_PATTERN =
  /\b(internship|intern|full[- ]?time|part[- ]?time|contract|temporary|co[- ]?op|fellowship|seasonal)\b/i;

const EMPLOYER_LINK_SELECTOR = 'a[href^="/e/"], a[href*="/companies/"], a[href*="/employers/"]';

function jobPageRoot(root: ParentNode): ParentNode {
  if (root instanceof Element && root.matches(JOB_PAGE_HOOK)) return root;
  return root.querySelector(JOB_PAGE_HOOK) ?? root;
}

interface HeadingBlock {
  readonly wrapper: Element;
  readonly section: Element;
}

/** Find a heading by its visible text and the section that owns it. */
function headingBlock(root: ParentNode, pattern: RegExp): HeadingBlock | null {
  const scope = jobPageRoot(root);
  for (const heading of Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    if (!pattern.test(normalizeText(heading.textContent ?? ''))) continue;
    const wrapper = heading.parentElement;
    if (!wrapper) continue;
    return { wrapper, section: wrapper.parentElement ?? wrapper };
  }
  return null;
}

/** Content that follows a section heading (live: a sibling of the heading wrapper). */
function blockAfterHeading(root: ParentNode, pattern: RegExp): Element | null {
  const block = headingBlock(root, pattern);
  if (!block) return null;
  return block.wrapper.nextElementSibling ?? block.section.children[1] ?? block.section;
}

/**
 * Live "At a glance" values are leaf divs in document order, with no per-field
 * attributes. Classify by value shape instead of relying on position.
 */
function atGlanceValues(root: ParentNode): Element[] {
  const block = headingBlock(root, /^at a glance$/);
  if (!block) return [];
  return Array.from(block.section.querySelectorAll('div')).filter(
    (el) => el.childElementCount === 0 && collapseWhitespace(el.textContent ?? '').length > 0,
  );
}

function atGlanceValue(
  root: ParentNode,
  pattern: RegExp,
  exclude?: Element | null,
): Element | null {
  return (
    atGlanceValues(root).find(
      (el) => el !== exclude && pattern.test(collapseWhitespace(el.textContent ?? '')),
    ) ?? null
  );
}

function employerLink(root: ParentNode): Element | null {
  const scope = jobPageRoot(root);
  return (
    Array.from(scope.querySelectorAll(EMPLOYER_LINK_SELECTOR)).find(
      (el) => collapseWhitespace(el.textContent ?? '').length > 0,
    ) ?? null
  );
}

function actionText(root: ParentNode, matcher: RegExp, exact = false): Element | null {
  return (
    findAllByText(jobPageRoot(root), matcher, { candidates: ACTION_CANDIDATES, exact }).sort(
      (left, right) => Number(isPrimaryAction(right)) - Number(isPrimaryAction(left)),
    )[0] ?? null
  );
}

function isPrimaryAction(element: Element): boolean {
  return element.getAttribute('data-variant') === 'primary';
}

/** Visible job actions, with the live Rosetta primary control preferred. */
export function jobActionCandidates(root: ParentNode): HTMLElement[] {
  return Array.from(jobPageRoot(root).querySelectorAll<HTMLElement>(ACTION_CANDIDATES))
    .filter((element) => isVisible(element) && !isDisabledElement(element))
    .sort((left, right) => Number(isPrimaryAction(right)) - Number(isPrimaryAction(left)));
}

function visibleAction(root: ParentNode, selector: string): Element | null {
  return (
    Array.from(jobPageRoot(root).querySelectorAll(selector))
      .filter((element) => isVisible(element))
      .sort((left, right) => Number(isPrimaryAction(right)) - Number(isPrimaryAction(left)))[0] ??
    null
  );
}

/** Structural action evidence only: never reads text, titles, names, IDs, or URLs. */
export function describeJobActionArea(doc: Document): ActionAreaOutline {
  const root = doc.querySelector(JOB_PAGE_HOOK);
  const scope = root ?? doc.body;
  const buttons = Array.from(scope?.querySelectorAll('button, [role="button"]') ?? []);
  const elements = new Set<Element>(root ? [root] : []);
  for (const button of buttons.slice(0, 100)) {
    elements.add(button);
    for (let parent = button.parentElement, depth = 0; parent && depth < 3; depth += 1) {
      if (parent === scope) break;
      elements.add(parent);
      parent = parent.parentElement;
    }
  }
  const grouped = new Map<string, ActionAreaOutline['entries'][number]>();
  for (const element of elements) {
    const attributes = Object.fromEntries(
      ['data-kind', 'data-variant', 'data-hook'].flatMap((name) => {
        const value = element.getAttribute(name);
        return value === null ? [] : [[name, value]];
      }),
    );
    const safe = sanitizeActionAreaOutline({
      version: 1,
      rootPresent: Boolean(root),
      elementCount: 0,
      buttonCount: 0,
      hiddenButtonCount: 0,
      entries: [
        {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') ?? undefined,
          ariaLabel: normalizeText(element.getAttribute('aria-label') ?? ''),
          attributes,
          visible: isVisible(element),
          disabled: isDisabledElement(element),
          count: 1,
        },
      ],
    });
    const entry = safe?.entries[0];
    if (!entry) continue;
    const key = JSON.stringify(entry);
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else if (grouped.size < 64) grouped.set(key, entry);
  }
  return {
    version: 1,
    rootPresent: Boolean(root),
    elementCount: Math.min(1_000_000, scope?.querySelectorAll('*').length ?? 0),
    buttonCount: Math.min(1_000_000, buttons.length),
    hiddenButtonCount: Math.min(1_000_000, buttons.filter((button) => !isVisible(button)).length),
    entries: [...grouped.values()],
  };
}

export const jobSelectors = {
  page: [
    {
      name: 'css:job-details-page',
      kind: 'css',
      description: 'Live job detail container (verified 2026-10-25)',
      find: (root) => {
        if (root instanceof Element && root.matches(JOB_PAGE_HOOK)) return root;
        return root.querySelector(JOB_PAGE_HOOK);
      },
    },
  ],
  title: [
    {
      name: 'css:h1',
      kind: 'role',
      description: 'Primary page heading (verified 2026-10-25)',
      find: (root) => jobPageRoot(root).querySelector('h1'),
    },
    {
      name: 'css:title-testid',
      kind: 'css',
      description: 'Job title test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="job-title" i], [data-testid*="jobTitle" i], [data-testid*="title" i]',
        ),
    },
    {
      name: 'css:main-heading',
      kind: 'role',
      description: 'Heading inside the main region',
      find: (root) => root.querySelector('main h1, [role="main"] h1'),
    },
  ],
  employer: [
    {
      name: 'css:employer-link',
      kind: 'css',
      description:
        'First non-empty employer/company link (live uses /e/{id}) (verified 2026-10-25)',
      find: employerLink,
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
      find: (root) => root.querySelector(EMPLOYER_LINK_SELECTOR),
    },
    {
      name: 'css:title-sibling',
      kind: 'css',
      description: 'Paragraph or link directly after the title (fallback)',
      find: (root) => root.querySelector('h1 + p, h1 + span, h1 + div, h1 + a'),
    },
  ],
  description: [
    {
      name: 'heading:job-description',
      kind: 'role',
      description: 'Content following the "Job description" heading (verified 2026-10-25)',
      find: (root) => blockAfterHeading(root, /^job description$/),
    },
    {
      name: 'css:description-testid',
      kind: 'css',
      description: 'Job description test id',
      find: (root) =>
        root.querySelector(
          '[data-testid*="job-description" i], [data-testid*="jobDescription" i], [data-testid*="description" i]',
        ),
    },
    {
      name: 'css:description-class',
      kind: 'css',
      description: 'Container with a description-like class or id (not present on the live tenant)',
      find: (root) =>
        root.querySelector(
          'article [class*="description" i], main [class*="description" i], [id*="description" i]',
        ),
    },
    {
      name: 'css:article',
      kind: 'css',
      description: 'Article or main region fallback text',
      find: (root) => root.querySelector('article, [role="main"]'),
    },
  ],
  location: [
    {
      name: 'heading:at-a-glance-location',
      kind: 'role',
      description: 'Location-shaped value inside "At a glance" (verified 2026-10-25)',
      find: (root) => atGlanceValue(root, LOCATION_PATTERN),
    },
    {
      name: 'css:location-testid',
      kind: 'css',
      description: 'Location test id',
      find: (root) => root.querySelector('[data-testid*="location" i], [aria-label*="location" i]'),
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
      name: 'heading:at-a-glance-employment',
      kind: 'role',
      description: 'Employment-shaped value inside "At a glance" (verified 2026-10-25)',
      find: (root) =>
        atGlanceValue(root, EMPLOYMENT_PATTERN, atGlanceValue(root, LOCATION_PATTERN)),
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
      name: 'heading:at-a-glance-salary',
      kind: 'role',
      description: 'Currency-shaped value inside "At a glance" (verified 2026-10-25)',
      find: (root) => atGlanceValue(root, MONEY_PATTERN),
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
  ],
  postedAt: [
    {
      name: 'css:time-datetime',
      kind: 'css',
      description:
        'time element with a machine-readable datetime (not observed live; API supplies it)',
      find: (root) =>
        root.querySelector('main time[datetime], article time[datetime], time[datetime]'),
    },
  ],
  applyButton: [
    {
      name: 'text:apply',
      kind: 'text',
      description: 'Button/link named Apply or Apply now (verified 2026-10-25)',
      find: (root) =>
        actionText(root, /^(apply|apply now|apply to job|apply for this job|quick apply)$/, true),
    },
    {
      name: 'aria:apply-label',
      kind: 'aria',
      description: 'Control with an apply aria-label (verified 2026-10-25)',
      find: (root) =>
        visibleAction(root, 'button[aria-label*="apply" i], a[aria-label*="apply" i]'),
    },
    {
      name: 'css:apply-testid',
      kind: 'css',
      description: 'Apply control by test id',
      find: (root) =>
        visibleAction(root, 'button[data-testid*="apply" i], a[data-testid*="apply" i]'),
    },
  ],
  externalApplyButton: [
    {
      name: 'text:apply-externally',
      kind: 'text',
      description: 'Apply externally button text (verified 2026-10-25)',
      find: (root) => actionText(root, EXTERNAL_APPLY_COPY),
    },
    {
      name: 'aria:apply-externally',
      kind: 'aria',
      description: 'Apply externally button aria-label (verified 2026-10-25)',
      find: (root) =>
        visibleAction(
          root,
          'button[aria-label*="apply externally" i], a[aria-label*="apply externally" i]',
        ),
    },
    {
      name: 'css:external-testid',
      kind: 'css',
      description: 'External apply control by test id',
      find: (root) =>
        root.querySelector('[data-testid*="external" i], [data-testid*="apply-external" i]'),
    },
  ],
  alreadyApplied: [
    {
      name: 'text:applied-on-banner',
      kind: 'text',
      description: 'Applied on date in the live Rosetta alert banner (2026-10-27)',
      find: (root) => findStatusText(root, /^applied on\b/i, 'h2'),
    },
    {
      name: 'text:withdraw-application',
      kind: 'text',
      description: 'Withdraw application action in the applied banner (2026-10-27)',
      find: (root) => findStatusText(root, /^withdraw application$/i, 'button, [role="button"]'),
    },
    {
      name: 'css:applied-testid',
      kind: 'css',
      description: 'Applied/application status test id (not observed live)',
      find: (root) =>
        root.querySelector('[data-testid*="applied" i], [data-testid*="application-status" i]'),
    },
    {
      name: 'text:you-applied',
      kind: 'text',
      description: 'Persistent you applied on / already applied copy',
      find: (root) => findStatusText(root, /\byou applied on\b|\balready applied\b/),
    },
    {
      name: 'text:applied-button',
      kind: 'text',
      description: 'Applied button or status chip',
      find: (root) =>
        findStatusText(root, /^applied$/, 'button, a, [role="status"], [role="button"], span'),
    },
  ],
  closed: [
    {
      name: 'css:closed-testid',
      kind: 'css',
      description: 'Closed/expired test id (not observed live)',
      find: (root) => root.querySelector('[data-testid*="closed" i], [data-testid*="expired" i]'),
    },
    {
      name: 'text:closed-copy',
      kind: 'text',
      description: 'No longer accepting applications copy',
      find: (root) =>
        findStatusText(
          root,
          /\b(no longer accepting applications?|position (is )?closed|job (is )?closed|this job is no longer available|applications? (are )?closed|expired)\b/,
        ),
    },
    {
      name: 'aria:closed-label',
      kind: 'aria',
      description: 'Control labelled closed',
      find: (root) => root.querySelector('[aria-label*="closed" i]'),
    },
  ],
  notOpen: [
    {
      name: 'text:not-open-copy',
      kind: 'text',
      description: 'Applications not open yet copy (not observed live)',
      find: (root) =>
        findStatusText(
          root,
          /applications? (are )?not (yet )?open|applications? open on|application window opens/,
        ),
    },
    {
      name: 'css:not-open-testid',
      kind: 'css',
      description: 'Not-open test id',
      find: (root) =>
        root.querySelector('[data-testid*="not-open" i], [data-testid*="not_open" i]'),
    },
  ],
  challenge: [
    {
      name: 'css:challenge-markers',
      kind: 'css',
      description: 'Cloudflare/Turnstile challenge markers',
      find: (root) =>
        root.querySelector(
          '#challenge-form, iframe[src*="challenges.cloudflare.com"], [data-testid*="challenge" i], [data-testid*="captcha" i], [id*="cf-challenge" i], [class*="cf-challenge" i]',
        ),
    },
    {
      name: 'text:challenge-copy',
      kind: 'text',
      description: 'Human-verification copy',
      find: (root) =>
        findByText(
          root,
          /verify you are human|checking your browser|just a moment|enable javascript and cookies|unusual traffic/,
        ),
    },
  ],
  login: [
    {
      name: 'css:login-controls',
      kind: 'css',
      description: 'Password field or login form',
      find: (root) =>
        root.querySelector(
          'input[type="password"], form[action*="login" i], form[action*="sign_in" i]',
        ),
    },
    {
      name: 'text:login-heading',
      kind: 'text',
      description: 'Sign-in heading',
      find: (root) =>
        findByText(root, /^(sign in to handshake|log in to handshake)$/, {
          candidates: 'h1, h2, [role="heading"], legend',
          exact: true,
        }),
    },
    {
      name: 'css:login-testid',
      kind: 'css',
      description: 'Login form test id',
      find: (root) => root.querySelector('[data-testid*="login-form" i]'),
    },
  ],
  actions: [
    {
      name: 'role:job-actions',
      kind: 'role',
      description: 'Group containing the apply controls',
      find: (root) =>
        root.querySelector('[role="group"][aria-label*="job" i], [data-testid*="job-actions" i]'),
    },
  ],
} satisfies Record<string, readonly SelectorStrategy[]>;

export type JobSelectorGroup = keyof typeof jobSelectors;
