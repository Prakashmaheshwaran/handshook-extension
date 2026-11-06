import { z } from 'zod';
import {
  EXTERNAL_DISMISSED,
  isExternalJob,
  isInternalApplication,
} from '@/core/util/application-policy';
import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  appError,
  contentEventSchema,
  isRecord,
  isAllowedHandshakeHost,
  parseUiRequest,
  validateProtocolEnvelope,
  type Answer,
  type Broadcast,
  type ContentEvent,
  type MessageResponse,
  type NeedsRequest,
  type QueueItem,
  type QueuePayload,
  type QuestionDescriptor,
  type OnboardingState,
  type UiRequest,
  type DocumentType,
  type EngineState,
  type AiStatusPayload,
} from '@/core/contracts';
import { answerFromQuestion } from '@/core/answers/answerDraft';
import {
  DOCUMENT_TYPES,
  configuredDocuments,
  documentChoiceError,
  documentSelectionForJob,
  findDocumentForType,
  idForType,
} from '@/core/documents/selection';
import { buildDiagnosticsBundle } from '@/core/diagnostics/export';
import {
  clearSelectorHealth,
  listSelectorHealth,
  recordSelectorHealthEntries,
} from '@/core/diagnostics/selectorHealth';
import { clearEvents, listEvents } from '@/core/logging/eventStore';
import { log, logEvent, makeEvent } from '@/core/logging/logger';
import { getReviewAppliedEvent, settleReviewResult } from '@/background/review-results';
import { engine } from '@/core/orchestrator/engine';
import {
  getJob,
  getQueueItem,
  getQueueSummary,
  isImmutableStatus,
  listJobs,
  listQueue,
  pruneQueue,
  updateQueueItem,
} from '@/core/orchestrator/queue';
import { runnerTabs as tabs } from '@/core/orchestrator/tabs';
import {
  listAnswers,
  listJobAnswers,
  saveAnswer,
  deleteAnswer,
  saveJobAnswerOverride,
  syncBankAnswerToJobOverrides,
} from '@/core/storage/answers';
import {
  getMeta,
  getTodayCount,
  pruneLocalData,
  resetAllLocalData,
  setMeta,
} from '@/core/storage/db';
import {
  clearAiKey,
  dismissAiMigrationNotice,
  hasAiMigrationNotice,
  loadAiKeys,
  loadOnboarding,
  loadSettings,
  restrictLocalStorageAccess,
  saveAiKey,
  saveOnboarding,
  saveEngineState,
  saveSettings,
  updateSettings,
} from '@/core/storage/settings';
import {
  MAX_IMPORT_BYTES,
  applyLegacyImport,
  exportApplicationsCsv,
  exportBackupJson,
  parseLegacyFile,
} from '@/core/migration';
import { testAiProvider, openRouterStatusMessage, clearOpenRouterStatus } from '@/background/ai';
import { hasOpenRouterHostPermission } from '@/ai/permissions';
import { loadOpenRouterKeyInfo, loadOpenRouterModels } from '@/ai/providers/openrouter';
import { toAppError } from '@/ai/types';
import { getSubmissionsForJob, updateSubmission } from '@/core/storage/submissions';
import { extensionVersion } from '@/core/version';
import { submitAuthorizationRequestSchema } from '@/core/contracts/submitAuthorization';
import { pageAssistRequestSchema, type PageAssistRequest } from '@/core/contracts/pageAssist';
import { runPageAssist } from '@/background/page-assist';
import { runAnswerAssist } from '@/background/answer-assist';
import { runAnswerWrite } from '@/background/answer-write';
import { answerWriteRequestSchema, type AnswerWriteRequest } from '@/core/contracts/answerWrite';
import {
  answeredLabels,
  dismissInboxQuestion,
  listInboxQuestions,
} from '@/core/storage/questionInbox';
import { normalizeText } from '@/handshake/text';
import { answerAssistRequestSchema, type AnswerAssistRequest } from '@/core/contracts/answerAssist';

/**
 * Chrome clears `storage.session` when the browser exits but keeps it across
 * service-worker restarts. That makes it the reliable signal for "this is a new
 * browser session, so any persisted running/scanning state lost its timers".
 */
const SESSION_STARTED_KEY = 'handshook.session.started';
const pingSchema = z.object({ type: z.literal('ping') }).strict();

async function aiStatusPayload(): Promise<AiStatusPayload> {
  const settings = await loadSettings();
  const keys = await loadAiKeys();
  const granted = await hasOpenRouterHostPermission();
  const message =
    openRouterStatusMessage() ??
    (!keys.openRouterApiKey
      ? 'Add an OpenRouter API key in AI settings to use cloud matching.'
      : !settings.ai.openRouter.model
        ? 'Choose an OpenRouter model in AI settings.'
        : !granted
          ? 'OpenRouter permission is not granted. Allow it from AI settings.'
          : !keys.openRouterApiKey.startsWith('sk-or-')
            ? 'OpenRouter keys usually start with sk-or-. Test this key to check it.'
            : undefined);
  return {
    enabled: settings.ai.enabled,
    provider: settings.ai.provider,
    openRouterConfigured: Boolean(keys.openRouterApiKey),
    openRouterMessage: message,
    openRouterPermission: granted ? 'granted' : 'not_granted',
    geminiReplacedNotice: await hasAiMigrationNotice(),
  };
}

interface SessionArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function sessionArea(): SessionArea | null {
  const storage = (browser as unknown as { storage?: { session?: SessionArea } }).storage;
  return storage?.session ?? null;
}

async function recoverInterruptedRun(): Promise<void> {
  const state = await engine.load();
  if (state.status !== 'running' && state.status !== 'scanning') return;
  await engine.pause('browser_restarted');
  state.message = 'Browser restarted. Resume when ready.';
  await saveEngineState(state);
  broadcast({ type: 'state.changed', state });
}

/**
 * Pause a run that did not survive a browser restart. Runs once per browser
 * session so a service-worker restart mid-run (for example an alarm wake) does
 * not pause a healthy run.
 */
async function recoverAfterBrowserStart(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    const stored = await area.get(SESSION_STARTED_KEY);
    if (stored[SESSION_STARTED_KEY]) {
      await engine.recoverScheduledRun();
      return;
    }
    await area.set({ [SESSION_STARTED_KEY]: Date.now() });
  } catch {
    return;
  }
  await recoverInterruptedRun();
}

export function broadcast(message: Broadcast): void {
  void browser.runtime
    .sendMessage({ ...message, protocolVersion: PROTOCOL_VERSION })
    .catch(() => undefined);
}

function ok<T>(requestId: string, data: T): MessageResponse<T> {
  return { requestId, ok: true, data };
}

function fail<T = never>(
  requestId: string,
  error: ReturnType<typeof appError>,
): MessageResponse<T> {
  return { requestId, ok: false, error };
}

/**
 * Defense in depth for Retry/Apply-now: the queue row can be retryable while the
 * submission journal already proves an application or an uncertain in-flight
 * submit. Never send a second application from a replay action.
 */
async function replaySubmissionGuard(jobId: string): Promise<ReturnType<typeof appError> | null> {
  const attempts = await getSubmissionsForJob(jobId);
  if (attempts.some((attempt) => attempt.status === 'applied')) {
    await updateQueueItem(jobId, { status: 'applied', lastError: undefined });
    await setMeta(`needs:${jobId}`, null);
    await broadcastQueue();
    return appError('INVALID_INPUT', 'This job already has a recorded application.');
  }
  if (attempts.some((attempt) => ['started', 'submitted', 'ambiguous'].includes(attempt.status))) {
    await updateQueueItem(jobId, {
      status: 'needs_input',
      lastError: appError('UNKNOWN', 'A previous submission needs reconciliation'),
    });
    await setMeta(`needs:${jobId}`, {
      questions: [],
      missingDocumentTypes: [],
      reason: 'review',
    });
    await broadcastQueue();
    return appError(
      'INVALID_INPUT',
      'A previous submission needs verification before this job can run again.',
    );
  }
  return null;
}

async function broadcastQueue(): Promise<void> {
  broadcast({ type: 'queue.changed', summary: await getQueueSummary(await loadSettings()) });
}

async function buildNeeds(items: QueueItem[]): Promise<NeedsRequest[]> {
  const jobs = new Map((await listJobs(500)).map((job) => [job.id, job]));
  const needs: NeedsRequest[] = [];
  for (const item of items) {
    const uiChanged = item.status === 'blocked' && item.lastError?.code === 'UI_CHANGED';
    if (!['needs_input', 'verifying', 'ready_for_review'].includes(item.status) && !uiChanged)
      continue;
    const job = jobs.get(item.jobId);
    if (!job || isExternalJob(job, item)) continue;
    const stored = await getMeta<{
      questions?: QuestionDescriptor[];
      missingDocumentTypes?: DocumentType[];
      reason?: NeedsRequest['reason'];
      message?: string;
    }>(`needs:${item.jobId}`);
    const reason: NeedsRequest['reason'] = uiChanged
      ? 'ui_changed'
      : (stored?.reason ??
        (item.status === 'ready_for_review'
          ? 'review'
          : (item.missingDocumentTypes?.length ?? 0) > 0
            ? 'documents'
            : 'questions'));
    const message =
      reason === 'review' && item.status !== 'ready_for_review'
        ? 'This application may already have been submitted. Check My Jobs on Handshake before taking any action. If confirmation cannot be recovered, skip this job here to continue; do not submit it again.'
        : (stored?.message ?? (reason === 'documents' ? item.lastError?.message : undefined));
    needs.push({
      jobId: item.jobId,
      jobTitle: job.title,
      employer: job.employer,
      questions: uiChanged ? [] : (stored?.questions ?? []),
      missingDocumentTypes: uiChanged
        ? []
        : (stored?.missingDocumentTypes ?? item.missingDocumentTypes ?? []),
      reason,
      documentSelection: item.documentSelection,
      ...(message ? { message } : {}),
      createdAt: item.updatedAt,
    });
  }
  return needs;
}

export function isUiRequest(value: unknown): value is UiRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; requestId?: unknown };
  return (
    typeof candidate.type === 'string' &&
    candidate.type.startsWith('ui.') &&
    typeof candidate.requestId === 'string'
  );
}

export function isContentEvent(value: unknown): value is ContentEvent {
  return contentEventSchema.safeParse(value).success;
}

type SessionStatus = 'logged_in' | 'logged_out' | 'unknown';

interface SessionProbe {
  status: SessionStatus;
  host: string;
  /** Why the page could not be read; only set when the probe failed. */
  detail?: string;
}

/** The content script waits up to 12 s for evidence, so give it headroom. */
const SESSION_CONTENT_TIMEOUT_MS = 15_000;

interface SessionCheckResult {
  status: SessionStatus;
  host: string;
  checkedAt: number;
  checkedIn: 'runner';
  detail?: string;
}

/** Ask the already-loaded runner page; never creates or navigates a tab. */
async function askRunnerSession(): Promise<SessionProbe> {
  const response = await tabs.send<unknown>(
    { type: 'content.detectSession', requestId: `session-${crypto.randomUUID()}` },
    SESSION_CONTENT_TIMEOUT_MS,
  );
  if (!response.ok) {
    return { status: 'unknown', host: '', detail: response.error.message };
  }
  const data = isRecord(response.data) ? response.data : {};
  const status =
    data.status === 'logged_in' || data.status === 'logged_out' ? data.status : 'unknown';
  return {
    status,
    host: typeof data.host === 'string' ? data.host : '',
  };
}

/**
 * Read the session from the extension-owned runner tab. The loaded page is
 * trusted first; only an `unknown` or `logged_out` answer (both inconclusive on
 * a stale page) triggers a fresh load of Handshake home. A tab or content
 * script failure is reported as `unknown`, never as "signed out".
 */
async function refreshSession(): Promise<SessionCheckResult> {
  await ensureRunnerReadAvailable();
  const settings = await loadSettings();
  const homeUrl = `https://${settings.host}/`;

  let probe: SessionProbe;
  try {
    probe = await tabs.withForeground(async (existingTabId) => {
      if (existingTabId !== null) {
        const loaded = await askRunnerSession();
        if (loaded.status === 'logged_in') return loaded;
        // The page may predate the current session: reload before concluding.
        const fresh = await loadAndProbe(homeUrl);
        if (!fresh.detail && loaded.detail) return { ...fresh, detail: loaded.detail };
        return fresh;
      }
      return loadAndProbe(homeUrl);
    });
  } catch (error) {
    probe = {
      status: 'unknown',
      host: '',
      detail:
        error instanceof Error ? error.message : 'The Handshook runner tab could not be opened.',
    };
  }

  const detected = probe.host.trim().toLowerCase();
  const allowedHost = isAllowedHandshakeHost(detected);
  // Persist the host the runner actually reached (US or UK) so links and
  // subsequent runs follow it. Only allowed Handshake apexes are accepted.
  if (allowedHost && detected !== settings.host) {
    await updateSettings({ host: detected });
  }
  broadcast({ type: 'state.changed', state: await engine.load() });
  return {
    status: probe.status,
    host: allowedHost ? detected : settings.host,
    checkedAt: Date.now(),
    checkedIn: 'runner',
    ...(probe.detail ? { detail: probe.detail } : {}),
  };
}

async function loadAndProbe(homeUrl: string): Promise<SessionProbe> {
  await tabs.ensure(homeUrl, true, { fresh: true });
  return askRunnerSession();
}

async function ensureRunnerReadAvailable(allowVerification = false): Promise<void> {
  const state = await engine.load();
  const openForms = await listQueue({
    status: allowVerification ? ['ready_for_review'] : ['ready_for_review', 'verifying'],
    limit: 1,
  });
  if (
    ['running', 'scanning'].includes(state.status) ||
    engine.isRunnerBusy() ||
    openForms.length > 0
  ) {
    throw new Error('Stop the run and finish any pending review before refreshing the runner.');
  }
  await tabs.allowRecreate();
}

/** A running Autopilot run picks requeued jobs up itself; the runner is left alone. */
async function runIsActive(): Promise<boolean> {
  return ['running', 'scanning'].includes((await engine.load()).status);
}

/**
 * A saved answer can unblock jobs already waiting in Needs You: when every
 * question a waiting job asked now has a saved answer, the job goes back in the
 * queue for the current or next run instead of waiting for a per-job click.
 */
async function releaseAnsweredJobs(): Promise<number> {
  const waiting = await listQueue({ status: ['needs_input'] });
  if (waiting.length === 0) return 0;
  const answered = answeredLabels(await listAnswers());
  let released = 0;
  for (const item of waiting) {
    const stored = await getMeta<{
      questions?: QuestionDescriptor[];
      missingDocumentTypes?: DocumentType[];
      reason?: NeedsRequest['reason'];
    }>(`needs:${item.jobId}`);
    const questions = stored?.questions ?? [];
    if (stored?.reason !== 'questions' || questions.length === 0) continue;
    if ((stored.missingDocumentTypes?.length ?? 0) > 0) continue;
    if (!questions.every((question) => answered.has(normalizeText(question.label)))) continue;
    if (await replaySubmissionGuard(item.jobId)) continue;
    await setMeta(`needs:${item.jobId}`, null);
    await updateQueueItem(item.jobId, {
      status: 'queued',
      lastError: undefined,
      pendingQuestionIds: [],
      missingDocumentTypes: [],
      nextAttemptAt: undefined,
    });
    released += 1;
  }
  if (released > 0) await broadcastQueue();
  return released;
}

interface SavedAnswer {
  item?: QueueItem;
  error?: ReturnType<typeof appError>;
}

async function saveJobAnswer(
  jobId: string,
  questionId: string,
  value: Answer['value'],
  remember: boolean,
  stillCurrent: () => boolean,
): Promise<SavedAnswer> {
  const stored = await getMeta<{
    questions?: QuestionDescriptor[];
    missingDocumentTypes?: DocumentType[];
    reason?: NeedsRequest['reason'];
  }>(`needs:${jobId}`);
  const question = stored?.questions?.find((entry) => entry.id === questionId);
  if (!question) {
    return { error: appError('INVALID_INPUT', 'That question is no longer pending.') };
  }
  // During an Autopilot run the job just goes back in the queue; otherwise the
  // runner must be free before the job is resumed.
  const active = await runIsActive();
  if (!active) await ensureRunnerReadAvailable();
  const replayBlock = await replaySubmissionGuard(jobId);
  if (replayBlock) return { error: replayBlock };
  const settings = await loadSettings();
  // The stored question supplies label/type/options/category, and sensitivity
  // comes from the shared heuristic. A Needs You edit is approval to fill this
  // job, not permission to undo an existing per-answer autopilot opt-out.
  const [bankAnswers, jobAnswers] = await Promise.all([listAnswers(), listJobAnswers(jobId)]);
  // A saved answer with the same wording is the same answer: update it rather
  // than add a second copy that would tie with it on every later form.
  const wording = normalizeText(question.label);
  const sameWording = bankAnswers.find((answer) =>
    [answer.label, ...answer.aliases].some((label) => normalizeText(label) === wording),
  );
  const previous = [...bankAnswers, ...jobAnswers]
    .filter((answer) => answer.id === questionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const draft = answerFromQuestion(question, value, {
    allowSensitiveAutoSubmit: settings.safety.allowSensitiveAutoSubmit,
    autoSubmitAllowed: previous?.autoSubmitAllowed,
  });
  if (!draft.ok) return { error: draft.error };

  // Always keep a per-job override: the user explicitly supplied this answer
  // for this question, so it is approved to fill even when the global auto-fill
  // opt-ins are off. `remember` additionally stores it in the reusable bank.
  await saveJobAnswerOverride(jobId, draft.value);
  if (remember) {
    const remembered =
      sameWording && sameWording.id !== draft.value.id
        ? {
            ...draft.value,
            id: sameWording.id,
            label: sameWording.label,
            aliases: sameWording.aliases,
            category: sameWording.category ?? draft.value.category,
            // Remembering a new value never undoes that answer's own opt-out.
            autoSubmitAllowed: sameWording.autoSubmitAllowed,
          }
        : draft.value;
    const saved = await saveAnswer(remembered);
    await syncBankAnswerToJobOverrides(saved.id, saved);
  }

  const remainingQuestions = (stored?.questions ?? []).filter((entry) => entry.id !== questionId);
  const missingDocumentTypes = stored?.missingDocumentTypes ?? [];
  const done = remainingQuestions.length === 0 && missingDocumentTypes.length === 0;
  if (!stillCurrent()) return { error: appError('CANCELLED', 'Recovery was cancelled.') };
  if (done) {
    await setMeta(`needs:${jobId}`, null);
  } else {
    await setMeta(`needs:${jobId}`, {
      ...stored,
      questions: remainingQuestions,
      missingDocumentTypes,
    });
  }

  const item = (await listQueue()).find((entry) => entry.jobId === jobId);
  if (!item) return { item: undefined };
  if (!done) {
    // More input is still pending: do not requeue or resume yet.
    const updated = await updateQueueItem(jobId, {
      pendingQuestionIds: remainingQuestions.map((entry) => entry.id),
      missingDocumentTypes,
    });
    await broadcastQueue();
    return { item: updated };
  }
  const updated = await updateQueueItem(jobId, {
    status: 'queued',
    lastError: undefined,
    pendingQuestionIds: [],
    missingDocumentTypes: [],
    nextAttemptAt: undefined,
  });
  await broadcastQueue();
  if (!stillCurrent()) return { error: appError('CANCELLED', 'Recovery was cancelled.') };
  if (!active) await engine.resume();
  if (remember) await releaseAnsweredJobs();
  return { item: updated };
}

const RUNNER_UI_ACTIONS: ReadonlySet<UiRequest['type']> = new Set([
  'ui.engine.start',
  'ui.engine.resume',
  'ui.queue.retry',
  'ui.queue.applyNow',
  'ui.job.answer',
  'ui.needs.documentsResolved',
  'ui.queue.documents',
  'ui.session.check',
]);
let runnerUiOperation: Promise<unknown> = Promise.resolve();
let recoveryGeneration = 0;

/** Exported for regression tests; the background registers it via `registerBackground`. */
export function handleUi(request: UiRequest): Promise<MessageResponse<unknown>> {
  if (['ui.engine.stop', 'ui.engine.pause', 'ui.queue.skip'].includes(request.type)) {
    recoveryGeneration += 1;
  }
  if (!RUNNER_UI_ACTIONS.has(request.type)) return handleUiRequest(request);
  // Keep the safety check, page read, and requeue in one recovery action. A
  // second click must recheck availability after the first resumes the engine.
  // Stop/Pause/Skip remain immediate so they can interrupt an active operation.
  const generation = recoveryGeneration;
  const stillCurrent = (): boolean => generation === recoveryGeneration;
  const operation = runnerUiOperation.then(() =>
    stillCurrent()
      ? handleUiRequest(request, stillCurrent)
      : fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.')),
  );
  runnerUiOperation = operation.catch(() => undefined);
  return operation;
}

async function handleUiRequest(
  request: UiRequest,
  stillCurrent: () => boolean = () => true,
): Promise<MessageResponse<unknown>> {
  switch (request.type) {
    case 'ui.engine.start':
      await ensureRunnerReadAvailable();
      if (!stillCurrent())
        return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
      return ok(request.requestId, await engine.start(request.mode));
    case 'ui.engine.pause':
      return ok(request.requestId, await engine.pause(request.reason ?? 'user'));
    case 'ui.engine.resume':
      // Resume may reconcile an uncertain send by reading its existing page.
      // The engine keeps it out of any fresh navigation/apply until settled.
      await ensureRunnerReadAvailable(true);
      if (!stillCurrent())
        return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
      return ok(request.requestId, await engine.resume());
    case 'ui.engine.stop':
      return ok(request.requestId, await engine.stop());
    case 'ui.engine.getState':
      return ok(request.requestId, await engine.load());

    case 'ui.queue.list': {
      const settings = await loadSettings();
      const items = await listQueue({
        status: request.status,
        limit: request.limit,
        offset: request.offset,
        includeExternal:
          settings.search.collectExternalJobs && request.status?.includes('external') === true,
      });
      const jobs = (await Promise.all(items.map((item) => getJob(item.jobId)))).filter(
        (job): job is NonNullable<typeof job> => job !== undefined,
      );
      const summary = await getQueueSummary(settings);
      const needs = await buildNeeds(items);
      const payload: QueuePayload = { items, jobs, summary, needs };
      return ok(request.requestId, payload);
    }
    case 'ui.queue.retry': {
      const item = await getQueueItem(request.jobId);
      if (!item) {
        return fail(request.requestId, appError('INVALID_INPUT', 'That job is not in the queue.'));
      }
      if (isExternalJob(await getJob(request.jobId), item)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'External links cannot be automated.'),
        );
      }
      // Only the user's explicit selector-recovery retry can reopen a blocked
      // row. All other final outcomes stay immutable.
      const uiChanged = item.status === 'blocked' && item.lastError?.code === 'UI_CHANGED';
      if (isImmutableStatus(item.status) && !uiChanged) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is final and cannot be retried.'),
        );
      }
      const replayBlock = await replaySubmissionGuard(request.jobId);
      if (replayBlock) return fail(request.requestId, replayBlock);
      if (uiChanged) {
        const attempts = await getSubmissionsForJob(request.jobId);
        const latest = attempts.sort((a, b) => b.startedAt - a.startedAt)[0];
        // No journal is safe only when inspection failed before dispatch. A
        // recorded attempt must positively describe a settled non-submission.
        if (
          (item.submissionAttemptId && !attempts.some((a) => a.id === item.submissionAttemptId)) ||
          (latest &&
            (latest.status !== 'failed' ||
              latest.finishedAt === undefined ||
              latest.capCountedAt !== undefined ||
              Boolean(latest.confirmationText?.trim())))
        ) {
          return fail(
            request.requestId,
            appError('INVALID_INPUT', 'The previous attempt is not a settled non-submission.'),
          );
        }
      }
      await ensureRunnerReadAvailable();
      await updateQueueItem(request.jobId, {
        status: 'queued',
        lastError: undefined,
        skipReason: undefined,
        nextAttemptAt: undefined,
      });
      if (!stillCurrent())
        return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
      await engine.resume();
      return ok(request.requestId, { jobId: request.jobId, status: 'queued' });
    }
    case 'ui.queue.skip': {
      const item = await getQueueItem(request.jobId);
      if (!item) {
        return fail(request.requestId, appError('INVALID_INPUT', 'That job is not in the queue.'));
      }
      if (
        isExternalJob(await getJob(request.jobId), item) &&
        (await loadSettings()).search.collectExternalJobs
      ) {
        // Dismiss only changes visibility; preserve the terminal row and replay barriers.
        await updateQueueItem(request.jobId, { skipReason: EXTERNAL_DISMISSED });
        await broadcastQueue();
        return ok(request.requestId, { jobId: request.jobId, status: 'external' });
      }
      if (isImmutableStatus(item.status)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is final and cannot be skipped.'),
        );
      }
      await updateQueueItem(request.jobId, {
        status: 'skipped',
        lastError: undefined,
        skipReason: request.reason,
      });
      // P1-3: stop an in-flight apply before Submit and let the engine move on.
      // The row is already skipped, so the late apply result cannot overwrite it.
      await engine.cancelActiveJob(request.jobId);
      // Skip ends queue processing, but proves nothing about an in-flight or
      // manually submitted form. Preserve the journal's replay barrier.
      const attempts = await getSubmissionsForJob(request.jobId);
      for (const attempt of attempts) {
        if (!['started', 'submitted', 'ambiguous'].includes(attempt.status)) continue;
        await updateSubmission(attempt.id, {
          status: 'ambiguous',
          finishedAt: Date.now(),
          reconciledAt: Date.now(),
          reconciliationNote: 'Skipped by user; submission still unverified, replay blocked',
        });
      }
      await broadcastQueue();
      return ok(request.requestId, { jobId: request.jobId, status: 'skipped' });
    }
    case 'ui.queue.applyNow': {
      const item = await getQueueItem(request.jobId);
      if (!item) {
        return fail(request.requestId, appError('INVALID_INPUT', 'That job is not in the queue.'));
      }
      if (isExternalJob(await getJob(request.jobId), item)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'External links cannot be automated.'),
        );
      }
      if (isImmutableStatus(item.status)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is final and cannot be applied again.'),
        );
      }
      const replayBlock = await replaySubmissionGuard(request.jobId);
      if (replayBlock) return fail(request.requestId, replayBlock);
      await ensureRunnerReadAvailable();
      // Apply-now jumps the queue; otherwise the next scan's priority ordering
      // could leave it waiting behind higher-fit jobs.
      await updateQueueItem(request.jobId, {
        status: 'queued',
        priority: 999,
        nextAttemptAt: undefined,
      });
      if (!stillCurrent())
        return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
      await engine.resume();
      return ok(request.requestId, { jobId: request.jobId, status: 'queued' });
    }

    case 'ui.events.list': {
      const events = await listEvents(Number.MAX_SAFE_INTEGER);
      const visible = await Promise.all(
        events.map(async (event) => {
          if (event.type === 'job.external') return null;
          if (!event.jobId) return event.type === 'job.applied' ? null : event;
          const [job, item] = await Promise.all([getJob(event.jobId), getQueueItem(event.jobId)]);
          if (isExternalJob(job, item)) return null;
          if (event.type === 'job.applied' && !isInternalApplication(job?.applyType)) return null;
          return event;
        }),
      );
      return ok(
        request.requestId,
        visible.filter((event) => event !== null).slice(0, request.limit ?? 200),
      );
    }
    case 'ui.needs.list':
      return ok(request.requestId, await buildNeeds(await listQueue()));
    case 'ui.answer.list':
      return ok(request.requestId, await listAnswers());
    case 'ui.answer.save': {
      const saved = await saveAnswer(request.answer);
      await syncBankAnswerToJobOverrides(saved.id, saved);
      await releaseAnsweredJobs();
      return ok(request.requestId, saved);
    }
    case 'ui.questions.list':
      return ok(request.requestId, await listInboxQuestions());
    case 'ui.questions.dismiss':
      await dismissInboxQuestion(request.key);
      return ok(request.requestId, { dismissed: true });
    case 'ui.answer.delete':
      await deleteAnswer(request.answerId);
      await syncBankAnswerToJobOverrides(request.answerId, null);
      return ok(request.requestId, { deleted: true });
    case 'ui.job.answer': {
      const target = await getQueueItem(request.jobId);
      if (!target) {
        return fail(request.requestId, appError('INVALID_INPUT', 'That job is not in the queue.'));
      }
      if (isImmutableStatus(target.status)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is final and no longer accepts answers.'),
        );
      }
      const saved = await saveJobAnswer(
        request.jobId,
        request.questionId,
        request.value,
        request.remember,
        stillCurrent,
      );
      if (saved.error) return fail(request.requestId, saved.error);
      return ok(request.requestId, {
        jobId: request.jobId,
        jobStatus: saved.item?.status ?? 'queued',
        remainingQuestionIds: saved.item?.pendingQuestionIds ?? [],
      });
    }

    case 'ui.queue.documents':
    case 'ui.needs.documentsResolved': {
      // During an Autopilot run the job just goes back in the queue, as for answers.
      const active = await runIsActive();
      if (!active) await ensureRunnerReadAvailable();
      const item = (await listQueue()).find((entry) => entry.jobId === request.jobId);
      if (!item) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is no longer in the queue.'),
        );
      }
      if (isImmutableStatus(item.status)) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is final and cannot be requeued.'),
        );
      }
      if (
        active &&
        request.type === 'ui.needs.documentsResolved' &&
        item.status !== 'needs_input'
      ) {
        return fail(
          request.requestId,
          appError('INVALID_INPUT', 'That job is already back in the queue.'),
        );
      }
      const replayBlock = await replaySubmissionGuard(request.jobId);
      if (replayBlock) return fail(request.requestId, replayBlock);
      const stored = await getMeta<{
        questions?: QuestionDescriptor[];
        missingDocumentTypes?: DocumentType[];
        reason?: NeedsRequest['reason'];
      }>(`needs:${request.jobId}`);
      const required = stored?.missingDocumentTypes ?? item.missingDocumentTypes ?? [];
      const settings = await loadSettings();
      const selection = documentSelectionForJob(settings.documents, {
        ...item.documentSelection,
        ...request.documents,
      });
      const available = configuredDocuments(settings.documents, selection);
      const toValidate = new Set([
        ...(request.type === 'ui.needs.documentsResolved' ? required : []),
        ...DOCUMENT_TYPES.filter((type) => Boolean(idForType(selection, type))),
      ]);
      const stillMissing = [...toValidate].filter(
        (type) => !findDocumentForType(selection, type, available),
      );
      if (stillMissing.length > 0) {
        if (request.type === 'ui.queue.documents') {
          return fail(
            request.requestId,
            appError(
              'MISSING_DOCUMENT',
              stillMissing
                .map((type) => documentChoiceError(selection, type, available))
                .join('; '),
            ),
          );
        }
        await setMeta(`needs:${request.jobId}`, {
          ...(stored ?? { questions: [] }),
          missingDocumentTypes: stillMissing,
          reason: 'documents',
        });
        await updateQueueItem(request.jobId, { missingDocumentTypes: stillMissing });
        broadcast({
          type: 'needs.you',
          jobId: request.jobId,
          questions: stored?.questions ?? [],
          missingDocumentTypes: stillMissing,
        });
        await broadcastQueue();
        return fail(
          request.requestId,
          appError(
            'MISSING_DOCUMENT',
            stillMissing.map((type) => documentChoiceError(selection, type, available)).join('; ') +
              '. Choose a document for this job or add its link or ID in Settings, then try again.',
            { details: { missingDocumentTypes: stillMissing } },
          ),
        );
      }
      if (!stillCurrent())
        return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
      if (request.documents) await updateQueueItem(request.jobId, { documentSelection: selection });
      if (request.type === 'ui.queue.documents') {
        await broadcastQueue();
        return ok(request.requestId, { jobId: request.jobId, status: item.status });
      }
      const remainingQuestions = stored?.questions ?? [];
      if (remainingQuestions.length === 0) {
        await setMeta(`needs:${request.jobId}`, null);
        const updated = await updateQueueItem(request.jobId, {
          status: 'queued',
          lastError: undefined,
          missingDocumentTypes: [],
          pendingQuestionIds: [],
          nextAttemptAt: undefined,
        });
        await broadcastQueue();
        if (!stillCurrent())
          return fail(request.requestId, appError('CANCELLED', 'Recovery was cancelled.'));
        if (!active) await engine.resume();
        return ok(request.requestId, {
          jobId: request.jobId,
          status: updated?.status ?? 'queued',
          missingDocumentTypes: [],
          remainingQuestionIds: [],
        });
      }
      await setMeta(`needs:${request.jobId}`, {
        ...stored,
        questions: remainingQuestions,
        missingDocumentTypes: [],
      });
      const updated = await updateQueueItem(request.jobId, {
        missingDocumentTypes: [],
        pendingQuestionIds: remainingQuestions.map((entry) => entry.id),
      });
      await broadcastQueue();
      return ok(request.requestId, {
        jobId: request.jobId,
        status: updated?.status ?? item.status,
        missingDocumentTypes: [],
        remainingQuestionIds: remainingQuestions.map((entry) => entry.id),
      });
    }

    case 'ui.migration.import': {
      if (request.content.length > MAX_IMPORT_BYTES) {
        return fail(
          request.requestId,
          appError(
            'INVALID_INPUT',
            `That file is larger than ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
          ),
        );
      }
      const plan = parseLegacyFile(request.kind, request.content);
      if (!plan.ok) return fail(request.requestId, plan.error);
      const summary = await applyLegacyImport(plan.value);
      if (!summary.ok) return fail(request.requestId, summary.error);
      broadcast({ type: 'state.changed', state: await engine.load() });
      broadcast({ type: 'queue.changed', summary: await getQueueSummary(await loadSettings()) });
      return ok(request.requestId, summary.value);
    }
    case 'ui.migration.export': {
      const payload =
        request.format === 'csv' ? await exportApplicationsCsv() : await exportBackupJson();
      return ok(request.requestId, payload);
    }

    case 'ui.settings.get':
      return ok(request.requestId, await loadSettings());
    case 'ui.settings.update': {
      const settings = await updateSettings(request.patch);
      broadcast({ type: 'state.changed', state: await engine.load() });
      return ok(request.requestId, settings);
    }
    case 'ui.onboarding.get':
      return ok(request.requestId, await loadOnboarding());
    case 'ui.onboarding.update': {
      const current = await loadOnboarding();
      const next: OnboardingState = { ...current, ...request.patch, version: 1 };
      await saveOnboarding(next);
      return ok(request.requestId, next);
    }

    case 'ui.session.check':
      return ok(request.requestId, await refreshSession());
    case 'ui.runner.focus': {
      // The engine owns the runner tab; a missing tab is reported honestly so
      // the panel can fall back to Needs instead of claiming it opened one.
      const focused = await engine.focusRunner();
      return ok(request.requestId, { focused });
    }

    case 'ui.ai.status':
      return ok(request.requestId, await aiStatusPayload());
    case 'ui.ai.setKey':
      await saveAiKey(request.apiKey);
      clearOpenRouterStatus();
      return ok(request.requestId, {
        saved: true,
        ...(!request.apiKey.trim().startsWith('sk-or-')
          ? { warning: 'OpenRouter keys usually start with sk-or-. Test this key to check it.' }
          : {}),
      });
    case 'ui.ai.clearKey':
      await clearAiKey();
      clearOpenRouterStatus();
      return ok(request.requestId, { cleared: true });
    case 'ui.ai.test':
      return ok(
        request.requestId,
        await testAiProvider(request.provider, {
          keys: await loadAiKeys(),
          settings: (await loadSettings()).ai.openRouter,
        }),
      );
    case 'ui.ai.openrouter.models': {
      try {
        const keys = await loadAiKeys();
        return ok(
          request.requestId,
          await loadOpenRouterModels({ apiKey: keys.openRouterApiKey }, request.refresh),
        );
      } catch (error) {
        return fail(request.requestId, toAppError(error));
      }
    }
    case 'ui.ai.openrouter.keyInfo': {
      try {
        const keys = await loadAiKeys();
        return ok(
          request.requestId,
          await loadOpenRouterKeyInfo({ apiKey: keys.openRouterApiKey }),
        );
      } catch (error) {
        return fail(request.requestId, toAppError(error));
      }
    }
    case 'ui.ai.dismissMigrationNotice':
      await dismissAiMigrationNotice();
      return ok(request.requestId, { dismissed: true });

    case 'ui.diagnostics.export': {
      const bundle = await buildDiagnosticsBundle(extensionVersion());
      return ok(request.requestId, {
        filename: `handshook-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        json: JSON.stringify(bundle, null, 2),
      });
    }
    case 'ui.diagnostics.get': {
      const settings = await loadSettings();
      const [summary, events, answers, documents, selectors] = await Promise.all([
        getQueueSummary(settings),
        listEvents(200),
        listAnswers(),
        Promise.resolve(configuredDocuments(settings.documents)),
        listSelectorHealth(),
      ]);
      let storage = { ok: true, name: 'IndexedDB', detail: 'Local browser storage' };
      try {
        await getMeta('__diagnostics_probe__');
      } catch (error) {
        storage = {
          ok: false,
          name: 'IndexedDB',
          detail: error instanceof Error ? error.message : 'Storage is unavailable',
        };
      }
      return ok(request.requestId, {
        generatedAt: Date.now(),
        version: extensionVersion(),
        protocolVersion: 1,
        host: settings.host,
        mode: settings.mode,
        storage,
        selectors,
        recentErrors: events.filter((event) => event.level === 'error'),
        queue: summary,
        counts: { events: events.length, answers: answers.length, documents: documents.length },
      });
    }
    case 'ui.diagnostics.clear': {
      const before = await listEvents(5000);
      await clearEvents();
      await clearSelectorHealth();
      return ok(request.requestId, { cleared: before.length });
    }

    case 'ui.data.reset': {
      if (!request.confirm)
        return fail(request.requestId, appError('INVALID_INPUT', 'Reset not confirmed'));
      // Stop the engine and clear its alarm before the database disappears, so
      // a tick cannot run against a half-reset store. Then drop the AI key and
      // reset persisted settings/onboarding (they live outside IndexedDB).
      await engine.stop();
      await browser.alarms?.clear('handshook.tick').catch(() => undefined);
      await clearAiKey();
      await resetAllLocalData();
      await saveSettings(DEFAULT_SETTINGS);
      await saveOnboarding({ version: 1, step: 'welcome', sessionStatus: 'unknown' });
      const state = await engine.resetForDataClear();
      broadcast({ type: 'state.changed', state });
      broadcast({ type: 'queue.changed', summary: await getQueueSummary(DEFAULT_SETTINGS) });
      return ok(request.requestId, { reset: true });
    }
    default:
      return fail(
        (request as { requestId: string }).requestId,
        appError(
          'UNSUPPORTED_MESSAGE',
          `Unsupported request: ${(request as { type: string }).type}`,
        ),
      );
  }
}

/** Exported for regression tests; the background registers it via `registerBackground`. */
export async function handleContentEvent(event: ContentEvent): Promise<boolean> {
  switch (event.type) {
    case 'content.event.log': {
      if (event.event.type === 'job.external') return true;
      if (event.event.type === 'job.applied' && !event.event.jobId) return true;
      if (event.event.jobId) {
        const job = await getJob(event.event.jobId);
        if (isExternalJob(job, await getQueueItem(event.event.jobId))) return true;
        if (event.event.type === 'job.applied' && !isInternalApplication(job?.applyType))
          return true;
      }
      const safe = makeEvent(event.event.level, event.event.type, event.event.message, {
        jobId: event.event.jobId,
        data: event.event.data,
      });
      await logEvent(safe);
      broadcast({ type: 'event.appended', event: safe });
      return true;
    }
    case 'content.event.progress': {
      if (event.jobId && isExternalJob(await getJob(event.jobId), await getQueueItem(event.jobId)))
        return true;
      const state = await engine.load();
      state.currentPhase = event.phase;
      state.message = event.message;
      if (event.jobId) state.currentJobId = event.jobId;
      state.updatedAt = Date.now();
      await saveEngineState(state);
      broadcast({ type: 'state.changed', state });
      return true;
    }
    case 'content.event.selectorHealth':
      // The content adapter sends one entry or a whole snapshot; both persist.
      await recordSelectorHealthEntries(event.health);
      return true;
    case 'content.event.session': {
      const detected = event.host?.trim().toLowerCase() ?? '';
      if (event.status === 'logged_in' && isAllowedHandshakeHost(detected)) {
        const settings = await loadSettings();
        if (detected !== settings.host) await updateSettings({ host: detected });
      }
      broadcast({
        type: 'toast',
        level: event.status === 'logged_in' ? 'info' : 'warn',
        message:
          event.status === 'logged_in'
            ? `Connected to ${event.host}`
            : 'Your Handshake session needs attention.',
      });
      return true;
    }
    case 'content.event.result': {
      if (event.result.outcome !== 'applied') return false;
      const state = await engine.load();
      const settled = await settleReviewResult(event, state.runId);
      if (!settled.ok) {
        await logRejection(settled.error.code);
        return false;
      }
      if (!settled.value) return true;
      const appliedEvent = await getReviewAppliedEvent(event.requestId);
      if (appliedEvent) broadcast({ type: 'event.appended', event: appliedEvent });
      const job = await getJob(event.jobId);
      state.todayCount = await getTodayCount();
      state.currentJobId = undefined;
      state.currentPhase = undefined;
      state.status = 'paused';
      state.pauseReason = 'user';
      state.message = `Applied: ${job?.title ?? event.jobId}`;
      await saveEngineState(state);
      broadcast({ type: 'state.changed', state });
      broadcast({ type: 'queue.changed', summary: await getQueueSummary(await loadSettings()) });
      return true;
    }
    case 'content.event.discovered':
      return true;
  }
}

function extensionRuntimeId(): string | undefined {
  try {
    const runtime = (browser as unknown as { runtime?: { id?: string } } | undefined)?.runtime;
    return runtime?.id;
  } catch {
    return undefined;
  }
}

/**
 * Missing runtime/sender identity fails closed, including during extension reloads.
 */
export function isTrustedExtensionSender(sender: unknown): boolean {
  if (!sender || typeof sender !== 'object') return false;
  const id = extensionRuntimeId();
  return !!id && (sender as { id?: unknown }).id === id;
}

/**
 * UI requests may come from the side panel page. When that page is opened as a
 * normal tab (Playwright, manual debugging) it carries `sender.tab`, so accept
 * extension-page tabs but reject content-script tabs on Handshake.
 */
export function isPanelSender(sender: unknown): boolean {
  if (!isTrustedExtensionSender(sender)) return false;
  const tab = (sender as { tab?: { url?: unknown } }).tab;
  if (!tab) return true;
  const url = typeof tab.url === 'string' ? tab.url : '';
  if (!url.startsWith('chrome-extension://')) return false;
  const id = extensionRuntimeId();
  return id ? url.startsWith(`chrome-extension://${id}/`) : true;
}

async function logRejection(code: string): Promise<void> {
  await log('warn', 'messaging.rejected', `Message rejected: ${code}`);
}

/** Validate the actual top-level sending document, not merely the extension ID. */
export function contentSenderUrl(sender: unknown): URL | null {
  if (
    !isTrustedExtensionSender(sender) ||
    !isRecord(sender) ||
    !isRecord(sender.tab) ||
    typeof sender.tab.id !== 'number' ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  )
    return null;
  try {
    const tabUrl = new URL(typeof sender.tab.url === 'string' ? sender.tab.url : '');
    const url = new URL(typeof sender.url === 'string' ? sender.url : tabUrl.href);
    if (
      [url, tabUrl].some(
        (candidate) =>
          candidate.protocol !== 'https:' ||
          candidate.username ||
          candidate.password ||
          !isAllowedHandshakeHost(candidate.hostname),
      )
    )
      return null;
    return url.origin === tabUrl.origin ? url : null;
  } catch {
    return null;
  }
}

/** Shared ownership gate for apply events and additional content RPCs. */
async function loadForSenderValidation(): Promise<EngineState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      engine.load(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5_000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Restore runner ownership before inspecting its tab id after an MV3 wake. */
export async function isActiveApplySender(
  sender: unknown,
  jobId: string,
  requestId: string,
  allowReviewResult = false,
): Promise<boolean> {
  const url = contentSenderUrl(sender);
  if (!url) return false;
  const state = await loadForSenderValidation();
  if (
    !state ||
    !isRecord(sender) ||
    !isRecord(sender.tab) ||
    sender.tab.id !== engine.getRunnerTabId()
  )
    return false;
  // The content observer retries until the engine has durably completed its
  // handoff. Otherwise an early manual result races that handoff's journal and
  // Needs You writes, resurrecting a form which was already submitted.
  if (allowReviewResult && engine.isRunnerBusy()) return false;
  if (
    !/^\/(?:stu\/)?jobs\/[^/]+\/?$/.test(url.pathname) ||
    !url.pathname.split('/').includes(jobId)
  )
    return false;
  const [item, attempts] = await Promise.all([getQueueItem(jobId), getSubmissionsForJob(jobId)]);
  const attempt = attempts.find((candidate) => candidate.id === requestId);
  if (
    !attempt ||
    !item ||
    item.submissionAttemptId !== requestId ||
    attempt.host !== url.hostname ||
    !state.runId ||
    attempt.runId !== state.runId ||
    (state.currentJobId && state.currentJobId !== jobId)
  )
    return false;
  if (
    allowReviewResult &&
    [
      'opening',
      'filling',
      'submitting',
      'ready_for_review',
      'needs_input',
      'verifying',
      'skipped',
      'applied',
    ].includes(item.status)
  )
    return true;
  return (
    state.currentJobId === jobId &&
    state.status === 'running' &&
    ['opening', 'filling', 'submitting'].includes(item.status)
  );
}

/**
 * AI page assist is bound to the exact in-flight apply attempt. A request from
 * any other tab, job, run or attempt returns "none" without touching the model.
 */
export async function pageAssistRpc(
  request: PageAssistRequest,
  sender: unknown,
): Promise<MessageResponse<unknown>> {
  const active = await isActiveApplySender(sender, request.jobId, request.applyRequestId);
  if (!active) return ok(request.requestId, { index: null, source: 'none' });
  const host = contentSenderUrl(sender)?.hostname ?? '';
  try {
    const data = await runPageAssist(request, host, {
      emit: (event) => broadcast({ type: 'event.appended', event }),
    });
    return ok(request.requestId, data);
  } catch {
    return ok(request.requestId, { index: null, source: 'none' });
  }
}

/**
 * AI answer assist is bound to the exact in-flight apply attempt. A request from
 * any other tab, job, run or attempt maps nothing without touching the model.
 */
export async function answerAssistRpc(
  request: AnswerAssistRequest,
  sender: unknown,
): Promise<MessageResponse<unknown>> {
  const none = () => ({
    matches: request.questions.map((question) => ({
      questionId: question.id,
      answerId: null,
      source: 'none' as const,
      confidence: 0,
    })),
  });
  const active = await isActiveApplySender(sender, request.jobId, request.applyRequestId);
  if (!active) return ok(request.requestId, none());
  try {
    const matches = await runAnswerAssist(request, {
      emit: (event) => broadcast({ type: 'event.appended', event }),
    });
    return ok(request.requestId, { matches });
  } catch {
    return ok(request.requestId, none());
  }
}

/** AI answer writing is bound to the exact in-flight apply attempt, like answer assist. */
export async function answerWriteRpc(
  request: AnswerWriteRequest,
  sender: unknown,
): Promise<MessageResponse<unknown>> {
  const active = await isActiveApplySender(sender, request.jobId, request.applyRequestId);
  if (!active) return ok(request.requestId, { answers: [] });
  try {
    const answers = await runAnswerWrite(request, {
      emit: (event) => broadcast({ type: 'event.appended', event }),
    });
    return ok(request.requestId, { answers });
  } catch {
    return ok(request.requestId, { answers: [] });
  }
}

export async function receiveContentEvent(message: unknown, sender: unknown): Promise<boolean> {
  const url = contentSenderUrl(sender);
  if (!url) {
    await logRejection('FORBIDDEN');
    return false;
  }
  const protocol = validateProtocolEnvelope(message);
  if (!protocol.ok) {
    await logRejection(protocol.error.code);
    // Fail visibly without reloading a page containing an unfinished application.
    if (
      (await loadForSenderValidation()) &&
      isRecord(sender) &&
      isRecord(sender.tab) &&
      sender.tab.id === engine.getRunnerTabId()
    ) {
      await engine.pause('protocol_mismatch');
    }
    broadcast({ type: 'toast', level: 'error', message: protocol.error.message });
    return false;
  }
  const parsed = contentEventSchema.safeParse(message);
  if (!parsed.success) {
    await logRejection('INVALID_INPUT');
    return false;
  }
  const event = parsed.data;
  const jobId =
    event.type === 'content.event.log'
      ? event.event.jobId
      : 'jobId' in event
        ? event.jobId
        : undefined;
  if (
    jobId &&
    (!('requestId' in event) ||
      !event.requestId ||
      !(await isActiveApplySender(
        sender,
        jobId,
        event.requestId,
        event.type === 'content.event.result',
      )))
  ) {
    await logRejection('FORBIDDEN');
    return false;
  }
  if (event.type === 'content.event.progress' && !jobId) {
    const state = await loadForSenderValidation();
    if (
      !state ||
      state.status !== 'scanning' ||
      !isRecord(sender) ||
      !isRecord(sender.tab) ||
      sender.tab.id !== engine.getRunnerTabId()
    ) {
      await logRejection('FORBIDDEN');
      return false;
    }
  }
  if (event.type === 'content.event.session' && event.host !== url.hostname) {
    await logRejection('FORBIDDEN');
    return false;
  }
  return handleContentEvent(event);
}

type ContentRpc = (message: unknown, sender: unknown) => Promise<MessageResponse<unknown>>;
const contentRpcs = new Map<string, ContentRpc>();

/** Schema registration is mandatory; the RPC supplies its narrower active-job gate. */
export function registerContentRpc<T extends { requestId: string }>(
  type: string,
  schema: z.ZodType<T>,
  handler: (request: T, sender: unknown) => Promise<MessageResponse<unknown>>,
): void {
  contentRpcs.set(type, async (message, sender) => {
    const parsed = schema.safeParse(message);
    if (!parsed.success) {
      await logRejection('INVALID_INPUT');
      return fail('unknown', appError('INVALID_INPUT', 'Invalid content request.'));
    }
    return handler(parsed.data, sender);
  });
}

async function pruneLocalState(): Promise<void> {
  try {
    await pruneLocalData();
    await pruneQueue(90);
  } catch {
    // Pruning is best-effort and must never block a run.
  }
}

export function registerBackground(): void {
  engine.setBroadcast(broadcast);
  // Register listeners synchronously for MV3, but finish storage isolation
  // before recovery or any UI work can load a saved credential.
  const storageReady = restrictLocalStorageAccess();
  const startupRecovery = storageReady.then(recoverAfterBrowserStart);
  // Keep rejection on the recovery promise so alarms cannot bypass isolation.
  void startupRecovery.catch(() => engine.reportUnexpectedFailure());
  registerContentRpc(
    'engine.authorizeSubmit',
    submitAuthorizationRequestSchema,
    async (request, sender) => {
      const active = await isActiveApplySender(sender, request.jobId, request.applyRequestId);
      const tabId =
        isRecord(sender) && isRecord(sender.tab) && typeof sender.tab.id === 'number'
          ? sender.tab.id
          : undefined;
      const authorized =
        active && (await engine.authorizeSubmit(request.jobId, request.applyRequestId, tabId));
      return ok(request.requestId, { authorized });
    },
  );
  registerContentRpc('engine.pageAssist', pageAssistRequestSchema, pageAssistRpc);
  registerContentRpc('engine.answerAssist', answerAssistRequestSchema, answerAssistRpc);
  registerContentRpc('engine.answerWrite', answerWriteRequestSchema, answerWriteRpc);
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender)) {
      void logRejection('FORBIDDEN');
      return false;
    }
    const respond = (response: MessageResponse<unknown>) =>
      sendResponse({ ...response, protocolVersion: PROTOCOL_VERSION });
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ping') {
      if (!pingSchema.safeParse(message).success) {
        void logRejection('INVALID_INPUT');
        return false;
      }
      sendResponse({ ok: true, data: { pong: true } });
      return false;
    }
    if (
      isRecord(message) &&
      typeof message.type === 'string' &&
      message.type.startsWith('content.event.')
    ) {
      void receiveContentEvent(message, sender)
        .then((accepted) => sendResponse({ protocolVersion: PROTOCOL_VERSION, ok: accepted }))
        .catch(() => {
          void logRejection('UNKNOWN');
          sendResponse({ protocolVersion: PROTOCOL_VERSION, ok: false });
        });
      return true;
    }
    const rpc =
      isRecord(message) && typeof message.type === 'string'
        ? contentRpcs.get(message.type)
        : undefined;
    if (rpc) {
      if (!contentSenderUrl(sender)) {
        void logRejection('FORBIDDEN');
        return false;
      }
      const protocol = validateProtocolEnvelope(message);
      if (!protocol.ok) {
        respond(
          fail(
            isRecord(message) && typeof message.requestId === 'string'
              ? message.requestId
              : 'unknown',
            protocol.error,
          ),
        );
        return false;
      }
      void rpc(message, sender)
        .then(respond)
        .catch(() => respond(fail('unknown', appError('UNKNOWN', 'Content request failed.'))));
      return true;
    }
    if (isRecord(message) && typeof message.type === 'string' && message.type.startsWith('ui.')) {
      if (!isPanelSender(sender)) {
        respond(
          fail(
            typeof message.requestId === 'string' ? message.requestId : 'unknown',
            appError('FORBIDDEN', 'This action must come from the Handshook panel.'),
          ),
        );
        return false;
      }
      const protocol = validateProtocolEnvelope(message);
      if (!protocol.ok) {
        void logRejection(protocol.error.code);
        respond(
          fail(
            typeof message.requestId === 'string' ? message.requestId : 'unknown',
            protocol.error,
          ),
        );
        return false;
      }
      const parsed = parseUiRequest(message);
      if (!parsed.ok) {
        void logRejection(parsed.error.code);
        respond(
          fail(typeof message.requestId === 'string' ? message.requestId : 'unknown', parsed.error),
        );
        return false;
      }
      storageReady
        .then(() => handleUi(parsed.value))
        .then(respond)
        .catch((error: unknown) =>
          respond(
            fail(
              parsed.value.requestId,
              appError('UNKNOWN', error instanceof Error ? error.message : 'Request failed', {
                retryable: true,
                cause: error,
              }),
            ),
          ),
        );
      return true;
    }
    return false;
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    void startupRecovery
      .then(() => engine.onAlarm(alarm.name))
      .catch(() => engine.reportUnexpectedFailure());
    void pruneLocalState();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void engine.onRunnerRemoved(tabId).catch(() => engine.reportUnexpectedFailure());
  });

  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined);
    void pruneLocalState();
  });

  browser.runtime.onStartup.addListener(() => {
    void browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined);
    void pruneLocalState();
    void recoverInterruptedRun().catch(() => engine.reportUnexpectedFailure());
  });

  // Cover the case where Chrome restarts the worker without dispatching
  // `runtime.onStartup` (observed in headless Chromium).
  void startupRecovery;
}
