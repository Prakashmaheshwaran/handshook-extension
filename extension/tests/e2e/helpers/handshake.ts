/**
 * Mock Handshake site served through Playwright route interception.
 *
 * Nothing here touches the real `joinhandshake.com`. `installHandshakeRoutes` takes
 * over every `https://app.joinhandshake.com/**` request on a browser context and
 * serves sanitized HTML/JSON, so content-script match patterns and same-origin rules
 * behave exactly as they would against the real site.
 *
 *   const mock = await installHandshakeRoutes(context, 'form-two-docs');
 *   const page = await context.newPage();
 *   await page.goto(mock.searchUrl());
 *
 * Scenarios:
 * - `search-10-jobs`   10 cards, working next link, empty second page, mixed apply types
 * - `quick-apply`      job detail with a Quick Apply button that submits immediately
 * - `quick-apply-review` Quick Apply opens a review dialog with documents; submit is separate
 * - `form-two-docs`    form modal requiring resume + cover letter documents
 * - `form-questions`   form modal with a resume plus text/select/radio screening questions
 * - `form-transcript`  form modal requiring a resume and a transcript
 * - `external`         "Apply Externally" handoff, no in-page submit
 * - `already-applied`  applied banner, no apply control
 * - `closed`           closed banner, no apply control
 * - `rate-limited`     application POST returns 429, detail API returns 429
 * - `application-forbidden` application POST returns 403, detail API succeeds
 * - `ambiguous-confirmation` POST succeeds but no confirmation renders
 * - `login-redirect`   protected pages navigate to /login until the mock sign-in runs
 * - `slow-modal`       apply modal appears after 500ms, document options after 600ms
 * - `missing-selector` job detail without apply controls (simulates a DOM change)
 *
 * The controller returned by `installHandshakeRoutes` exposes request logs and
 * switches (`setApiMode`, `setApplicationStatus`, `setDocuments`, `setLoggedIn`) for
 * failure tests.
 */

import type { BrowserContext, Route } from '@playwright/test';

import type { ApplyType, DocumentRecord, DocumentType, Job } from '../../../src/core/contracts';
import { SAMPLE_DOCUMENTS, SAMPLE_JOBS } from '../../../src/test/mockData';

export const HANDSHAKE_ORIGIN = 'https://app.joinhandshake.com';
export const HANDSHAKE_ROUTE_GLOB = `${HANDSHAKE_ORIGIN}/**`;

/** Fake session cookie name/value. Not a credential and never sent anywhere real. */
export const MOCK_SESSION_COOKIE = 'handshake_mock_session';
export const MOCK_SESSION_VALUE = 'mock-session-value-not-a-secret';

export type HandshakeScenario =
  | 'search-10-jobs'
  | 'quick-apply'
  | 'quick-apply-review'
  | 'no-additional-documents'
  | 'one-click-apply'
  | 'form-two-docs'
  | 'form-other-document'
  | 'form-questions'
  | 'form-transcript'
  | 'external'
  | 'already-applied'
  | 'closed'
  | 'rate-limited'
  | 'application-forbidden'
  | 'ambiguous-confirmation'
  | 'login-redirect'
  | 'slow-modal'
  | 'missing-selector'
  | 'undeclared-apply';

export type HandshakeApiMode = 'ok' | 'rate_limited' | 'forbidden' | 'unprocessable';

export interface HandshakeRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly resourceType: string;
}

export interface MockHandshake {
  readonly scenario: HandshakeScenario;
  readonly origin: string;
  readonly requests: readonly HandshakeRequest[];
  readonly pagesServed: readonly string[];
  readonly jobIds: readonly string[];
  searchUrl(page?: number): string;
  jobUrl(jobId: string): string;
  apiUrl(jobId: string): string;
  documentsUrl(): string;
  myJobsUrl(): string;
  loginUrl(): string;
  setApiMode(mode: HandshakeApiMode): void;
  setApplicationStatus(status: number): void;
  setDocuments(documents: readonly DocumentRecord[]): void;
  setSearchJobs(jobs: readonly Job[]): void;
  setLoggedIn(value: boolean): void;
  isLoggedIn(): boolean;
  requestsFor(pathname: string): HandshakeRequest[];
  dispose(): Promise<void>;
}

interface ScenarioConfig {
  readonly applyType: ApplyType;
  readonly requiredDocuments: readonly DocumentType[];
  readonly applied: boolean;
  readonly closed: boolean;
  readonly external: boolean;
  readonly questions: boolean;
  readonly requiresLogin: boolean;
  readonly modalDelayMs: number;
  readonly documentDelayMs: number;
  readonly breakSelectors: boolean;
  readonly applicationStatus: number;
  readonly apiMode: HandshakeApiMode;
  readonly searchPageSize: number;
  /** POST succeeds, but the page never renders a confirmation banner. */
  readonly suppressConfirmation: boolean;
  /** Quick Apply opens a review dialog instead of submitting on the click. */
  readonly quickApplyReview: boolean;
  /** Simulates a changed site that no longer declares its opening behavior. */
  readonly undeclaredApply: boolean;
  /** Live-shaped plain Apply sends immediately and renders the Rosetta applied banner. */
  readonly oneClickApply: boolean;
}

const BASE_CONFIG: ScenarioConfig = {
  applyType: 'quick_apply',
  requiredDocuments: ['resume'],
  applied: false,
  closed: false,
  external: false,
  questions: false,
  requiresLogin: false,
  modalDelayMs: 0,
  documentDelayMs: 0,
  breakSelectors: false,
  applicationStatus: 200,
  apiMode: 'ok',
  searchPageSize: 10,
  suppressConfirmation: false,
  quickApplyReview: false,
  undeclaredApply: false,
  oneClickApply: false,
};

const SCENARIOS: Record<HandshakeScenario, Partial<ScenarioConfig>> = {
  'search-10-jobs': {},
  'quick-apply': { applyType: 'quick_apply' },
  'quick-apply-review': { applyType: 'quick_apply', quickApplyReview: true },
  'no-additional-documents': {
    applyType: 'handshake_form',
    requiredDocuments: [],
    undeclaredApply: true,
  },
  'one-click-apply': { applyType: 'handshake_form', oneClickApply: true },
  'form-two-docs': {
    applyType: 'handshake_form',
    requiredDocuments: ['resume', 'cover_letter'],
  },
  'form-other-document': { applyType: 'handshake_form', requiredDocuments: ['other'] },
  'form-questions': {
    applyType: 'handshake_form',
    requiredDocuments: ['resume'],
    questions: true,
  },
  'form-transcript': {
    applyType: 'handshake_form',
    requiredDocuments: ['resume', 'transcript'],
  },
  external: { applyType: 'external', external: true, requiredDocuments: ['resume'] },
  'already-applied': { applied: true },
  closed: { closed: true },
  'rate-limited': { applicationStatus: 429, apiMode: 'rate_limited' },
  'application-forbidden': { applicationStatus: 403 },
  'ambiguous-confirmation': { suppressConfirmation: true },
  'login-redirect': { requiresLogin: true },
  'slow-modal': { applyType: 'handshake_form', modalDelayMs: 500, documentDelayMs: 600 },
  'missing-selector': { breakSelectors: true },
  'undeclared-apply': { applyType: 'handshake_form', undeclaredApply: true },
};

interface MockState {
  readonly scenario: HandshakeScenario;
  readonly config: ScenarioConfig;
  apiMode: HandshakeApiMode;
  applicationStatus: number;
  documents: readonly DocumentRecord[];
  jobs: readonly Job[];
  loggedIn: boolean;
  readonly requests: HandshakeRequest[];
  readonly pagesServed: string[];
}

/** Install the mock site. Call before navigating a page to `app.joinhandshake.com`. */
export async function installHandshakeRoutes(
  context: BrowserContext,
  scenario: HandshakeScenario = 'search-10-jobs',
): Promise<MockHandshake> {
  const config: ScenarioConfig = { ...BASE_CONFIG, ...SCENARIOS[scenario] };
  const state: MockState = {
    scenario,
    config,
    apiMode: config.apiMode,
    applicationStatus: config.applicationStatus,
    documents: SAMPLE_DOCUMENTS,
    jobs: SAMPLE_JOBS,
    loggedIn: !config.requiresLogin,
    requests: [],
    pagesServed: [],
  };

  if (state.loggedIn) await seedSessionCookie(context);

  await context.route(HANDSHAKE_ROUTE_GLOB, async (route) => {
    await handleRoute(route, state, context);
  });

  return {
    scenario,
    origin: HANDSHAKE_ORIGIN,
    requests: state.requests,
    pagesServed: state.pagesServed,
    jobIds: state.jobs.map((job) => job.id),
    searchUrl: (page = 1) =>
      `${HANDSHAKE_ORIGIN}/job-search${page > 1 ? `?page=${String(page)}` : ''}`,
    jobUrl: (jobId) => `${HANDSHAKE_ORIGIN}/jobs/${jobId}`,
    apiUrl: (jobId) => `${HANDSHAKE_ORIGIN}/stu/jobs/${jobId}`,
    documentsUrl: () => `${HANDSHAKE_ORIGIN}/docs`,
    myJobsUrl: () => `${HANDSHAKE_ORIGIN}/my-jobs`,
    loginUrl: () => `${HANDSHAKE_ORIGIN}/login`,
    setApiMode: (mode) => {
      state.apiMode = mode;
    },
    setApplicationStatus: (status) => {
      state.applicationStatus = status;
    },
    setDocuments: (documents) => {
      state.documents = documents;
    },
    setSearchJobs: (jobs) => {
      state.jobs = jobs;
    },
    setLoggedIn: (value) => {
      state.loggedIn = value;
      void (value ? seedSessionCookie(context) : clearSessionCookie(context)).catch(
        () => undefined,
      );
    },
    isLoggedIn: () => state.loggedIn,
    requestsFor: (pathname) => state.requests.filter((entry) => entry.pathname === pathname),
    dispose: async () => {
      await context.unroute(HANDSHAKE_ROUTE_GLOB);
    },
  };
}

async function seedSessionCookie(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: MOCK_SESSION_COOKIE,
      value: MOCK_SESSION_VALUE,
      domain: 'app.joinhandshake.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

async function clearSessionCookie(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: MOCK_SESSION_COOKIE });
}

async function handleRoute(route: Route, state: MockState, context: BrowserContext): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const resourceType = request.resourceType();

  state.requests.push({
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    resourceType,
  });

  if (request.method() === 'POST' && /^\/jobs\/\d+\/applications$/.test(url.pathname)) {
    await fulfillApplicationPost(route, state);
    return;
  }

  if (request.method() !== 'GET') {
    await fulfillJson(route, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/favicon.ico') {
    await route.fulfill({ status: 204, body: '' });
    return;
  }

  if (url.pathname === '/') {
    await redirect(route, '/job-search');
    return;
  }

  if (url.pathname === '/login') {
    await serveLogin(route, state, url, context);
    return;
  }

  // Protected pages bounce to the login page until the mock sign-in completes.
  if (state.config.requiresLogin && !state.loggedIn && resourceType === 'document') {
    const target = `${url.pathname}${url.search}`;
    await redirect(route, `/login?redirect=${encodeURIComponent(target)}`);
    return;
  }

  if (url.pathname === '/job-search' || url.pathname === '/postings') {
    const page = parsePage(url.searchParams.get('page'));
    const html = renderSearchPage(state, url.pathname, page);
    state.pagesServed.push(`${url.pathname}${url.search}`);
    await fulfillHtml(route, html);
    return;
  }

  const jobMatch = /^\/jobs\/(\d+)$/.exec(url.pathname);
  if (jobMatch?.[1]) {
    const job = findJob(state, jobMatch[1]);
    state.pagesServed.push(url.pathname);
    await fulfillHtml(route, renderJobPage(state, job));
    return;
  }

  const apiMatch = /^\/stu\/jobs\/(\d+)$/.exec(url.pathname);
  if (apiMatch?.[1]) {
    await serveJobApi(route, state, apiMatch[1]);
    return;
  }

  if (url.pathname === '/profile/documents') {
    state.pagesServed.push(url.pathname);
    await fulfillHtml(
      route,
      '<!doctype html><h1>Page not found</h1><p>That page does not exist.</p>',
    );
    return;
  }

  if (url.pathname === '/stu/documents') {
    state.pagesServed.push(url.pathname);
    // Chromium follows an intercepted HTTP redirect outside Playwright's route
    // handler. A same-origin meta navigation keeps the redirect fully mocked.
    await fulfillHtml(
      route,
      '<!doctype html><meta http-equiv="refresh" content="0;url=/docs"><title>Documents | Handshake</title>',
    );
    return;
  }

  if (url.pathname === '/docs' || url.pathname === '/documents') {
    state.pagesServed.push(url.pathname);
    await fulfillHtml(route, renderDocumentsPage(state));
    return;
  }

  if (url.pathname === '/my-jobs') {
    state.pagesServed.push(url.pathname);
    await fulfillHtml(route, renderMyJobsPage());
    return;
  }

  const wantsJson =
    resourceType === 'xhr' ||
    resourceType === 'fetch' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/stu/');

  if (wantsJson) {
    await fulfillJson(route, 404, { error: 'not_found' });
    return;
  }

  state.pagesServed.push(url.pathname);
  await fulfillHtml(route, renderNotFoundPage(url.pathname), 404);
}

async function serveLogin(
  route: Route,
  state: MockState,
  url: URL,
  context: BrowserContext,
): Promise<void> {
  const signingIn = url.searchParams.get('signin') === '1';
  if (signingIn) {
    state.loggedIn = true;
    await seedSessionCookie(context);
    await redirect(route, safeRedirect(url.searchParams.get('redirect')));
    return;
  }

  state.pagesServed.push(`${url.pathname}${url.search}`);
  await fulfillHtml(route, renderLoginPage(url.searchParams.get('redirect')));
}

async function serveJobApi(route: Route, state: MockState, jobId: string): Promise<void> {
  switch (state.apiMode) {
    case 'rate_limited':
      await fulfillJson(route, 429, { error: 'rate_limited', retry_after_seconds: 60 });
      return;
    case 'forbidden':
      await fulfillJson(route, 403, { error: 'forbidden' });
      return;
    case 'unprocessable':
      await fulfillJson(route, 422, { error: 'unprocessable_entity' });
      return;
    case 'ok': {
      const job = findJob(state, jobId);
      const config = configForJob(state, job);
      await fulfillJson(route, 200, jobDetailJson(job, config));
      return;
    }
  }
}

async function fulfillApplicationPost(route: Route, state: MockState): Promise<void> {
  const status = state.applicationStatus;
  if (status === 200) {
    await fulfillJson(route, 200, {
      status: 'ok',
      confirmation: 'Application submitted',
    });
    return;
  }
  if (status === 429) {
    await fulfillJson(route, 429, { error: 'rate_limited', retry_after_seconds: 60 });
    return;
  }
  if (status === 403) {
    await fulfillJson(route, 403, { error: 'forbidden' });
    return;
  }
  await fulfillJson(route, status, { error: 'application_failed' });
}

function jobDetailJson(job: Job, config: ScenarioConfig): Record<string, unknown> {
  return {
    id: Number(job.id),
    title: job.title,
    employer: { id: 1000, name: job.employer },
    description: job.description,
    job_apply_setting: { apply_type: config.applyType },
    required_job_document_types: config.requiredDocuments,
    apply_start: job.applyStartAt ?? '2026-01-01T00:00:00.000Z',
    location: job.location ?? null,
    employment_type: job.employmentType ?? null,
    already_applied: config.applied,
    closed: config.closed,
  };
}

/** Per-job overrides so the search scenario shows realistic variety. */
function configForJob(state: MockState, job: Job): ScenarioConfig {
  if (state.scenario !== 'search-10-jobs') {
    return { ...state.config, requiredDocuments: [...state.config.requiredDocuments] };
  }

  const applyType: ApplyType = job.applyType === 'external' ? 'external' : job.applyType;
  return {
    ...state.config,
    applyType,
    external: applyType === 'external',
    requiredDocuments: [...job.requiredDocumentTypes],
    applied: job.id === '900007',
    closed: job.id === '900009',
  };
}

function findJob(state: MockState, jobId: string): Job {
  const found = state.jobs.find((job) => job.id === jobId);
  if (found) return found;
  return {
    id: jobId,
    host: 'app.joinhandshake.com',
    title: `Sample Job ${jobId}`,
    employer: 'Sample Employer',
    url: `${HANDSHAKE_ORIGIN}/jobs/${jobId}`,
    description: 'Sanitized mock job description used for tests only.',
    applyType: 'quick_apply',
    requiredDocumentTypes: ['resume'],
    source: 'search',
    discoveredAt: 0,
  };
}

function parsePage(raw: string | null): number {
  const parsed = Number(raw ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/job-search';
}

/**
 * Navigate without an HTTP 3xx. A 3xx returned from `route.fulfill` can be followed
 * outside route interception in Playwright, which would hit the real site. A
 * meta-refresh document is a normal same-origin navigation and stays mocked.
 */
async function redirect(route: Route, location: string): Promise<void> {
  const href = escapeHtml(location);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${href}">
  <title>Redirecting… | Handshake (mock)</title>
</head>
<body>
  <main data-testid="redirect-page">
    <p>Redirecting to <a href="${href}">the next page</a>.</p>
  </main>
</body>
</html>`;
  await fulfillHtml(route, html);
}

async function fulfillHtml(route: Route, html: string, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'text/html; charset=utf-8', body: html });
}

async function fulfillJson(route: Route, status: number, payload: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function pageShell(options: { title: string; body: string; signedIn: boolean }): string {
  const userMenu = options.signedIn
    ? `<nav aria-label="User menu" class="user-menu">
        <button type="button" aria-haspopup="menu" data-testid="user-menu">Account</button>
      </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} | Handshake (mock)</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1c2430; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #dde2e8; }
    .brand { font-weight: 700; color: #1c2430; text-decoration: none; }
    .mock-badge { font-size: 11px; font-weight: 600; color: #7a4b00; background: #fff2cc; border-radius: 999px; padding: 2px 8px; margin-left: 6px; text-transform: uppercase; letter-spacing: .04em; }
    .user-menu button { border: 1px solid #c9d1db; background: #fff; border-radius: 999px; padding: 6px 14px; cursor: pointer; }
    main { max-width: 880px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 18px; }
    .muted { color: #5b6674; }
    .meta { color: #5b6674; font-size: 14px; }
    .job-list { list-style: none; padding: 0; display: grid; gap: 12px; }
    .job-list article { background: #fff; border: 1px solid #dde2e8; border-radius: 12px; padding: 16px; }
    .job-list h2 { margin: 0 0 4px; font-size: 18px; }
    .job-list a { color: #0b57d0; text-decoration: none; }
    .field { display: grid; gap: 6px; margin: 14px 0; }
    .field label, .field legend { font-weight: 600; }
    .field input, .field select, .field textarea { padding: 8px; border: 1px solid #c9d1db; border-radius: 8px; font: inherit; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    button, .button { padding: 9px 16px; border-radius: 8px; border: 1px solid #c9d1db; background: #fff; font: inherit; cursor: pointer; }
    button[data-testid="apply-button"], button[data-testid="submit-application"] { background: #0b57d0; border-color: #0b57d0; color: #fff; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    #apply-dialog { position: fixed; inset: 0; background: rgba(16, 24, 40, .45); display: grid; place-items: center; padding: 24px; }
    #apply-dialog[hidden] { display: none; }
    #apply-dialog [role="dialog"] { background: #fff; border-radius: 14px; padding: 24px; width: min(560px, 100%); max-height: 85vh; overflow: auto; }
    .banner { border-radius: 10px; padding: 12px 16px; margin: 16px 0; }
    .banner[data-tone="success"] { background: #e6f4ea; color: #14532d; }
    .banner[data-tone="error"] { background: #fde8e8; color: #8a1c1c; }
    .banner[data-tone="info"] { background: #e8f0fe; color: #173b7a; }
    .pager { display: flex; justify-content: flex-end; margin-top: 18px; }
    .documents { list-style: none; padding: 0; display: grid; gap: 10px; }
    .documents li { background: #fff; border: 1px solid #dde2e8; border-radius: 10px; padding: 12px 16px; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/job-search">Handshake <span class="mock-badge">mock</span></a>
    ${userMenu}
  </header>
  ${options.body}
  <script>${RUNTIME_SCRIPT}</script>
</body>
</html>`;
}

function renderSearchPage(state: MockState, searchPath: string, page: number): string {
  const pageSize = state.config.searchPageSize;
  const jobs = page === 1 ? state.jobs.slice(0, pageSize) : [];
  // Page 1 always links to page 2; page 2 is the empty terminal page.
  const hasNext = page === 1 && jobs.length > 0;

  const cards = jobs
    .map(
      (job) => `<li>
        <article data-job-id="${escapeHtml(job.id)}" data-apply-type="${escapeHtml(job.applyType)}" aria-label="${escapeHtml(job.title)} at ${escapeHtml(job.employer)}">
          <h2><a href="/jobs/${escapeHtml(job.id)}" data-spa-link data-testid="job-link">${escapeHtml(job.title)}</a></h2>
          <p data-testid="employer">${escapeHtml(job.employer)}</p>
          <p class="meta">${escapeHtml(job.location ?? 'Location not listed')} · ${escapeHtml(job.employmentType ?? 'Role')}${job.remote ? ' · Remote' : ''}</p>
        </article>
      </li>`,
    )
    .join('\n');

  const list =
    jobs.length > 0
      ? `<ul class="job-list" data-testid="job-results">${cards}</ul>`
      : `<p role="status" data-testid="empty-state">No jobs match this search.</p>`;

  const nextHref = `${searchPath}?page=${String(page + 1)}`;
  const pager = hasNext
    ? `<a class="button" href="${escapeHtml(nextHref)}" rel="next" data-testid="next-page">Next</a>`
    : `<button type="button" disabled data-testid="next-page">Next</button>`;

  const body = `<main data-page="search" data-search-path="${escapeHtml(searchPath)}" data-page-number="${String(page)}">
    <h1>Job search</h1>
    <p class="muted">Sanitized local mock. No network requests leave this browser.</p>
    <form role="search" aria-label="Job search" action="${escapeHtml(searchPath)}" method="get">
      <div class="field">
        <label for="search-keywords">Keywords</label>
        <input id="search-keywords" name="q" type="search" placeholder="Search jobs">
      </div>
      <button type="submit">Search</button>
    </form>
    ${list}
    <nav class="pager" aria-label="Pagination">${pager}</nav>
  </main>`;

  return pageShell({
    title: 'Job search',
    body,
    signedIn: state.loggedIn,
  });
}

function renderJobPage(state: MockState, job: Job): string {
  const config = configForJob(state, job);
  const status = renderJobStatus(config);
  const actions = renderJobActions(config);
  const modal = renderApplyDialog(state, job, config);

  const body = `<main data-hook="job-details-page" data-testid="job-detail" data-job-id="${escapeHtml(job.id)}" data-variant="${escapeHtml(config.applyType)}" data-modal-delay="${String(config.modalDelayMs)}" data-document-delay="${String(config.documentDelayMs)}" data-suppress-confirmation="${String(config.suppressConfirmation)}" data-quick-apply-review="${String(config.quickApplyReview)}" data-one-click-apply="${String(config.oneClickApply)}" data-post-url="/jobs/${escapeHtml(job.id)}/applications">
    <nav aria-label="Breadcrumb"><a href="/job-search">Job search</a></nav>
    <h1>${escapeHtml(job.title)}</h1>
    <p data-testid="employer">${escapeHtml(job.employer)}</p>
    <p class="meta">${escapeHtml(job.location ?? 'Location not listed')} · ${escapeHtml(job.employmentType ?? 'Role')}${job.remote ? ' · Remote' : ''}${job.salary ? ` · ${escapeHtml(job.salary)}` : ''}</p>
    <section aria-label="Job description">
      <h2>Description</h2>
      <p>${escapeHtml(job.description)}</p>
    </section>
    <div data-testid="job-status">${status}</div>
    ${actions}
    ${modal}
    <script type="application/json" id="mock-documents">${safeJson(state.documents)}</script>
  </main>`;

  return pageShell({
    title: job.title,
    body,
    signedIn: state.loggedIn,
  });
}

function renderJobStatus(config: ScenarioConfig): string {
  if (config.applied) {
    return `<p class="banner" data-tone="success" role="status" data-testid="applied-banner">You applied on January 12, 2026</p>`;
  }
  if (config.closed) {
    return `<p class="banner" data-tone="info" role="status" data-testid="closed-banner">This job is no longer accepting applications.</p>`;
  }
  return '';
}

function renderJobActions(config: ScenarioConfig): string {
  if (config.breakSelectors) {
    return `<p class="banner" data-tone="info" data-testid="job-actions-missing">Application controls are not available on this page.</p>`;
  }
  if (config.applied) {
    return `<button type="button" disabled data-testid="applied-button">Applied</button>`;
  }
  if (config.closed) {
    return '';
  }
  if (config.external) {
    return `<p data-testid="external-note">This application opens on the employer's site.</p>
      <a class="button" data-testid="apply-external" href="https://careers.example.com/apply?job=900005" target="_blank" rel="noopener noreferrer">Apply Externally</a>`;
  }
  const label = config.applyType === 'quick_apply' ? 'Quick Apply' : 'Apply';
  if (config.oneClickApply) {
    return `<button type="button" class="rosetta-button" data-kind="button" data-variant="primary" data-testid="apply-button">Apply</button>
      <div style="opacity:0"><button type="button" aria-label="Apply" data-kind="button" data-variant="primary">Apply</button></div>`;
  }
  // Advertise the intermediate review step so the content adapter can safely
  // click Quick Apply in review mode without submitting.
  const dialogAttrs =
    !config.undeclaredApply && (config.quickApplyReview || config.applyType === 'handshake_form')
      ? ' aria-haspopup="dialog" aria-controls="apply-dialog"'
      : '';
  return `<button type="button" data-testid="apply-button" data-action="open-apply"${dialogAttrs}>${label}</button>`;
}

function renderApplyDialog(state: MockState, job: Job, config: ScenarioConfig): string {
  if (
    config.external ||
    config.applied ||
    config.closed ||
    config.breakSelectors ||
    config.oneClickApply
  )
    return '';

  const documents =
    config.questions || config.applyType === 'handshake_form' || config.quickApplyReview
      ? renderDocumentFields(config)
      : '';
  const questions = config.questions ? renderQuestionFields() : '';

  return `<div id="apply-dialog" hidden>
    <div role="dialog" aria-modal="true" aria-labelledby="apply-dialog-title" data-testid="apply-dialog">
      <h2 id="apply-dialog-title">Apply to ${escapeHtml(job.title)}</h2>
      <form data-testid="apply-form" novalidate>
        ${config.requiredDocuments.length === 0 ? '<p>Applying requires no additional documents.</p>' : ''}
        ${documents}
        ${questions}
        <p class="banner" data-tone="error" role="alert" data-testid="form-error" hidden></p>
        <div class="actions">
          <button type="button" data-testid="cancel-apply">Cancel</button>
          <button type="submit" data-testid="submit-application">Submit Application</button>
        </div>
      </form>
    </div>
  </div>`;
}

function renderDocumentFields(config: ScenarioConfig): string {
  const labels: Record<DocumentType, string> = {
    resume: 'Resume',
    cover_letter: 'Cover letter',
    transcript: 'Transcript',
    other: 'Supporting document',
  };

  return config.requiredDocuments
    .map((type) => {
      const id = `document-field-${type.replace(/_/g, '-')}`;
      return `<div class="field">
        <label for="${id}">${labels[type]} <span aria-hidden="true">*</span></label>
        <select id="${id}" name="${type}" data-testid="document-${type.replace(/_/g, '-')}" data-document-type="${type}" required>
          <option value="">Select a ${labels[type].toLowerCase()}</option>
        </select>
      </div>`;
    })
    .join('\n');
}

function renderQuestionFields(): string {
  return `<div class="field">
      <label for="question-why">Why are you interested in this role? <span aria-hidden="true">*</span></label>
      <textarea id="question-why" name="why_this_company" data-testid="question-why" required></textarea>
    </div>
    <div class="field">
      <label for="question-work-authorization">Are you legally authorized to work in the United States? <span aria-hidden="true">*</span></label>
      <select id="question-work-authorization" name="work_authorization" data-testid="question-work-authorization" required>
        <option value="">Select an answer</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
    <fieldset class="field" data-testid="question-sponsorship">
      <legend>Will you now or in the future require sponsorship? <span aria-hidden="true">*</span></legend>
      <label><input type="radio" name="sponsorship_required" value="yes" required> Yes</label>
      <label><input type="radio" name="sponsorship_required" value="no"> No</label>
    </fieldset>`;
}

const MOCK_DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  resume: 'Resume',
  cover_letter: 'Cover Letter',
  transcript: 'Transcript',
  other: 'Other',
};

/**
 * A sanitized documents page. Handshook never reads it (documents are entered
 * by link or ID), so it only exists for "open my documents" navigation in tests.
 */
function renderDocumentsPage(state: MockState): string {
  const rows = state.documents
    .map(
      (document) => `<tr>
        <td><a href="/docs/${escapeHtml(document.id)}">${escapeHtml(document.title)}</a></td>
        <td>${MOCK_DOCUMENT_TYPE_LABEL[document.type]}</td>
        <td>Yes</td>
        <td>Default</td>
        <td>${document.ready === false ? 'Processing' : 'Ready'}</td>
        <td>${escapeHtml(document.uploadedAt ?? '')}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html><head><title>Documents | Handshake (mock)</title></head>
    <body><h1>My documents</h1>
    <table><thead><tr>
      <th>Name</th><th>Type</th><th>Employer Visibility</th><th>Category</th><th>Status</th><th>Upload date</th>
    </tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function renderMyJobsPage(): string {
  const applied = SAMPLE_JOBS.filter((job) => ['900001', '900004', '900007'].includes(job.id));
  const items = applied
    .map(
      (job) => `<li data-job-id="${escapeHtml(job.id)}">
        <a href="/jobs/${escapeHtml(job.id)}">${escapeHtml(job.title)}</a>
        <span class="muted">${escapeHtml(job.employer)} · Applied</span>
      </li>`,
    )
    .join('\n');

  const body = `<main data-testid="my-jobs-page">
    <h1>My Jobs</h1>
    <h2>Applied</h2>
    <ul class="documents" data-testid="applied-list">${items}</ul>
  </main>`;

  return pageShell({ title: 'My Jobs', body, signedIn: true });
}

function renderLoginPage(rawRedirect: string | null): string {
  const redirectTo = safeRedirect(rawRedirect);
  const body = `<main data-testid="login-page">
    <h1>Sign in to Handshake</h1>
    <p class="muted">Mock sign-in. Any value works; nothing leaves this browser.</p>
    <form method="get" action="/login">
      <input type="hidden" name="signin" value="1">
      <input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}">
      <div class="field">
        <label for="login-email">Email</label>
        <input id="login-email" name="email" type="email" autocomplete="off" placeholder="you@example.edu">
      </div>
      <div class="field">
        <label for="login-password">Password</label>
        <input id="login-password" name="password" type="password" autocomplete="off">
      </div>
      <button type="submit" data-testid="sign-in">Sign in</button>
    </form>
  </main>`;

  return pageShell({ title: 'Sign in', body, signedIn: false });
}

function renderNotFoundPage(pathname: string): string {
  const body = `<main data-testid="not-found">
    <h1>Page not found</h1>
    <p class="muted">The mock Handshake site has no route for ${escapeHtml(pathname)}.</p>
    <p><a href="/job-search">Back to job search</a></p>
  </main>`;

  return pageShell({ title: 'Not found', body, signedIn: false });
}

/**
 * Mock runtime shared by every page.
 *
 * Handles SPA (`pushState`) navigation for job links and initializes apply-flow
 * behaviour for job pages. It re-runs after every SPA swap so the new DOM gets fresh
 * listeners, the way React would on the real site.
 */
const RUNTIME_SCRIPT = `
(function () {
  'use strict';

  function handleSpaClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var anchor = target.closest('a[data-spa-link]');
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || href.charAt(0) !== '/') return;
    event.preventDefault();
    fetch(href, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (response) { return response.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextMain = doc.querySelector('main');
        var currentMain = document.querySelector('main');
        if (!nextMain || !currentMain) {
          window.location.href = href;
          return;
        }
        currentMain.replaceWith(nextMain);
        history.pushState({ mockSpa: true }, '', href);
        window.dispatchEvent(new PopStateEvent('popstate'));
        initJobPage();
      })
      .catch(function () { window.location.href = href; });
  }

  function initJobPage() {
  var root = document.querySelector('[data-testid="job-detail"]');
  if (!root) return;

  var dialogWrap = document.getElementById('apply-dialog');
  var form = document.querySelector('[data-testid="apply-form"]');
  var submitButton = document.querySelector('[data-testid="submit-application"]');
  var cancelButton = document.querySelector('[data-testid="cancel-apply"]');
  var applyButton = document.querySelector('[data-testid="apply-button"]');
  var errorBox = document.querySelector('[data-testid="form-error"]');
  var variant = root.getAttribute('data-variant') || 'quick_apply';
  var reviewStep = root.getAttribute('data-quick-apply-review') === 'true';
  var oneClickApply = root.getAttribute('data-one-click-apply') === 'true';
  var modalDelay = Number(root.getAttribute('data-modal-delay') || '0');
  var documentDelay = Number(root.getAttribute('data-document-delay') || '0');
  var suppressConfirmation = root.getAttribute('data-suppress-confirmation') === 'true';
  var postUrl = root.getAttribute('data-post-url') || '';
  var pending = false;

  function showError(message) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    // Quick Apply has no open dialog; surface the failure on the job page too.
    if (!dialogWrap || dialogWrap.hidden) {
      var banner = document.createElement('p');
      banner.className = 'banner';
      banner.setAttribute('data-tone', 'error');
      banner.setAttribute('role', 'alert');
      banner.setAttribute('data-testid', 'submit-error');
      banner.textContent = message;
      var status = document.querySelector('[data-testid="job-status"]');
      if (status) status.replaceChildren(banner);
      else root.appendChild(banner);
    }
  }

  function clearError() {
    if (errorBox) {
      errorBox.textContent = '';
      errorBox.hidden = true;
    }
    var existing = root.querySelector('[data-testid="submit-error"]');
    if (existing) existing.remove();
  }

  function showConfirmation() {
    if (dialogWrap) dialogWrap.hidden = true;
    if (applyButton) {
      applyButton.disabled = true;
      applyButton.setAttribute('aria-disabled', 'true');
      applyButton.textContent = oneClickApply ? 'Apply' : 'Applied';
    }
    if (oneClickApply) {
      var appliedBanner = document.createElement('div');
      appliedBanner.className = 'rosetta-banner';
      appliedBanner.setAttribute('role', 'alert');
      appliedBanner.setAttribute('data-testid', 'live-applied-banner');
      var body = document.createElement('div');
      body.className = 'rosetta-banner__body';
      var content = document.createElement('div');
      content.className = 'rosetta-banner__content';
      var heading = document.createElement('h2');
      heading.className = 'rosetta-banner__header rosetta-body-medium-semibold';
      heading.textContent = 'Applied on October 27, 2026';
      var withdraw = document.createElement('button');
      withdraw.setAttribute('data-kind', 'button');
      withdraw.setAttribute('data-variant', 'secondary');
      withdraw.textContent = 'Withdraw application';
      content.appendChild(heading);
      content.appendChild(withdraw);
      body.appendChild(content);
      appliedBanner.appendChild(body);
      var status = document.querySelector('[data-testid="job-status"]');
      if (status) status.replaceChildren(appliedBanner);
      else root.appendChild(appliedBanner);
      var toast = document.createElement('div');
      toast.setAttribute('role', 'alert');
      toast.textContent = 'Application submitted';
      root.appendChild(toast);
      window.setTimeout(function () { toast.remove(); }, 300);
      return;
    }
    var banner = document.createElement('p');
    banner.className = 'banner';
    banner.setAttribute('data-tone', 'success');
    banner.setAttribute('role', 'status');
    banner.setAttribute('data-testid', 'confirmation');
    banner.textContent = 'Application submitted';
    var status = document.querySelector('[data-testid="job-status"]');
    if (status) status.replaceChildren(banner);
    else root.appendChild(banner);
  }

  function missingRequiredField() {
    if (!form) return false;
    var required = form.querySelectorAll('[required]');
    for (var i = 0; i < required.length; i += 1) {
      var field = required[i];
      if (field.type === 'radio') {
        if (!form.querySelector('input[name="' + field.name + '"]:checked')) return true;
        continue;
      }
      if (!field.value) return true;
    }
    return false;
  }

  function submitApplication() {
    if (pending) return;
    clearError();
    if (missingRequiredField()) {
      showError('Complete the required fields before submitting.');
      return;
    }
    pending = true;
    if (submitButton) submitButton.disabled = true;

    fetch(postUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
      .then(function (response) {
        if (response.status === 429) {
          showError('Too many requests. Please wait a moment and try again.');
          return;
        }
        if (response.status === 403) {
          showError('You do not have permission to apply to this job.');
          return;
        }
        if (!response.ok) {
          showError('Something went wrong. Please try again.');
          return;
        }
        if (!suppressConfirmation) showConfirmation();
      })
      .catch(function () {
        showError('Network error. Please try again.');
      })
      .finally(function () {
        pending = false;
        if (submitButton) submitButton.disabled = false;
      });
  }

  function openDialog() {
    if (!dialogWrap) {
      submitApplication();
      return;
    }
    clearError();
    dialogWrap.hidden = false;
    var first = dialogWrap.querySelector('select, textarea, input');
    if (first) first.focus();
  }

  function closeDialog() {
    if (dialogWrap) dialogWrap.hidden = true;
    clearError();
  }

  function populateDocuments() {
    var data = document.getElementById('mock-documents');
    if (!data) return;
    var documents = [];
    try { documents = JSON.parse(data.textContent || '[]'); } catch (error) { documents = []; }
    var selects = document.querySelectorAll('select[data-document-type]');
    for (var i = 0; i < selects.length; i += 1) {
      var select = selects[i];
      var type = select.getAttribute('data-document-type');
      for (var j = 0; j < documents.length; j += 1) {
        if (documents[j].type !== type) continue;
        var option = document.createElement('option');
        option.value = documents[j].id;
        option.textContent = documents[j].title;
        select.appendChild(option);
      }
    }
  }

  if (applyButton) {
    applyButton.addEventListener('click', function () {
      if ((!oneClickApply && variant === 'handshake_form') || reviewStep) {
        openDialog();
        return;
      }
      if (modalDelay > 0) {
        window.setTimeout(openDialog, modalDelay);
        return;
      }
      submitApplication();
    });
  }

  if (cancelButton) cancelButton.addEventListener('click', closeDialog);

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitApplication();
    });
  }

  window.setTimeout(populateDocuments, documentDelay);
  }

  document.addEventListener('click', handleSpaClick);
  initJobPage();
})();
`;
