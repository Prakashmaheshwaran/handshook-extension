import type { ApplyResult, ContentRequest, MessageResponse } from '@/core/contracts';
import { appError } from '@/core/contracts';
import { revokeSubmitRequestSchema, type ApplyControl } from '@/core/contracts/submitAuthorization';
import { requestSubmitAuthorization } from '@/content/submit-authorization';
import { requestPageAssist } from '@/content/page-assist';
import { requestAnswerAssist, requestAnswerWrite } from '@/content/answer-assist';
import {
  registerContentBridge,
  registerContentCommand,
  responseOk,
  sendContentEvent,
} from '@/content/bridge';
import { watchRoute } from '@/content/lifecycle';
import { applyToJob } from '@/handshake/applyFlow';
import { scanPage } from '@/handshake/discovery';
import { getSelectorHealth } from '@/handshake/health';
import { currentHost } from '@/handshake/host';
import { detectJobPageState, inspectJob, JobInspectionError } from '@/handshake/jobDetails';
import {
  detectAlreadyApplied,
  confirmationBaseline,
  detectConfirmation,
  isApplicationModalOpen,
  recordJobActionOutline,
  waitForJobPageReady,
} from '@/handshake/verification';
import { CancelledError, isVisible, waitFor, waitForDom, WaitTimeoutError } from '@/handshake/dom';
import { sleep } from '@/core/util/time';

const cancellations = new Map<string, AbortController>();
const submitControls = new Map<string, { requestId: string; reviewRequired: boolean }>();

function host(): string {
  return currentHost(location);
}

export type SessionStatus = 'unknown' | 'logged_in' | 'logged_out';

/**
 * Account chrome that only Handshake renders for a signed-in student: the
 * app nav/`/stu/` links, dashboard and profile links, logout, and the avatar
 * or initials chip.
 */
const SESSION_EVIDENCE_SELECTORS = [
  '[data-testid*="user-menu" i]',
  '[data-testid*="account-menu" i]',
  '[data-testid*="avatar" i]',
  '[data-testid*="initials" i]',
  '[aria-label*="user menu" i]',
  '[aria-label*="account menu" i]',
  'a[href*="/logout" i]',
  'a[href*="/sign-out" i]',
  'a[href*="/my-jobs" i]',
  'a[href*="/profile" i]',
  'a[href*="/dashboard" i]',
  'a[href*="/stu/" i]',
  'nav a[href*="/stu/" i]',
] as const;

const SESSION_LOGGED_OUT_TEXT = [
  'sign in to handshake',
  'log in to handshake',
  'session expired',
] as const;

/** `/login`, `/signin`, `/sign-in`, and `/sso` are the sign-in entry points. */
const SESSION_LOGGED_OUT_PATH = /^\/(login|signin|sign-in|sso)(\/|$)/i;

/**
 * Read one DOM snapshot. Only positive account evidence counts as
 * `logged_in`; an unrecognized page is `unknown`, never a false "connected"
 * state.
 */
export function detectSessionStatus(doc: Document): SessionStatus {
  const text = doc.body?.innerText?.slice(0, 4000).toLowerCase() ?? '';
  const loggedOut =
    SESSION_LOGGED_OUT_PATH.test(location.pathname) ||
    SESSION_LOGGED_OUT_TEXT.some((phrase) => text.includes(phrase));
  if (loggedOut) return 'logged_out';

  const hasAccountChrome = SESSION_EVIDENCE_SELECTORS.some((selector) =>
    Array.from(doc.querySelectorAll<HTMLElement>(selector)).some((element) => isVisible(element)),
  );
  if (hasAccountChrome) return 'logged_in';

  // A rendered job surface (results or a job card) also means the protected app
  // shell loaded rather than a logged-out page.
  const hasAppContent = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[data-testid="job-results"], [data-job-id], [data-testid="job-detail"]',
    ),
  ).some((element) => isVisible(element));
  return hasAppContent ? 'logged_in' : 'unknown';
}

/** How long a session check waits for the page to show session evidence. */
export const SESSION_SETTLE_MS = 12_000;

const SESSION_POLL_INTERVAL_MS = 250;

/**
 * Signed-in evidence only counts once the document finished loading: Handshake
 * can still redirect to `/login` while its shell renders, and a job surface
 * from a previous page must not be mistaken for the new one. A `logged_out`
 * redirect is decisive and reported immediately.
 */
function loadedPageSessionStatus(doc: Document): SessionStatus {
  const status = detectSessionStatus(doc);
  if (status !== 'logged_in') return status;
  return doc.readyState === 'complete' ? 'logged_in' : 'unknown';
}

/**
 * Handshake's home page redirects and its app shell renders client-side, so a
 * check that lands mid-load would report `unknown` for a signed-in user. Wait
 * for a complete document with evidence; a redirect that unloads this page is
 * retried by the background on the next page. Never guess `logged_in`.
 */
export async function settledSessionStatus(doc: Document): Promise<SessionStatus> {
  try {
    return await waitForDom(
      doc,
      () => {
        const status = loadedPageSessionStatus(doc);
        return status === 'unknown' ? null : status;
      },
      { timeoutMs: SESSION_SETTLE_MS, intervalMs: SESSION_POLL_INTERVAL_MS },
    );
  } catch (error) {
    if (error instanceof WaitTimeoutError) return 'unknown';
    throw error;
  }
}

/**
 * Send the selector-health snapshot after a scan or apply. The background
 * persists it for Diagnostics; a failure to send must not break the action.
 */
function reportSelectorHealth(): void {
  const snapshot = getSelectorHealth();
  if (snapshot.length === 0) return;
  void sendContentEvent({
    type: 'content.event.selectorHealth',
    health: snapshot,
  });
}

function errorResponse(requestId: string, error: unknown): MessageResponse<unknown> {
  if (error instanceof CancelledError) {
    return { requestId, ok: false, error: appError('CANCELLED', 'Job operation cancelled') };
  }
  if (error instanceof JobInspectionError) {
    return {
      requestId,
      ok: false,
      error: appError(error.code, error.message, { retryable: error.code === 'NOT_OPEN' }),
    };
  }
  return {
    requestId,
    ok: false,
    error: appError('UNKNOWN', error instanceof Error ? error.message : 'Content handler failed', {
      retryable: true,
      cause: error,
    }),
  };
}

const reviewWatchers = new Map<string, number>();

/** Exact path-segment match: job `1234` must not match `/jobs/12345`. */
export function isJobPath(pathname: string, jobId: string): boolean {
  return (
    /^\/(?:stu\/)?jobs\/[^/]+\/?$/.test(pathname) &&
    pathname.split('/').filter(Boolean).at(-1) === jobId
  );
}

function watchReviewConfirmation(jobId: string, requestId: string, baselineTexts: string[]): void {
  const previous = reviewWatchers.get(jobId);
  if (previous !== undefined) window.clearInterval(previous);
  // M6: only a NEW confirmation on THIS job's page counts. A stale toast or a
  // description line cannot mark the job applied.
  const startedAt = Date.now();
  const stillOnJobPage = () => isJobPath(location.pathname, jobId);
  let delivering = false;
  let confirmed: ApplyResult | undefined;
  const timer = window.setInterval(() => {
    if (!stillOnJobPage()) {
      window.clearInterval(timer);
      reviewWatchers.delete(jobId);
      return;
    }
    const confirmation = detectConfirmation(document, { baselineTexts });
    if (!confirmed && confirmation.applied) {
      confirmed = {
        jobId,
        outcome: 'applied',
        submittedAt: Date.now(),
        confirmationText: confirmation.text,
      };
    }
    if (confirmed && !delivering) {
      delivering = true;
      void sendContentEvent({
        type: 'content.event.result',
        jobId,
        requestId,
        result: confirmed,
      }).then((accepted) => {
        delivering = false;
        if (!accepted) return;
        window.clearInterval(timer);
        if (reviewWatchers.get(jobId) === timer) reviewWatchers.delete(jobId);
      });
    }
    if (Date.now() - startedAt > 15 * 60_000) {
      window.clearInterval(timer);
      reviewWatchers.delete(jobId);
    }
  }, 1_000);
  reviewWatchers.set(jobId, timer);
}

/**
 * H2: `content.apply` is not idempotent. If the background lost the response
 * and retries the same requestId, return the first result instead of submitting
 * again. In-flight duplicates await the same promise.
 */
const MUTATING_REQUESTS: ReadonlySet<ContentRequest['type']> = new Set(['content.apply']);
const MUTATION_CACHE_MS = 5 * 60_000;
const completedMutations = new Map<string, { response: MessageResponse<unknown>; at: number }>();
const inFlightMutations = new Map<string, Promise<MessageResponse<unknown>>>();

function pruneCompletedMutations(): void {
  if (completedMutations.size <= 50) return;
  const oldest = [...completedMutations.entries()]
    .sort((left, right) => left[1].at - right[1].at)
    .slice(0, completedMutations.size - 50);
  for (const [key] of oldest) completedMutations.delete(key);
}

async function handle(request: ContentRequest): Promise<MessageResponse<unknown>> {
  if (!MUTATING_REQUESTS.has(request.type)) return handleRequest(request);
  const cached = completedMutations.get(request.requestId);
  if (cached && Date.now() - cached.at < MUTATION_CACHE_MS) return cached.response;
  const pending = inFlightMutations.get(request.requestId);
  if (pending) return pending;
  const run = handleRequest(request)
    .then((response) => {
      completedMutations.set(request.requestId, { response, at: Date.now() });
      pruneCompletedMutations();
      return response;
    })
    .finally(() => inFlightMutations.delete(request.requestId));
  inFlightMutations.set(request.requestId, run);
  return run;
}

/**
 * Advance every scrollable container around the last result row.
 *
 * The live result list is virtualised and scrolls inside its own pane, not the
 * window, so a single scroll call often does nothing. Walking the ancestors and
 * nudging each one (plus a wheel event, which some virtualisers listen for) is
 * what makes the next rows render.
 */
function advanceResults(): boolean {
  const rows = document.querySelectorAll<HTMLElement>(
    '[data-hook*="job-card" i], [data-job-id], a[href*="/jobs/"]',
  );
  const anchor = rows[rows.length - 1] ?? null;
  anchor?.scrollIntoView({ block: 'end' });
  let moved = false;
  for (let node: HTMLElement | null = anchor; node; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 8) continue;
    const next = Math.min(
      node.scrollTop + Math.max(node.clientHeight * 0.8, 200),
      node.scrollHeight,
    );
    if (next !== node.scrollTop) {
      node.scrollTop = next;
      moved = true;
    }
  }
  anchor?.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }));
  const before = window.scrollY;
  window.scrollBy(0, Math.max(window.innerHeight * 0.8, 300));
  return moved || window.scrollY !== before;
}

/**
 * One search page, read after the result list has settled.
 *
 * The list is virtualised: rows outside the viewport do not exist, so reading
 * once returns the few cards in view (a live run saw 3-4 of 25 per page).
 * Scroll it, keep the union of every row seen along the way, and report that.
 */
async function settledScan(): Promise<ReturnType<typeof scanPage>> {
  const read = () => scanPage(document, location.href, host());
  const first = await waitFor(
    () => {
      const page = read();
      return page.jobs.length > 0 || page.empty ? page : null;
    },
    { timeoutMs: 8_000 },
  ).catch(read);
  if (first.empty) return first;

  const seen = new Map(first.jobs.map((job) => [job.id, job]));
  const firstCount = seen.size;
  let probes = 0;
  let scrolled = false;
  let stable = 0;
  // The result fetch can take several seconds: give the list up to ~14 s to
  // finish rendering, and stop early once the count has not moved for a while.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = seen.size;
    probes += 1;
    if (advanceResults()) scrolled = true;
    await sleep(700);
    for (const job of read().jobs) seen.set(job.id, job);
    if (seen.size === before) {
      stable += 1;
      if (stable >= 4) break;
    } else {
      stable = 0;
    }
  }
  const last = read();
  return { ...last, jobs: [...seen.values()], diagnostics: { probes, firstCount, scrolled } };
}

async function handleRequest(request: ContentRequest): Promise<MessageResponse<unknown>> {
  switch (request.type) {
    case 'content.ping':
      return responseOk(request.requestId, { pong: true });

    case 'content.detectSession': {
      return responseOk(request.requestId, {
        status: await settledSessionStatus(document),
        host: host(),
      });
    }

    case 'content.scan': {
      // A protected search page redirects to /login. Scanning it as if it were
      // an empty result page would silently end the run instead of pausing for
      // the user to sign in.
      const pageState = detectJobPageState(document);
      if (pageState === 'login' || pageState === 'challenge') {
        return {
          requestId: request.requestId,
          ok: false,
          error:
            pageState === 'challenge'
              ? appError('CHALLENGE', 'Complete the verification challenge in the Handshook tab')
              : appError('AUTH_REQUIRED', 'Sign in to Handshake to continue'),
        };
      }
      const result = await settledScan();
      await sendContentEvent({
        type: 'content.event.discovered',
        jobs: result.jobs,
      });
      reportSelectorHealth();
      return responseOk(request.requestId, result);
    }

    case 'content.inspectJob': {
      const initialHost = host();
      const isCurrentJob = () =>
        host() === initialHost && isJobPath(location.pathname, request.jobId);
      if (!isCurrentJob()) {
        return {
          requestId: request.requestId,
          ok: false,
          error: appError(
            'CANCELLED',
            'The job page changed. Return to the queued job before retrying.',
          ),
        };
      }
      const controller = new AbortController();
      cancellations.set(request.jobId, controller);
      try {
        await waitForJobPageReady(document, { signal: controller.signal });
        if (!isCurrentJob()) throw new CancelledError();
        const job = await inspectJob(document, initialHost, request.jobId, undefined, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || !isCurrentJob()) throw new CancelledError();
        return responseOk(request.requestId, job);
      } catch (error) {
        if (!isCurrentJob()) return errorResponse(request.requestId, new CancelledError());
        if (error instanceof WaitTimeoutError) {
          return {
            requestId: request.requestId,
            ok: false,
            error: appError('UI_CHANGED', 'The job action area did not finish rendering'),
          };
        }
        if (error instanceof JobInspectionError && error.code === 'UI_CHANGED') {
          recordJobActionOutline(document);
        }
        return errorResponse(request.requestId, error);
      } finally {
        if (cancellations.get(request.jobId) === controller) cancellations.delete(request.jobId);
        reportSelectorHealth();
      }
    }

    case 'content.apply': {
      const isCurrentJob = () =>
        location.hostname === request.job.host && isJobPath(location.pathname, request.job.id);
      if (!isCurrentJob()) {
        return {
          requestId: request.requestId,
          ok: false,
          error: appError(
            'CANCELLED',
            'The job page changed. Return to the queued job before retrying.',
          ),
        };
      }
      let baselineTexts = confirmationBaseline(document);
      const controller = new AbortController();
      cancellations.set(request.job.id, controller);
      const submitState = { requestId: request.requestId, reviewRequired: false };
      submitControls.set(request.job.id, submitState);
      const control: ApplyControl = {
        needsReview: () => submitState.reviewRequired,
        authorizeSubmit: () => requestSubmitAuthorization(request.job.id, request.requestId),
        pageAssist: (query) => requestPageAssist(request.job.id, request.requestId, query),
        answerAssist: (questions) =>
          requestAnswerAssist(request.job.id, request.requestId, questions),
        answerWrite: (questions) =>
          requestAnswerWrite(request.job.id, request.requestId, questions),
        isCurrentJob,
        beforeSubmit: (texts) => {
          baselineTexts = texts;
        },
      };
      try {
        await sendContentEvent({
          type: 'content.event.progress',
          jobId: request.job.id,
          requestId: request.requestId,
          phase: 'filling',
          message:
            request.options.mode === 'dry_run' ? 'Checking application' : 'Filling application',
        });
        const result = await applyToJob(
          document,
          request.job,
          request.options,
          controller.signal,
          control,
        );
        const finalResult: ApplyResult =
          controller.signal.aborted &&
          result.outcome !== 'applied' &&
          result.outcome !== 'verifying' &&
          isApplicationModalOpen(document)
            ? {
                jobId: request.job.id,
                outcome: 'ready_for_review',
                confirmationText: 'Automation stopped. Review and submit in the Handshook tab.',
              }
            : result.outcome === 'applied'
              ? {
                  ...result,
                  confirmationText: result.confirmationText ?? detectConfirmation(document).text,
                }
              : result;
        // The response carries the result to the engine. Do not also emit a
        // result event here: the background would count the same application twice.
        if (
          finalResult.outcome === 'ready_for_review' ||
          finalResult.outcome === 'manual_submit_required' ||
          finalResult.outcome === 'needs_input' ||
          finalResult.outcome === 'verifying'
        ) {
          watchReviewConfirmation(request.job.id, request.requestId, baselineTexts);
        }
        return responseOk(request.requestId, finalResult);
      } catch (error) {
        if (controller.signal.aborted) {
          // Cancellation during filling must keep the opened form available
          // for manual review. A post-click cancellation is handled by the
          // adapter as `verifying`, never as a safe-to-retry cancellation.
          if (isApplicationModalOpen(document)) {
            watchReviewConfirmation(request.job.id, request.requestId, baselineTexts);
            return responseOk(request.requestId, {
              jobId: request.job.id,
              outcome: 'ready_for_review',
              confirmationText: 'Automation stopped. Review and submit in the Handshook tab.',
            } satisfies ApplyResult);
          }
          return {
            requestId: request.requestId,
            ok: false,
            error: appError('CANCELLED', 'Application cancelled', { retryable: false }),
          };
        }
        return errorResponse(request.requestId, error);
      } finally {
        cancellations.delete(request.job.id);
        submitControls.delete(request.job.id);
        reportSelectorHealth();
      }
    }

    case 'content.cancel': {
      const control = submitControls.get(request.jobId);
      if (control) control.reviewRequired = true;
      cancellations.get(request.jobId)?.abort();
      return responseOk(request.requestId, { cancelled: true });
    }

    case 'content.revokeSubmit': {
      const control = submitControls.get(request.jobId);
      if (control?.requestId === request.applyRequestId) control.reviewRequired = true;
      return responseOk(request.requestId, { revoked: true });
    }

    case 'content.verifySubmission': {
      if (request.host !== location.hostname || !isJobPath(location.pathname, request.jobId)) {
        return {
          requestId: request.requestId,
          ok: false,
          error: appError(
            'CANCELLED',
            'The job page changed. Open this job to verify its application.',
          ),
        };
      }
      const applied = detectConfirmation(document).applied || detectAlreadyApplied(document);
      return responseOk(request.requestId, {
        applied,
        status: applied ? 'applied' : 'verifying',
        jobId: request.jobId,
        host: location.hostname,
      });
    }

    default:
      return {
        requestId: (request as { requestId: string }).requestId,
        ok: false,
        error: appError('UNSUPPORTED_MESSAGE', 'Unknown content request'),
      };
  }
}

export function registerContentRouter(): void {
  registerContentCommand('content.revokeSubmit', revokeSubmitRequestSchema, handle);
  registerContentBridge(handle);
  watchRoute((change) => {
    if (change.page === 'login') {
      void sendContentEvent({
        type: 'content.event.session',
        status: 'logged_out',
        host: location.hostname,
      });
    }
  });
}
