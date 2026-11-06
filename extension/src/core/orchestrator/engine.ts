import {
  DEFAULT_SETTINGS,
  LIMITS,
  type ApplyOptions,
  type ApplyOutcome,
  type ApplyResult,
  type Broadcast,
  type EngineState,
  type Job,
  type MessageResponse,
  type PauseReason,
  type QueueItem,
  type RunMode,
  type Settings,
  type SubmissionAttempt,
  appError,
  appErrorSchema,
  applyResultSchema,
  isRecord,
} from '@/core/contracts';
import { matchResume } from '@/ai/matcher';
import { hasPositiveSubmissionEvidence } from '@/core/contracts/submitAuthorization';
import { answerApprovalReason } from '@/core/answers/policy';
import { evaluateJob } from '@/core/filters';
import {
  aiResumeCandidates,
  configuredDocuments,
  documentSelectionForJob,
  findDocumentForType,
  findMissingDocumentTypes,
} from '@/core/documents/selection';
import { log } from '@/core/logging/logger';
import { evaluateAutopilot } from '@/core/orchestrator/guards';
import { createPacer, type Pacer } from '@/core/orchestrator/pacer';
import {
  enqueueJobs,
  getJob,
  getNextQueued,
  getNextQueueWakeAt,
  getQueueItem,
  getQueueSummary,
  isImmutableStatus,
  listQueue,
  putJob,
  updateQueueItem,
} from '@/core/orchestrator/queue';
import { RunnerTabClosedError, RunnerTabManager, runnerTabs } from '@/core/orchestrator/tabs';
import { PACING_SESSION_KEY, pacingSessionSchema, readSession, writeSession } from './session';
import { listAnswers, listJobAnswers } from '@/core/storage/answers';
import { recordInboxQuestions } from '@/core/storage/questionInbox';
import { getTodayCount, setMeta } from '@/core/storage/db';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';
import { settleReconciledSubmission } from '@/core/storage/submission-settlement';
import {
  createSubmission,
  countAttemptTowardCapOnce,
  deleteSubmission,
  getSubmissionsForJob,
  listUnresolvedSubmissions,
  updateSubmission,
} from '@/core/storage/submissions';
import {
  loadAiKeys,
  loadEngineState,
  loadSettings,
  saveEngineState,
} from '@/core/storage/settings';
import { realClock, type Clock } from '@/core/orchestrator/clock';
import { now } from '@/core/util/time';

export type BroadcastFn = (message: Broadcast) => void;

/**
 * Review-first is the default in every mode. Autopilot may submit only when the
 * user left the safety toggle off; review and dry-run always stop for a human.
 */
export function resolveReviewBeforeSubmit(mode: RunMode, safetyReview: boolean): boolean {
  return safetyReview || mode !== 'autopilot';
}

/** A resumed run can become stricter, never gain permission to submit. */
export function restrictRunMode(runMode: RunMode, settingsMode: RunMode): RunMode {
  if (runMode === 'dry_run' || settingsMode === 'dry_run') return 'dry_run';
  if (runMode === 'review' || settingsMode === 'review') return 'review';
  return 'autopilot';
}

/** A dispatched apply with a corrupt reply is uncertain, never safe to replay. */
function validateApplyResponse(
  value: unknown,
  requestId: string,
  jobId: string,
): MessageResponse<ApplyResult> {
  if (isRecord(value) && value.requestId === requestId) {
    if (value.ok === true) {
      const parsed = applyResultSchema.safeParse(value.data);
      if (parsed.success && parsed.data.jobId === jobId)
        return { requestId, ok: true, data: parsed.data };
    } else if (value.ok === false) {
      const parsed = appErrorSchema.safeParse(value.error);
      if (parsed.success && parsed.data.code !== 'PROTOCOL_MISMATCH')
        return { requestId, ok: false, error: parsed.data };
      if (parsed.success)
        return { requestId, ok: true, data: { jobId, outcome: 'verifying', error: parsed.data } };
    }
  }
  return {
    requestId,
    ok: false,
    error: appError(
      'TIMEOUT',
      'The application reply could not be validated. Check this job or My Jobs before retrying.',
    ),
  };
}

/**
 * Submission journal status for an apply outcome. `verifying`/review outcomes
 * are ambiguous on purpose: the form may already have been submitted, so the
 * job must never be retried without reconciliation.
 */
function submissionStatusForOutcome(outcome: ApplyOutcome): SubmissionAttempt['status'] {
  if (outcome === 'applied') return 'applied';
  if (
    outcome === 'ready_for_review' ||
    outcome === 'verifying' ||
    outcome === 'manual_submit_required'
  ) {
    return 'ambiguous';
  }
  return 'failed';
}

interface EngineOptions {
  tabs?: RunnerTabManager;
  broadcast?: BroadcastFn;
  clock?: Clock;
}

/** Largest delay a browser timer accepts; longer waits rely on the alarm. */
const MAX_PRECISE_TIMER_MS = 2_147_483_647;

/**
 * True for Chrome's message-channel teardown errors, which mean the extension
 * or the tab restarted while a request was in flight.
 */
export function isTransportDrop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /message channel closed|message port closed|Receiving end does not exist|Extension context invalidated/i.test(
    message,
  );
}

export class Engine {
  private settings!: Settings;
  private state!: EngineState;
  private pacer!: Pacer;
  private tabs: RunnerTabManager;
  private broadcastFn: BroadcastFn;
  private clock: Clock;
  private ticking = false;
  private tickQueued = false;
  /** Applications submitted by this worker; drives session batch breaks. */
  private applicationsThisSession = 0;
  private batchBreakUntil = 0;
  private scanProgress:
    { url: string; pages: number; jobs: Job[]; externalJobs?: Job[] } | undefined;
  private hydration: Promise<void> | null = null;
  private wake: Promise<void> | null = null;
  private recovered = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Invalidates asynchronous work (scan loops, in-flight applies) on every
   * pause/stop/reset. A stale continuation must never enqueue or submit.
   */
  private runToken = 0;
  /** The apply currently awaiting the content script, if any. */
  private activeApply: Promise<void> | null = null;
  private activeJobId: string | null = null;
  private activeDispatch: {
    jobId: string;
    requestId: string;
    token: number;
    controller: AbortController;
    autoSubmit: boolean;
    dispatched: boolean;
    settingsSnapshot: string;
    approvalSnapshot: string;
  } | null = null;
  private activeMatching: { jobId: string; controller: AbortController } | null = null;

  constructor(options: EngineOptions = {}) {
    this.tabs = options.tabs ?? runnerTabs;
    this.broadcastFn = options.broadcast ?? (() => {});
    this.clock = options.clock ?? realClock;
  }

  async load(): Promise<EngineState> {
    // Settings are re-read on every call so a settings update takes effect, but
    // engine state is only hydrated once per worker. Re-reading persisted state
    // on every UI poll would overwrite live fields mid-tick (for example the
    // lastError just set by a failure handler) with an older snapshot.
    this.settings = await loadSettings();
    this.pacer = createPacer(this.settings, this.clock);
    if (!this.state) {
      this.hydration ??= (async () => {
        this.state = await loadEngineState();
        const pacing = await readSession(PACING_SESSION_KEY, pacingSessionSchema);
        if (pacing?.runId === this.state.runId) {
          this.applicationsThisSession = pacing?.applications ?? 0;
          this.batchBreakUntil = pacing?.breakUntil ?? 0;
          this.scanProgress = pacing?.scan;
        }
        await this.tabs.restore?.();
      })();
    }
    await this.hydration;
    // Review always wins over a stale autopilot state: switching to Review while
    // a run is active must stop submissions immediately. Do not loosen the other
    // way here (a run started as dry_run/review keeps its explicit mode).
    this.state.mode = restrictRunMode(this.state.mode, this.settings.mode);
    const active = this.activeDispatch;
    if (
      active?.autoSubmit &&
      (JSON.stringify(this.settings) !== active.settingsSnapshot ||
        this.settings.mode !== 'autopilot' ||
        resolveReviewBeforeSubmit(this.state.mode, this.settings.safety.reviewBeforeSubmit))
    ) {
      // Latch revocation for this request, even if settings are loosened again.
      active.autoSubmit = false;
      if (active.dispatched) {
        await this.tabs.send(
          {
            type: 'content.revokeSubmit',
            requestId: crypto.randomUUID(),
            jobId: active.jobId,
            applyRequestId: active.requestId,
          },
          2_000,
        );
      }
    }
    this.state.dailyCap = this.settings.pacing.dailyCap;
    this.state.todayCount = await getTodayCount();
    return this.state;
  }

  getState(): EngineState {
    return this.state;
  }

  /** Detached callbacks must fail closed even when persistence itself fails. */
  reportUnexpectedFailure(): void {
    this.invalidateRun();
    this.activeDispatch?.controller.abort();
    this.activeMatching?.controller.abort();
    const message =
      'Handshook could not finish saving local state. Automation stopped. Reload the extension and check My Jobs before resuming.';
    if (this.state) {
      this.state.status = 'error';
      this.state.nextActionAt = undefined;
      this.state.lastError = appError('UNKNOWN', message);
      this.state.message = message;
      this.broadcastFn({ type: 'state.changed', state: { ...this.state } });
      void saveEngineState({ ...this.state }).catch(() => undefined);
    }
    this.broadcastFn({ type: 'toast', level: 'error', message });
    void this.cancelInFlight().catch(() => undefined);
  }

  private detach(work: Promise<unknown>): void {
    void work.catch(() => this.reportUnexpectedFailure());
  }

  getSettings(): Settings {
    return this.settings;
  }

  getRunnerTabId(): number | null {
    return this.tabs.id;
  }

  isRunnerBusy(): boolean {
    return this.ticking || this.activeApply !== null;
  }

  /** Reattached synchronously whenever the MV3 worker starts. */
  setBroadcast(broadcast: BroadcastFn): void {
    this.broadcastFn = broadcast;
  }

  /** Focuses the runner tab. Returns false when no extension-owned tab is open. */
  async focusRunner(): Promise<boolean> {
    return this.tabs.focus();
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = this.clock.now();
    await this.persistSession();
    await saveEngineState(this.state);
    this.broadcastFn({ type: 'state.changed', state: { ...this.state } });
  }

  private async persistSession(): Promise<void> {
    await writeSession(PACING_SESSION_KEY, {
      runId: this.state.runId,
      applications: this.applicationsThisSession,
      breakUntil: this.batchBreakUntil,
      scan: this.scanProgress,
    });
  }

  private async broadcastQueue(): Promise<void> {
    this.broadcastFn({
      type: 'queue.changed',
      summary: await getQueueSummary(this.settings),
    });
  }

  private async emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    type: string,
    message: string,
    jobId?: string,
  ): Promise<void> {
    const event = await log(level, type, message, { jobId });
    this.broadcastFn({ type: 'event.appended', event });
  }

  private searchUrl(): string {
    const searches = this.settings.search.savedSearches.filter((search) => search.enabled);
    const active = searches.find((search) => search.id === this.settings.search.activeSearchId);
    return active?.url ?? searches[0]?.url ?? `https://${this.settings.host}/job-search`;
  }

  /** True only while this exact run generation is still active. */
  private isRunActive(token: number): boolean {
    return (
      token === this.runToken &&
      (this.state.status === 'running' || this.state.status === 'scanning')
    );
  }

  /** H1: abort the content script's in-flight apply, if one exists. */
  private async cancelInFlight(): Promise<void> {
    this.activeDispatch?.controller.abort();
    this.activeMatching?.controller.abort();
    const jobId = this.activeJobId;
    if (!jobId) return;
    await this.tabs.cancel(jobId);
  }

  /** Last-moment grant: stale jobs, runs, tabs, settings and revocations deny. */
  async authorizeSubmit(
    jobId: string,
    applyRequestId: string,
    senderTabId: number | undefined,
  ): Promise<boolean> {
    await this.load();
    const active = this.activeDispatch;
    if (
      active?.autoSubmit &&
      active.jobId === jobId &&
      active.requestId === applyRequestId &&
      senderTabId === this.tabs.id
    ) {
      const approvals = await Promise.all([listAnswers(), listJobAnswers(jobId)]);
      const documents = configuredDocuments(
        this.settings.documents,
        (await getQueueItem(jobId))?.documentSelection,
      );
      if (JSON.stringify([...approvals, documents]) !== active.approvalSnapshot)
        active.autoSubmit = false;
    }
    return Boolean(
      active &&
      active === this.activeDispatch &&
      active.jobId === jobId &&
      active.requestId === applyRequestId &&
      active.dispatched &&
      active.autoSubmit &&
      !active.controller.signal.aborted &&
      this.isRunActive(active.token) &&
      senderTabId !== undefined &&
      senderTabId === this.tabs.id &&
      this.settings.mode === 'autopilot' &&
      !resolveReviewBeforeSubmit(this.state.mode, this.settings.safety.reviewBeforeSubmit) &&
      this.pacer.canApplyToday(this.state.todayCount),
    );
  }

  /** Waits briefly for the aborted apply to settle so stop/reset is truthful. */
  private async awaitActiveApply(timeoutMs = 5_000): Promise<void> {
    const active = this.activeApply;
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private invalidateRun(): void {
    this.runToken += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Cancel the content-side apply for one job if it is the active one. Used by
   * Skip so an in-flight application stops before Submit and the run can move on.
   */
  async cancelActiveJob(jobId: string): Promise<boolean> {
    if (this.activeJobId !== jobId && this.activeMatching?.jobId !== jobId) return false;
    await this.cancelInFlight();
    return true;
  }

  /** Schedule the next tick without changing a paused/stopped state. */
  private async continueRun(delayMs = this.pacer.inspectionDelayMs()): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'scanning') {
      await this.scheduleNext(delayMs);
    }
  }

  async start(mode?: RunMode): Promise<EngineState> {
    const commandToken = this.runToken;
    await this.load();
    if (commandToken !== this.runToken) return this.state;
    if (this.state.status === 'running' || this.state.status === 'scanning') return this.state;
    if (!this.settings.onboardingComplete) {
      throw new Error('Finish onboarding before starting.');
    }
    const runMode = mode ?? this.settings.mode;
    const startCheck = this.pacer.evaluateStart(this.state.todayCount);
    if (!startCheck.allowed) {
      // Nothing starts once the cap is used. Leave the run where it is (idle)
      // instead of parking it in Paused with a Resume that cannot do anything.
      this.state.message = startCheck.reason?.message;
      await this.persist();
      return this.state;
    }

    const blockedByReconcile = await this.reconcile();
    if (commandToken !== this.runToken) return this.state;
    if (blockedByReconcile) {
      await this.persist();
      return this.state;
    }

    this.invalidateRun();
    const startingToken = this.runToken;
    await this.tabs.allowRecreate?.();
    if (startingToken !== this.runToken) return this.state;
    this.state = {
      ...this.state,
      status: 'scanning',
      mode: runMode,
      host: this.settings.host,
      runId: `run-${Date.now()}`,
      startedAt: now(),
      pausedAt: undefined,
      pauseReason: undefined,
      currentJobId: undefined,
      currentPhase: 'scanning',
      scanComplete: false,
      nextActionAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      message: 'Scanning saved searches',
    };
    this.applicationsThisSession = 0;
    this.batchBreakUntil = 0;
    this.scanProgress = undefined;
    await this.persist();
    await this.broadcastQueue();
    this.detach(this.tick());
    return this.state;
  }

  async pause(reason: PauseReason = 'user'): Promise<EngineState> {
    // H1/H3: invalidate any scan loop or apply continuation, then abort the
    // content-side apply so a paused run cannot click Submit.
    this.invalidateRun();
    const token = this.runToken;
    if (!this.state) await this.load();
    if (token !== this.runToken) return this.state;
    this.state.status = 'paused';
    this.state.pausedAt = now();
    this.state.pauseReason = reason;
    this.state.nextActionAt = undefined;
    await browser.alarms?.clear('handshook.tick').catch(() => undefined);
    if (token !== this.runToken) return this.state;
    await this.cancelInFlight();
    if (token !== this.runToken) return this.state;
    await this.persist();
    return this.state;
  }

  async resume(): Promise<EngineState> {
    const commandToken = this.runToken;
    // Re-read settings so a mode/safety change made while paused applies to the
    // resumed run (for example switching Autopilot to Review).
    await this.load();
    if (commandToken !== this.runToken) return this.state;
    if (this.state.status === 'running') return this.state;
    // Resume re-checks unresolved submissions before touching the queue, so a
    // crash mid-submit is reconciled instead of retried (ARCHITECTURE.md §7).
    const blockedByReconcile = await this.reconcile();
    if (commandToken !== this.runToken) return this.state;
    if (blockedByReconcile) {
      await this.persist();
      return this.state;
    }
    this.invalidateRun();
    const resumingToken = this.runToken;
    await this.tabs.allowRecreate?.();
    if (resumingToken !== this.runToken) return this.state;
    // Apply-now/retry can resume an imported or freshly initialized queue that
    // never went through start(). The sender gate requires the engine and its
    // submission journal to share a durable run identity.
    this.state.runId ??= `run-${Date.now()}`;
    this.state.startedAt ??= now();
    this.state.status = 'running';
    this.state.mode = restrictRunMode(this.state.mode, this.settings.mode);
    this.state.pausedAt = undefined;
    this.state.pauseReason = undefined;
    this.state.message = 'Resuming';
    this.state.nextActionAt = undefined;
    await this.persist();
    this.detach(this.tick());
    return this.state;
  }

  async stop(): Promise<EngineState> {
    // H1/M13: cancel and await the in-flight apply before reporting stopped.
    this.invalidateRun();
    const token = this.runToken;
    if (!this.state) await this.load();
    if (token !== this.runToken) return this.state;
    await this.cancelInFlight();
    if (token !== this.runToken) return this.state;
    await this.awaitActiveApply();
    if (token !== this.runToken) return this.state;
    this.state.status = 'idle';
    this.state.currentJobId = undefined;
    this.state.currentPhase = undefined;
    this.state.nextActionAt = undefined;
    this.state.message = 'Stopped';
    await browser.alarms?.clear('handshook.tick').catch(() => undefined);
    await this.persist();
    await this.broadcastQueue();
    return this.state;
  }

  /**
   * Clears the in-memory + persisted engine state after the user resets all
   * local data. Without this, the previous mode/host/run ids would survive in
   * `chrome.storage.local` even though IndexedDB was deleted.
   */
  async resetForDataClear(): Promise<EngineState> {
    this.invalidateRun();
    await this.cancelInFlight();
    await this.awaitActiveApply();
    await browser.alarms?.clear('handshook.tick').catch(() => undefined);
    this.settings = await loadSettings();
    this.pacer = createPacer(this.settings, this.clock);
    this.applicationsThisSession = 0;
    this.batchBreakUntil = 0;
    this.state = {
      version: 1,
      status: 'idle',
      mode: DEFAULT_SETTINGS.mode,
      host: DEFAULT_SETTINGS.host,
      todayCount: 0,
      dailyCap: DEFAULT_SETTINGS.pacing.dailyCap,
      consecutiveFailures: 0,
      message: 'Local data cleared. Setup starts again.',
      updatedAt: now(),
    };
    await this.persist();
    return this.state;
  }

  async onAlarm(name: string): Promise<void> {
    if (name !== 'handshook.tick') return;
    await this.recoverScheduledRun();
  }

  /** Startup, alarm and precise timer all consume the same persisted intent. */
  async recoverScheduledRun(): Promise<void> {
    if (this.wake) return this.wake;
    this.wake = this.wakeScheduledRun();
    try {
      await this.wake;
    } finally {
      this.wake = null;
    }
  }

  private async wakeScheduledRun(): Promise<void> {
    await this.load();
    if (!this.isRunActive(this.runToken)) return;
    if (this.tabs.wasClosed) {
      await this.pauseForClosedRunner();
      return;
    }
    const at = Math.max(this.state.nextActionAt ?? 0, this.batchBreakUntil);
    if (at > this.clock.now()) {
      await this.armWake(at);
      return;
    }
    if (this.ticking) return;
    if (!this.recovered) {
      this.recovered = true;
      const token = this.runToken;
      // Automatic worker recovery has the same journal gate as Resume. Never
      // turn a suspension during submission into a fresh application attempt.
      const needsReview = await this.reconcile();
      if (token !== this.runToken) return;
      const forms = await listQueue({ status: ['ready_for_review', 'verifying'], limit: 1 });
      if (needsReview || forms.length > 0) {
        this.state.status = 'needs_user';
        this.state.nextActionAt = undefined;
        if (!needsReview)
          this.state.message = 'The runner has an application awaiting your review.';
        await this.persist();
        return;
      }
    }
    // Consuming before tick and checking its next intent makes a late alarm a
    // no-op (or re-arms the next delay), rather than a second application.
    this.state.nextActionAt = undefined;
    clearTimeout(this.timer);
    await browser.alarms?.clear('handshook.tick').catch(() => undefined);
    await this.tick();
  }

  private async armWake(at: number): Promise<void> {
    clearTimeout(this.timer);
    const delay = Math.max(0, at - this.clock.now());
    // Chrome's 30-second minimum is only the suspension safety net. The precise
    // in-memory timer runs for every wait, so short gaps are not padded to an
    // alarm tick; `nextActionAt` always retains the actual intended time.
    await browser.alarms?.create('handshook.tick', {
      when: Math.max(at, this.clock.now() + 30_000),
    });
    if (delay <= MAX_PRECISE_TIMER_MS) {
      this.timer = setTimeout(() => this.detach(this.recoverScheduledRun()), delay);
    }
  }

  private async scheduleNext(delayMs: number): Promise<void> {
    if (!this.isRunActive(this.runToken)) return;
    const at = Math.max(this.clock.now() + Math.max(500, delayMs), this.batchBreakUntil);
    this.state.nextActionAt = at;
    await this.persist();
    await this.armWake(at);
  }

  /**
   * The daily (or hard) cap ends today's run. It leaves the engine idle like
   * Stop, with no pending wake-up, so nothing keeps running or waits to resume.
   */
  private async finishAtCap(): Promise<void> {
    const { dailyCap, hardCap } = this.settings.pacing;
    const hardCapHit = hardCap < dailyCap && this.state.todayCount >= hardCap;
    const label = hardCapHit ? 'Hard cap' : 'Daily cap';
    const cap = hardCapHit ? hardCap : dailyCap;
    this.state.status = 'idle';
    this.state.pauseReason = undefined;
    this.state.pausedAt = undefined;
    this.state.nextActionAt = undefined;
    this.state.currentJobId = undefined;
    this.state.currentPhase = undefined;
    this.state.message = `${label} reached (${this.state.todayCount}/${cap}). Run finished; start again after local midnight.`;
    clearTimeout(this.timer);
    this.timer = undefined;
    await browser.alarms?.clear('handshook.tick').catch(() => undefined);
    await this.persist();
    await this.broadcastQueue();
    await this.emit('info', 'engine.cap_reached', this.state.message);
  }

  private async pauseForClosedRunner(): Promise<void> {
    this.state.message = 'The Handshook runner tab was closed. Resume to open a new runner.';
    this.state.currentJobId = undefined;
    this.state.currentPhase = undefined;
    await this.pause('tab_closed');
  }

  async onRunnerRemoved(tabId: number): Promise<void> {
    if (!(await this.tabs.onRemoved(tabId))) return;
    if (!this.state) await this.load();
    if (['running', 'scanning', 'needs_user'].includes(this.state.status)) {
      await this.pauseForClosedRunner();
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      // A user action (answer/resume) landed while the previous tick was still
      // finishing. Remember it so the run does not stall with no scheduled work.
      this.tickQueued = true;
      return;
    }
    if (!this.state) await this.load();
    if (this.state.status !== 'running' && this.state.status !== 'scanning') return;
    if (this.state.nextActionAt !== undefined && this.state.nextActionAt > this.clock.now()) return;
    if (this.batchBreakUntil > this.clock.now()) {
      await this.scheduleNext(this.batchBreakUntil - this.clock.now());
      return;
    }
    if (this.tabs.wasClosed) {
      await this.pauseForClosedRunner();
      return;
    }
    this.ticking = true;
    const token = this.runToken;
    try {
      // A user may still be editing a Review form, including after a worker
      // restart. No scan or retry may navigate/reload that shared runner.
      const openForms = await listQueue({ status: ['ready_for_review', 'verifying'], limit: 1 });
      if (!this.isRunActive(token)) return;
      if (openForms.length > 0) {
        this.state.status = 'needs_user';
        this.state.message = 'Finish the pending review before continuing.';
        await this.persist();
        return;
      }
      // Reaching the cap ends the run like Stop does. Checked before a rescan so
      // a finished Autopilot day does not reload the saved searches first.
      if (!this.pacer.canApplyToday(this.state.todayCount)) {
        await this.finishAtCap();
        return;
      }
      if (!this.state.scanComplete) {
        await this.scan(token);
        return;
      }
      const next = await getNextQueued(this.clock.now(), this.settings.pacing.maxAttemptsPerJob);
      if (!next) {
        const dueAt = await getNextQueueWakeAt(
          this.clock.now(),
          this.settings.pacing.maxAttemptsPerJob,
        );
        if (dueAt !== undefined) {
          this.state.currentJobId = undefined;
          this.state.currentPhase = undefined;
          this.state.message = 'Waiting for the next eligible job';
          await this.scheduleNext(dueAt - this.clock.now());
          await this.broadcastQueue();
          return;
        }
        // Nothing eligible is left in this pass. Autopilot keeps looking:
        // resetting the scan makes the next tick read the saved searches again
        // for newly posted jobs instead of going idle after the first batch.
        // Review and Dry run are deliberate one-pass modes and still finish.
        // The user's Stop and the daily cap still end the run.
        if (this.state.mode !== 'autopilot') {
          this.state.status = 'idle';
          this.state.nextActionAt = undefined;
          this.state.currentJobId = undefined;
          this.state.currentPhase = undefined;
          this.state.message = 'No more jobs in the queue';
          await this.persist();
          await this.broadcastQueue();
          return;
        }
        this.state.scanComplete = false;
        this.state.currentJobId = undefined;
        this.state.currentPhase = undefined;
        this.state.message = 'Queue empty; scanning for new jobs';
        await this.persist();
        await this.scheduleNext(this.quietRescanDelayMs());
        await this.broadcastQueue();
        return;
      }
      if (!this.isRunActive(token)) return;
      // Track the apply so pause/stop/reset can await and cancel it.
      const apply = this.apply(next, token);
      this.activeApply = apply;
      try {
        await apply;
      } finally {
        this.activeApply = null;
      }
    } catch (error) {
      if (!this.isRunActive(token)) return;
      if (error instanceof RunnerTabClosedError) {
        await this.pauseForClosedRunner();
        return;
      }
      // Reloading the extension (or the tab) tears down an in-flight message
      // channel: "A listener indicated an asynchronous response by returning
      // true, but the message channel closed". That is a restart, not a defect,
      // so keep the run alive and retry after the usual paced delay instead of
      // parking the whole run in an Error state.
      if (isTransportDrop(error)) {
        this.state.message = 'The extension was reloaded mid-run; retrying shortly.';
        this.state.lastError = appError('UNKNOWN', this.state.message, { retryable: true });
        this.state.currentJobId = undefined;
        this.state.currentPhase = undefined;
        await this.persist();
        await this.emit('warn', 'engine.transport_reset', this.state.message);
        await this.scheduleNext(this.quietRescanDelayMs());
        return;
      }
      this.state.status = 'error';
      this.state.lastError = appError(
        'UNKNOWN',
        error instanceof Error ? error.message : 'Engine tick failed',
        { retryable: true, cause: error },
      );
      this.state.message = this.state.lastError.message;
      await this.persist();
      await this.emit('error', 'engine.tick_failed', this.state.lastError.message);
    } finally {
      this.ticking = false;
      if (this.tickQueued) {
        this.tickQueued = false;
        if (this.state.status === 'running' || this.state.status === 'scanning') {
          this.detach(this.tick());
        }
      }
    }
  }

  async scan(token = this.runToken): Promise<void> {
    // H3: a pause/stop can land between the tick check and this call.
    if (!this.isRunActive(token)) return;
    this.state.status = 'scanning';
    this.state.currentPhase = 'scanning';
    this.state.message = 'Scanning saved searches';
    await this.persist();
    let url = this.scanProgress?.url ?? this.searchUrl();
    const allJobs: Job[] = [...(this.scanProgress?.jobs ?? [])];
    const externalJobs = new Map<string, Job>(
      (this.scanProgress?.externalJobs ?? []).map((job) => [job.id, job]),
    );
    let pages = this.scanProgress?.pages ?? 0;
    let stoppedReason = 'max-pages';
    await this.emit('info', 'scan.started', `Scanning ${url}`);
    while (
      pages < this.settings.search.maxPagesPerRun &&
      allJobs.length < this.settings.search.maxJobsPerRun
    ) {
      if (!this.isRunActive(token)) return;
      await this.tabs.ensure(url, true, { fresh: true });
      if (!this.isRunActive(token)) return;
      const response = await this.tabs.send<{
        jobs: Job[];
        nextPageUrl: string | null;
        empty: boolean;
        diagnostics?: { probes: number; firstCount: number; scrolled: boolean };
      }>({
        type: 'content.scan',
        requestId: `scan-${Date.now()}-${pages}`,
        options: {
          searchUrl: url,
          maxPages: this.settings.search.maxPagesPerRun,
          maxJobs: this.settings.search.maxJobsPerRun,
          pageDelayMs: this.pacer.inspectionDelayMs(),
        },
      });
      if (!this.isRunActive(token)) return;
      if (!response.ok) {
        this.state.status = response.error.code === 'AUTH_REQUIRED' ? 'paused' : 'error';
        this.state.pauseReason =
          response.error.code === 'AUTH_REQUIRED' ? 'auth_required' : undefined;
        this.state.lastError = response.error;
        this.state.message = response.error.message;
        await this.persist();
        return;
      }
      const page = response.data;
      const internalJobs: Job[] = [];
      for (const job of page.jobs) {
        const [stored, item] = await Promise.all([getJob(job.id), getQueueItem(job.id)]);
        const knownExternal = externalJobs.get(job.id);
        if (knownExternal || isExternalJob(job, item) || isExternalJob(stored, item)) {
          externalJobs.set(job.id, {
            ...job,
            applyType: 'external',
            externalUrl: job.externalUrl ?? knownExternal?.externalUrl ?? stored?.externalUrl,
          });
        } else {
          internalJobs.push(job);
        }
      }
      allJobs.push(...internalJobs);
      pages += 1;
      const diag = page.diagnostics;
      await this.emit(
        'info',
        'scan.page',
        `Scanned page ${pages}: ${internalJobs.length} jobs${diag ? ` (first read ${diag.firstCount}, ${diag.probes} probes, scrolled: ${diag.scrolled ? 'yes' : 'no'})` : ''}`,
      );
      if (!this.isRunActive(token)) return;
      if (page.empty || !page.nextPageUrl) {
        stoppedReason = page.empty ? 'empty' : 'last-page';
        break;
      }
      if (allJobs.length >= this.settings.search.maxJobsPerRun) {
        stoppedReason = 'max-jobs';
        break;
      }
      url = page.nextPageUrl;
      if (pages < this.settings.search.maxPagesPerRun) {
        // Checkpoint the cursor before yielding. HX-04 persists nextActionAt
        // and arms both an alarm and a precision timer for this wait.
        this.scanProgress = { url, pages, jobs: allJobs, externalJobs: [...externalJobs.values()] };
        await this.scheduleNext(this.pacer.inspectionDelayMs());
        return;
      }
    }
    if (!this.isRunActive(token)) return;
    const unique = [...new Map(allJobs.map((job) => [job.id, job])).values()]
      .filter((job) => !externalJobs.has(job.id))
      .slice(0, this.settings.search.maxJobsPerRun);
    const result = await enqueueJobs(
      [...unique, ...externalJobs.values()],
      this.settings,
      evaluateJob,
      this.clock.now(),
    );
    // A pause during the enqueue keeps the queued rows (P1-6) but must not
    // overwrite the paused/stopped state with "running".
    if (!this.isRunActive(token)) return;
    this.state.scanComplete = true;
    this.scanProgress = undefined;
    this.state.status = 'running';
    this.state.currentPhase = 'running';
    this.state.message = `Found ${unique.length} jobs on ${pages} page(s) (${result.queued} queued, ${result.filtered} filtered)`;
    await this.persist();
    await this.broadcastQueue();
    await this.emit('info', 'scan.complete', `${this.state.message}; stopped: ${stoppedReason}`);
    if (externalJobs.size > 0) {
      await this.emit(
        'info',
        'scan.external',
        this.settings.search.collectExternalJobs
          ? `Collected ${externalJobs.size} external links (beta)`
          : `Skipped ${externalJobs.size} jobs that apply on the employer's site`,
      );
    }
    if (
      result.queued === 0 &&
      (await getNextQueueWakeAt(this.clock.now(), this.settings.pacing.maxAttemptsPerJob)) ===
        undefined
    ) {
      // An empty Autopilot scan is not the end of the run: wait a paced
      // interval and look again for newly posted jobs.
      if (this.state.mode !== 'autopilot') {
        this.state.status = 'idle';
        this.state.message = 'No matching jobs found';
        await this.persist();
        return;
      }
      this.state.scanComplete = false;
      this.state.message = 'No matching jobs yet; scanning again shortly';
      await this.persist();
      await this.scheduleNext(this.quietRescanDelayMs());
      return;
    }
    await this.scheduleNext(this.pacer.inspectionDelayMs());
  }

  /** Pace a rescan of the saved searches without hammering Handshake. */
  private quietRescanDelayMs(): number {
    return Math.max(this.pacer.inspectionDelayMs(), this.settings.pacing.minDelayMs);
  }

  private async apply(item: QueueItem, token = this.runToken): Promise<void> {
    if (!this.isRunActive(token)) return;
    // H4: the queue can change while this job waits. Never apply a final row.
    const startItem = await getQueueItem(item.jobId);
    if (!startItem || isImmutableStatus(startItem.status) || startItem.status === 'skipped') {
      await this.continueRun();
      return;
    }
    let job = await getJob(item.jobId);
    if (!job) {
      await updateQueueItem(item.jobId, {
        status: 'failed',
        lastError: appError('UNKNOWN', 'Job data missing'),
      });
      await this.broadcastQueue();
      await this.continueRun();
      return;
    }
    if (isExternalJob(job, startItem)) {
      await this.dropExternalJob(job);
      return;
    }
    if (job.host !== this.settings.host) {
      const error = appError(
        'INVALID_INPUT',
        'This job belongs to a different Handshake school. Select its host in Settings, then retry the job.',
      );
      await updateQueueItem(job.id, { status: 'failed', lastError: error });
      this.state.lastError = error;
      this.state.message = error.message;
      await this.pause('user');
      await this.broadcastQueue();
      return;
    }
    const previousAttempts = await getSubmissionsForJob(job.id);
    if (previousAttempts.some((attempt) => attempt.status === 'applied')) {
      // The journal wins even when a UI action requeued a stale queue row.
      await updateQueueItem(job.id, { status: 'applied', lastError: undefined });
      await setMeta(`needs:${job.id}`, null);
      await this.broadcastQueue();
      await this.scheduleNext(this.pacer.inspectionDelayMs());
      return;
    }
    if (
      previousAttempts.some((attempt) =>
        ['started', 'submitted', 'ambiguous'].includes(attempt.status),
      )
    ) {
      await updateQueueItem(job.id, {
        status: 'needs_input',
        lastError: appError('UNKNOWN', 'A previous submission needs reconciliation'),
      });
      await setMeta(`needs:${job.id}`, {
        questions: [],
        missingDocumentTypes: [],
        reason: 'review',
      });
      this.state.status = 'needs_user';
      this.state.message = 'A previous application needs review before retrying.';
      await this.persist();
      this.broadcastFn({ type: 'needs.you', jobId: job.id });
      return;
    }
    if (!this.isRunActive(token)) return;
    // Every new attempt starts from a fresh page, so a settled Needs You,
    // login, or UI-changed retry cannot reopen a stale modal or document picker.
    await this.tabs.ensure(job.url, true, { fresh: true });
    if (!this.isRunActive(token)) return;
    const inspected = await this.tabs.send<Job>({
      type: 'content.inspectJob',
      requestId: `inspect-${job.id}-${Date.now()}`,
      jobId: job.id,
    });
    if (!this.isRunActive(token)) return;
    if (!inspected.ok) {
      if (inspected.error.code === 'AUTH_REQUIRED' || inspected.error.code === 'CHALLENGE') {
        this.state.status = 'paused';
        this.state.pauseReason =
          inspected.error.code === 'CHALLENGE' ? 'auth_required' : 'auth_required';
        this.state.lastError = inspected.error;
        this.state.message = inspected.error.message;
        await this.persist();
        return;
      }
      if (inspected.error.code === 'ALREADY_APPLIED') {
        await updateQueueItem(job.id, { status: 'already_applied' });
        await this.broadcastQueue();
        await this.scheduleNext(this.pacer.inspectionDelayMs());
        return;
      }
      if (inspected.error.code === 'JOB_CLOSED') {
        await updateQueueItem(job.id, { status: 'blocked', lastError: inspected.error });
        await this.broadcastQueue();
        await this.scheduleNext(this.pacer.inspectionDelayMs());
        return;
      }
      if (inspected.error.code === 'NOT_OPEN') {
        await updateQueueItem(job.id, {
          status: 'waiting',
          nextAttemptAt: this.clock.now() + 6 * 60 * 60_000,
          lastError: inspected.error,
        });
        await this.broadcastQueue();
        await this.scheduleNext(this.pacer.inspectionDelayMs());
        return;
      }
      await this.handleFailure(job, item, inspected.error);
      return;
    }
    // Full details decide description-dependent filters and replace the
    // provisional discovery score. Keep discovery provenance and posting date.
    const inspectedJob = inspected.data;
    if (inspectedJob.id !== job.id || inspectedJob.host !== job.host) {
      const error = appError(
        'CANCELLED',
        'The job page or school changed during inspection. Return to the queued job, then resume.',
      );
      this.state.lastError = error;
      this.state.message = error.message;
      await this.pause('user');
      return;
    }
    job = {
      ...inspectedJob,
      discoveredAt: job.discoveredAt,
      postedAt: inspectedJob.postedAt ?? job.postedAt,
      source: job.source ?? inspectedJob.source,
    };
    if (job.applyType === 'external') {
      await this.dropExternalJob(job);
      return;
    }
    const evaluation = evaluateJob(job, this.settings, this.clock.now());
    job = { ...job, fitScore: evaluation.fitScore, fitReasons: evaluation.fitReasons };
    await putJob(job);
    if (!this.isRunActive(token)) return;
    await updateQueueItem(job.id, { priority: Math.round(evaluation.fitScore * 100) });
    if (!evaluation.pass) {
      await updateQueueItem(job.id, {
        status: 'filtered',
        skipReason: evaluation.reasons.join('; '),
        nextAttemptAt: undefined,
      });
      this.state.message = `Filtered: ${evaluation.reasons.join('; ')}`;
      await this.broadcastQueue();
      await this.scheduleNext(this.pacer.inspectionDelayMs());
      return;
    }
    const [bankAnswers, jobAnswers] = await Promise.all([listAnswers(), listJobAnswers(job.id)]);
    if (!this.isRunActive(token)) return;
    // Job-specific answers must win ties against the reusable bank. A remembered
    // Needs You answer can exist in both stores; keep one copy. If the bank copy
    // is newer (a Settings edit), prefer it so a stale override cannot shadow it.
    const jobAnswerIds = new Set(jobAnswers.map((answer) => answer.id));
    const bankById = new Map(bankAnswers.map((answer) => [answer.id, answer]));
    const currentJobAnswers = jobAnswers.map((answer) => {
      const bank = bankById.get(answer.id);
      return bank && bank.updatedAt > answer.updatedAt ? bank : answer;
    });
    const answers = [
      ...currentJobAnswers,
      ...bankAnswers.filter((answer) => !jobAnswerIds.has(answer.id)),
    ];
    const jobDocumentSelection = (await getQueueItem(job.id))?.documentSelection;
    const documentsAvailable = configuredDocuments(this.settings.documents, jobDocumentSelection);
    const documents = documentSelectionForJob(this.settings.documents, jobDocumentSelection);
    let resumeId = documents.resumeId ?? findDocumentForType({}, 'resume', documentsAvailable)?.id;
    // Both opt-ins are required. An explicit job choice always wins over AI.
    const shouldMatchResume =
      this.settings.ai.enabled &&
      this.settings.documents.autoSelectResume &&
      jobDocumentSelection?.resumeId === undefined;
    if (shouldMatchResume && findDocumentForType({ resumeId }, 'resume', documentsAvailable)) {
      const resumes = aiResumeCandidates(documentsAvailable).map((document) => ({
        id: document.id,
        title: document.title,
        description: document.description ?? document.filename ?? document.title,
      }));
      // AI chooses by the user's own resume names. With one resume there is no
      // choice, and an unnamed resume gives it nothing to compare, so the
      // default is used without a model call.
      const unnamed = resumes.some((resume) => !resume.title.trim());
      if (resumes.length > 1 && unnamed) {
        await this.emit(
          'debug',
          'ai.resume_unnamed',
          'Name every resume in Settings → Documents so AI can choose between them',
          job.id,
        );
      }
      if (resumes.length > 1 && !unnamed) {
        const controller = new AbortController();
        this.activeMatching = { jobId: job.id, controller };
        try {
          const match = await matchResume(
            { jobTitle: job.title, jobDescription: job.description, resumes },
            {
              settings: this.settings,
              keys: await loadAiKeys(),
              onError: (error) => {
                this.detach(this.emit('warn', 'ai.error', error.message, job.id));
              },
            },
            controller.signal,
          );
          if (controller.signal.aborted || !this.isRunActive(token)) {
            if (this.isRunActive(token)) await this.continueRun();
            return;
          }
          if (!match.ok) {
            await this.emit('warn', 'ai.error', match.error.message, job.id);
          } else if (
            match.value.confidence >= this.settings.ai.minConfidence &&
            resumes.some((resume) => resume.id === match.value.resumeId)
          ) {
            resumeId = match.value.resumeId;
            await this.emit(
              'info',
              'ai.resume_selected',
              `AI picked ${match.value.resumeId} (${Math.round(match.value.confidence * 100)}%)`,
              job.id,
            );
          }
        } finally {
          if (this.activeMatching?.controller === controller) this.activeMatching = null;
        }
      }
    }
    documents.resumeId = resumeId;
    // Availability of a type does not prove the chosen ID exists or is that
    // type. The content adapter additionally verifies the page's selection,
    // including the files a one-click Quick Apply would submit.
    const missingDocumentTypes = findMissingDocumentTypes(
      job.requiredDocumentTypes,
      documents,
      documentsAvailable,
    );
    // A pause/stop during inspection, AI matching, or document reads must not
    // fall through into a submit.
    if (!this.isRunActive(token)) return;
    const latest = await getQueueItem(job.id);
    if (!latest || isImmutableStatus(latest.status) || latest.status === 'skipped') {
      await this.continueRun();
      return;
    }
    if (!this.isRunActive(token)) return;
    // P1-2: the current settings mode is authoritative for submission. Review
    // must always win, even if the run started in autopilot and settings changed.
    const effectiveMode = restrictRunMode(this.state.mode, this.settings.mode);
    if (effectiveMode !== this.state.mode) this.state.mode = effectiveMode;
    // Only job-specific answers are known before opening the form. Count their
    // current approvals here; the content adapter gates every matched question
    // once the DOM is available, including reusable-bank answers.
    const explicitAnswerIds = jobAnswers.map((answer) => answer.id);
    const sensitiveUnapprovedCount = currentJobAnswers.filter(
      (answer) => answerApprovalReason(answer, this.settings.safety) !== undefined,
    ).length;
    const autopilot = evaluateAutopilot({
      mode: effectiveMode,
      applyType: job.applyType,
      fitScore: job.fitScore,
      minFitScore: this.settings.search.minFitScore,
      missingDocumentTypes,
      unknownQuestionCount: latest.pendingQuestionIds?.length ?? 0,
      sensitiveUnapprovedCount,
      dailyCapReached: !this.pacer.canApplyToday(this.state.todayCount),
      consecutiveFailures: this.state.consecutiveFailures,
      maxConsecutiveFailures: this.settings.pacing.maxConsecutiveFailures,
      sessionLoggedIn: true,
    });
    const options: ApplyOptions = {
      humanDelay: this.pacer.humanDelay,
      mode: effectiveMode,
      documents,
      documentsAvailable,
      answers,
      explicitAnswerIds,
      allowOneClickApply: this.settings.safety.allowOneClickApply,
      allowSensitiveAutoSubmit: this.settings.safety.allowSensitiveAutoSubmit,
      allowEeoAutoFill: this.settings.safety.allowEeoAutoFill,
      allowFreeTextAutoFill: this.settings.safety.allowFreeTextAutoFill,
      reviewBeforeSubmit:
        resolveReviewBeforeSubmit(effectiveMode, this.settings.safety.reviewBeforeSubmit) ||
        !autopilot.allowed,
      stopOnUnknownQuestion: this.settings.safety.stopOnUnknownQuestion,
      verifySubmissions: this.settings.safety.verifySubmissions,
      timeoutMs: LIMITS.applyTimeoutMs,
    };

    // Register cancellation BEFORE the first dispatch-phase await (including
    // the write-ahead journal). Pause/Stop can now revoke this continuation.
    const dispatch = {
      jobId: job.id,
      requestId: '',
      token,
      controller: new AbortController(),
      autoSubmit: !options.reviewBeforeSubmit && options.mode === 'autopilot',
      dispatched: false,
      settingsSnapshot: JSON.stringify(this.settings),
      approvalSnapshot: JSON.stringify([bankAnswers, jobAnswers, documentsAvailable]),
    };
    this.activeDispatch = dispatch;
    this.activeJobId = job.id;
    let attempt: SubmissionAttempt | undefined;
    const abortedBeforeDispatch = async (): Promise<boolean> => {
      if (this.isRunActive(token) && !dispatch.controller.signal.aborted) return false;
      if (attempt) await deleteSubmission(attempt.id);
      const current = await getQueueItem(job.id);
      if (current && !isImmutableStatus(current.status) && current.status !== 'skipped') {
        await updateQueueItem(job.id, {
          status: 'queued',
          submissionAttemptId: undefined,
          lastError: undefined,
        });
      }
      if (this.state.currentJobId === job.id) {
        this.state.currentJobId = undefined;
        this.state.currentPhase = undefined;
      }
      await this.persist();
      await this.broadcastQueue();
      if (this.isRunActive(token)) await this.continueRun();
      return true;
    };
    let response: MessageResponse<ApplyResult>;
    try {
      if (effectiveMode === 'autopilot' && !autopilot.allowed) {
        await this.emit(
          'info',
          'autopilot.review_required',
          `Autopilot gate blocked submission: ${autopilot.reasons.join('; ')}`,
          job.id,
        );
        if (await abortedBeforeDispatch()) return;
      }
      // Recover old running states too. The following persist happens before
      // content.apply is dispatched; never invent an attempt-only run ID.
      this.state.runId ??= `run-${Date.now()}`;
      attempt = await createSubmission({
        runId: this.state.runId,
        jobId: job.id,
        host: job.host,
        startedAt: now(),
        status: 'started',
        applyType: job.applyType,
        documents: [],
        questionIds: [],
      });
      dispatch.requestId = attempt.id;
      if (await abortedBeforeDispatch()) return;

      this.state.currentJobId = job.id;
      this.state.currentPhase = 'opening';
      this.state.message = `Opening ${job.title}`;
      await this.persist();
      if (await abortedBeforeDispatch()) return;
      await updateQueueItem(job.id, { status: 'opening', submissionAttemptId: attempt.id });
      if (await abortedBeforeDispatch()) return;
      await this.tabs.ensure(job.url);
      if (await abortedBeforeDispatch()) return;
      await this.emit('info', 'job.opening', `Opening ${job.title} at ${job.employer}`, job.id);
      if (await abortedBeforeDispatch()) return;
      // No await may separate this final check from the actual dispatch.
      if (!this.isRunActive(token) || dispatch.controller.signal.aborted) {
        await abortedBeforeDispatch();
        return;
      }
      dispatch.dispatched = true;
      const reply: unknown = await this.tabs.send<ApplyResult>(
        { type: 'content.apply', requestId: dispatch.requestId, job, options },
        LIMITS.applyTimeoutMs,
      );
      response = validateApplyResponse(reply, dispatch.requestId, job.id);
    } catch (error) {
      if (
        !dispatch.dispatched &&
        (!this.isRunActive(token) || dispatch.controller.signal.aborted)
      ) {
        await abortedBeforeDispatch();
        return;
      }
      throw error;
    } finally {
      if (this.activeDispatch === dispatch) {
        this.activeDispatch = null;
        this.activeJobId = null;
      }
    }
    if (!attempt) return;
    if (
      (response.ok && response.data.outcome === 'external') ||
      (!response.ok && response.error.code === 'EXTERNAL_APPLY')
    ) {
      await updateSubmission(attempt.id, {
        status: 'failed',
        finishedAt: now(),
        reconciliationNote: 'External link; no Handshake application',
      });
      await this.dropExternalJob(job);
      return;
    }
    if (
      response.ok &&
      response.data.outcome === 'applied' &&
      (!isInternalApplication(job.applyType) || !hasPositiveSubmissionEvidence(response.data))
    ) {
      response = {
        ...response,
        data: {
          ...response.data,
          outcome: 'verifying',
          error: appError(
            'UNKNOWN',
            'No positive submission evidence. Check the job page or My Jobs.',
          ),
        },
      };
    }
    if (
      (!response.ok && response.error.code === 'TIMEOUT') ||
      (response.ok &&
        (response.data.outcome === 'applied' || response.data.outcome === 'verifying'))
    ) {
      await countAttemptTowardCapOnce(attempt.id);
      this.state.todayCount = await getTodayCount();
    }

    // P1-3: the row may have been skipped (or otherwise finalized) while the
    // apply was in flight. A late result must never overwrite that decision.
    const settledItem = await getQueueItem(job.id);
    const rowFinalized =
      settledItem !== undefined &&
      (settledItem.status === 'skipped' || isImmutableStatus(settledItem.status));
    if (rowFinalized) {
      if (!response.ok) {
        if (response.error.code === 'CANCELLED') {
          await deleteSubmission(attempt.id);
        } else {
          const ambiguous = response.error.code === 'TIMEOUT';
          await updateSubmission(attempt.id, {
            status: ambiguous ? 'ambiguous' : 'failed',
            finishedAt: now(),
            error: response.error,
            reconciliationNote: ambiguous
              ? 'Apply was in flight when the row became final; verify before retrying'
              : `Closed while the queue row became ${settledItem?.status ?? 'final'}`,
          });
        }
      } else {
        const result = response.data;
        const applied = result.outcome === 'applied';
        // Reuse the normal outcome mapping: verifying/review outcomes mean the
        // form may have been submitted, so the journal must say `ambiguous` (and
        // block retry), not `failed`.
        await updateSubmission(attempt.id, {
          status: submissionStatusForOutcome(result.outcome),
          finishedAt: now(),
          confirmationText: result.confirmationText,
          documents: result.documentsUsed ?? [],
          questionIds: result.questions?.map((question) => question.id) ?? [],
          error: result.error,
          reconciliationNote: `Queue row became ${settledItem?.status ?? 'final'} while apply was in flight`,
        });
        if (applied) {
          // A late applied result is authoritative: mark the row applied so no
          // retry path can send a duplicate.
          await updateQueueItem(job.id, { status: 'applied', lastError: undefined });
          await setMeta(`needs:${job.id}`, null);
          this.state.message = `Applied: ${job.title} at ${job.employer}`;
          await this.emit('info', 'job.applied', this.state.message, job.id);
          if (settledItem?.status !== 'applied') {
            this.state.consecutiveFailures = 0;
          }
        } else if (result.outcome === 'verifying') {
          await this.emit(
            'warn',
            'job.verifying',
            'Submission is unverified. Check the job page or My Jobs before retrying.',
            job.id,
          );
        }
      }
      this.state.currentJobId = undefined;
      this.state.currentPhase = undefined;
      await this.broadcastQueue();
      await this.continueRun();
      return;
    }

    if (!response.ok) {
      if (response.error.code === 'CANCELLED') {
        // Stopped/paused before the adapter clicked Submit. Nothing was sent,
        // so the job returns to the queue without an attempt penalty.
        await deleteSubmission(attempt.id);
        await updateQueueItem(job.id, {
          status: 'queued',
          lastError: undefined,
          submissionAttemptId: undefined,
        });
        this.state.currentJobId = undefined;
        this.state.currentPhase = undefined;
        await this.broadcastQueue();
        await this.continueRun();
        return;
      }
      if (response.error.code === 'TIMEOUT') {
        // H2: the response channel was lost while the adapter was applying.
        // The submission may have happened; never retry it automatically.
        const uncertain = appError(
          'UNKNOWN',
          'The application response was lost. Check the job page or My Jobs before retrying.',
        );
        await updateSubmission(attempt.id, {
          status: 'ambiguous',
          finishedAt: now(),
          error: uncertain,
          reconciliationNote: 'Apply response was lost; needs human verification',
        });
        await updateQueueItem(job.id, { status: 'verifying', lastError: uncertain });
        await setMeta(`needs:${job.id}`, {
          questions: [],
          missingDocumentTypes: [],
          reason: 'review',
        });
        if (this.isRunActive(token)) this.state.status = 'needs_user';
        this.state.currentJobId = undefined;
        this.state.currentPhase = undefined;
        this.state.message = uncertain.message;
        this.broadcastFn({ type: 'needs.you', jobId: job.id });
        await this.broadcastQueue();
        await this.persist();
        return;
      }
      await updateSubmission(attempt.id, {
        status: 'failed',
        finishedAt: now(),
        error: response.error,
      });
      await this.handleFailure(job, item, response.error);
      return;
    }

    const result = response.data;
    await updateQueueItem(job.id, {
      status:
        result.outcome === 'applied'
          ? 'applied'
          : result.outcome === 'manual_submit_required'
            ? 'ready_for_review'
            : result.outcome,
      lastError: result.error,
      pendingQuestionIds: result.questions?.map((question) => question.id),
      missingDocumentTypes: result.missingDocumentTypes,
    } as Partial<QueueItem>);
    await updateSubmission(attempt.id, {
      status: submissionStatusForOutcome(result.outcome),
      finishedAt: now(),
      confirmationText: result.confirmationText,
      documents: result.documentsUsed ?? [],
      questionIds: result.questions?.map((question) => question.id) ?? [],
      error: result.error,
    });

    this.state.currentJobId = undefined;
    this.state.currentPhase = undefined;

    switch (result.outcome) {
      case 'applied': {
        await setMeta(`needs:${job.id}`, null);
        this.state.consecutiveFailures = 0;
        this.applicationsThisSession += 1;
        if (this.pacer.shouldTakeBreak(this.applicationsThisSession)) {
          this.batchBreakUntil = this.clock.now() + this.pacer.sessionBreakMs();
        }
        await this.persistSession();
        this.state.message = `Applied: ${job.title} at ${job.employer}`;
        await this.emit('info', 'job.applied', this.state.message, job.id);
        await this.broadcastQueue();
        if (this.pacer.shouldTakeBreak(this.applicationsThisSession)) {
          const breakMs = Math.max(0, this.batchBreakUntil - this.clock.now());
          this.state.message = `Session batch complete. Taking a ${Math.max(
            1,
            Math.round(breakMs / 60_000),
          )}-minute break.`;
          await this.emit('info', 'engine.session_break', this.state.message, job.id);
          await this.scheduleNext(breakMs);
          return;
        }
        await this.scheduleNext(this.pacer.nextDelayMs(this.state.todayCount, 0));
        return;
      }
      case 'ready_for_review':
      case 'manual_submit_required': {
        const message =
          result.confirmationText ??
          (result.outcome === 'manual_submit_required'
            ? 'Click Quick Apply yourself in the Handshook tab.'
            : 'Application filled. Review it in the Handshook tab, then submit.');
        await setMeta(`needs:${job.id}`, {
          questions: [],
          missingDocumentTypes: [],
          reason: 'review',
          message,
        });
        await updateQueueItem(job.id, { status: 'ready_for_review' });
        if (this.isRunActive(token)) this.state.status = 'needs_user';
        this.state.message = message;
        this.broadcastFn({ type: 'needs.you', jobId: job.id });
        await this.broadcastQueue();
        await this.emit(
          'info',
          result.outcome === 'manual_submit_required'
            ? 'job.manual_submit_required'
            : 'job.ready_for_review',
          message,
          job.id,
        );
        await this.persist();
        return;
      }
      case 'would_apply': {
        // Dry runs never attempted a submission; do not leave a failed record.
        await deleteSubmission(attempt.id);
        await setMeta(`needs:${job.id}`, null);
        await updateQueueItem(job.id, { status: 'would_apply' });
        // A dry run may have read a declared form's questions; unanswered ones
        // join the Questions to answer list before any real application.
        await recordInboxQuestions(result.questions ?? [], job.id, 'scan');
        this.state.consecutiveFailures = 0;
        this.state.message =
          result.confirmationText ?? `Dry run: would apply to ${job.title} at ${job.employer}.`;
        await this.emit('info', 'job.would_apply', this.state.message, job.id);
        this.broadcastFn({ type: 'toast', level: 'info', message: this.state.message });
        await this.broadcastQueue();
        await this.scheduleNext(this.pacer.nextDelayMs(this.state.todayCount, 0));
        return;
      }
      case 'verifying': {
        await setMeta(`needs:${job.id}`, {
          questions: [],
          missingDocumentTypes: [],
          reason: 'review',
        });
        if (this.isRunActive(token)) this.state.status = 'needs_user';
        this.state.message =
          'Submission needs verification. Check the job page or My Jobs before retrying.';
        await updateQueueItem(job.id, { status: 'verifying' });
        this.broadcastFn({ type: 'needs.you', jobId: job.id });
        await this.broadcastQueue();
        await this.emit('warn', 'job.verifying', this.state.message, job.id);
        await this.persist();
        return;
      }
      case 'needs_input': {
        await setMeta(`needs:${job.id}`, {
          questions: result.questions ?? [],
          missingDocumentTypes: result.missingDocumentTypes ?? [],
          reason: (result.missingDocumentTypes?.length ?? 0) > 0 ? 'documents' : 'questions',
        });
        await recordInboxQuestions(result.questions ?? [], job.id);
        this.state.message = result.missingDocumentTypes?.length
          ? `Could not attach or verify: ${result.missingDocumentTypes.map((type) => type.replace('_', ' ')).join(', ')}. See Needs you for details.`
          : 'A question needs your input.';
        this.broadcastFn({
          type: 'needs.you',
          jobId: job.id,
          questions: result.questions,
          missingDocumentTypes: result.missingDocumentTypes,
        });
        await this.broadcastQueue();
        await this.emit('warn', 'job.needs_input', this.state.message, job.id);
        if (this.state.mode === 'autopilot' && this.isRunActive(token)) {
          // Click-and-forget: this job waits in Needs You while the run moves on.
          // Answering it puts it back in the queue for this or the next run.
          await this.scheduleNext(this.pacer.nextDelayMs(this.state.todayCount, 0));
          return;
        }
        if (this.isRunActive(token)) this.state.status = 'needs_user';
        await this.persist();
        return;
      }
      case 'already_applied':
      case 'waiting': {
        if (result.outcome === 'waiting') {
          // L17: a not-open job must have a retry time, otherwise it is picked
          // up again immediately and burns the queue.
          await updateQueueItem(job.id, {
            nextAttemptAt: this.clock.now() + 6 * 60 * 60_000,
          });
        }
        this.state.message =
          result.outcome === 'already_applied' ? 'Already applied' : 'Job is not open yet';
        await this.emit('info', `job.${result.outcome}`, this.state.message, job.id);
        await this.broadcastQueue();
        await this.scheduleNext(this.pacer.nextDelayMs(this.state.todayCount, 0));
        return;
      }
      case 'failed':
      default: {
        await this.handleFailure(
          job,
          item,
          result.error ?? appError('UNKNOWN', 'Application failed'),
        );
        return;
      }
    }
  }

  private async dropExternalJob(job: Job): Promise<void> {
    await putJob({ ...job, applyType: 'external', fitScore: undefined, fitReasons: undefined });
    await updateQueueItem(job.id, {
      status: 'external',
      priority: 0,
      lastError: undefined,
      nextAttemptAt: undefined,
      pendingQuestionIds: [],
      missingDocumentTypes: [],
    });
    await setMeta(`needs:${job.id}`, null);
    this.state.todayCount = await getTodayCount();
    this.state.currentJobId = undefined;
    this.state.currentPhase = undefined;
    this.state.message = 'Continuing with Handshake applications';
    await this.broadcastQueue();
    await this.continueRun();
  }

  private async handleFailure(
    job: Job,
    item: QueueItem,
    error: NonNullable<ApplyResult['error']>,
  ): Promise<void> {
    if (error.code === 'EXTERNAL_APPLY') {
      await this.dropExternalJob(job);
      return;
    }
    if (error.code === 'AUTH_REQUIRED' || error.code === 'CHALLENGE') {
      await updateQueueItem(job.id, {
        status: 'queued',
        attempts: item.attempts + 1,
        lastError: error,
      });
      this.state.lastError = error;
      this.state.message = error.message;
      await this.emit('warn', 'engine.auth_required', error.message, job.id);
      await this.broadcastQueue();
      await this.pause('auth_required');
      return;
    }
    if (error.code === 'UI_CHANGED') {
      await updateQueueItem(job.id, {
        status: 'blocked',
        attempts: item.attempts + 1,
        lastError: error,
      });
      this.state.lastError = error;
      this.state.message = error.message;
      await this.emit('error', 'engine.ui_changed', error.message, job.id);
      await this.broadcastQueue();
      // Never guess at a changed form: pause for the user instead of trying
      // the next job with selectors that no longer match.
      await this.pause('ui_changed');
      return;
    }
    if (error.code === 'RATE_LIMITED' || error.code === 'FORBIDDEN') {
      await updateQueueItem(job.id, {
        status: 'failed',
        attempts: item.attempts + 1,
        lastError: error,
      });
      this.state.lastError = error;
      this.state.message = error.message;
      await this.emit('warn', 'engine.rate_limited', error.message, job.id);
      await this.pause('rate_limited');
      return;
    }
    const attempts = item.attempts + 1;
    this.state.consecutiveFailures += 1;
    const retry = error.retryable && attempts < this.settings.pacing.maxAttemptsPerJob;
    await updateQueueItem(job.id, {
      status: retry ? 'queued' : 'failed',
      attempts,
      lastError: error,
      nextAttemptAt: retry
        ? this.clock.now() +
          this.pacer.nextDelayMs(this.state.todayCount, this.state.consecutiveFailures)
        : undefined,
    });
    this.state.lastError = error;
    this.state.message = `${job.title}: ${error.message}`;
    await this.emit('error', `job.${error.code.toLowerCase()}`, this.state.message, job.id);
    await this.persist();
    await this.broadcastQueue();
    if (this.state.consecutiveFailures >= this.settings.pacing.maxConsecutiveFailures) {
      await this.pause('too_many_failures');
      return;
    }
    // Always schedule the next tick, even when this failure is not retryable.
    // Otherwise a UNKNOWN/AUTH/CHALLENGE-class failure can leave the engine
    // `running` with no timer and no way to reach the next job.
    await this.scheduleNext(
      this.pacer.nextDelayMs(this.state.todayCount, this.state.consecutiveFailures),
    );
  }

  async reconcile(): Promise<boolean> {
    if (!this.state) await this.load();
    const token = this.runToken;
    const unresolved = await listUnresolvedSubmissions();
    if (token !== this.runToken) return true;
    if (unresolved.length === 0) return false;
    let needsReview = 0;
    for (const attempt of unresolved) {
      if (token !== this.runToken) return true;
      const item = await getQueueItem(attempt.jobId);
      const storedJob = await getJob(attempt.jobId);
      if (attempt.applyType === 'external' || isExternalJob(storedJob, item)) {
        // Legacy external records must never trigger runner navigation or cap reservation.
        continue;
      }
      if (item?.status === 'applied') {
        // L18: the queue already records the application. Resolve the stale
        // write-ahead submission instead of leaving it "unresolved" forever.
        const settled = await settleReconciledSubmission(
          attempt.id,
          attempt.jobId,
          attempt.host,
          'Queue already marked applied',
        );
        if (!settled.ok) throw new Error(settled.error.message);
        if (settled.value) this.broadcastFn({ type: 'event.appended', event: settled.value });
        this.state.todayCount = await getTodayCount();
        continue;
      }
      // Review handoffs and needs-input items are waiting on the user, not on a
      // reconciliation. Re-checking them would turn a filled review form into a
      // false "could not verify" state.
      if (item?.status === 'needs_input') continue;
      // Keep the user's terminal row, but retain the journal's replay barrier:
      // skipping an uncertain send is not evidence it failed. A later retry
      // must still go to human review, even after restart/reconciliation.
      if (item && (item.status === 'skipped' || isImmutableStatus(item.status))) {
        await updateSubmission(attempt.id, {
          status: 'ambiguous',
          finishedAt: attempt.finishedAt ?? now(),
          reconciledAt: now(),
          reconciliationNote: `Queue row is ${item.status}; submission still unverified, replay blocked`,
        });
        await countAttemptTowardCapOnce(attempt.id);
        this.state.todayCount = await getTodayCount();
        continue;
      }
      const job = await getJob(attempt.jobId);
      let applied = false;
      if (job) {
        try {
          // Never navigate away from a filled review form. A read on its
          // current page can still recover manual confirmation after reload.
          if (item?.status !== 'ready_for_review') await this.tabs.ensure(job.url);
          if (token !== this.runToken) return true;
          const verifyRequestId = `verify-${attempt.id}`;
          const verified = await this.tabs.send<{ applied: boolean; jobId: string; host: string }>({
            type: 'content.verifySubmission',
            requestId: verifyRequestId,
            jobId: attempt.jobId,
            host: attempt.host,
            attemptId: attempt.id,
            timeoutMs: 20_000,
          });
          applied =
            verified.ok &&
            verified.requestId === verifyRequestId &&
            verified.data.applied === true &&
            verified.data.jobId === attempt.jobId &&
            verified.data.host === attempt.host;
        } catch {
          applied = false;
        }
      }
      if (applied) {
        const settled = await settleReconciledSubmission(
          attempt.id,
          attempt.jobId,
          attempt.host,
          'Verified applied on job page after restart',
        );
        if (!settled.ok) throw new Error(settled.error.message);
        if (settled.value) this.broadcastFn({ type: 'event.appended', event: settled.value });
        this.state.todayCount = await getTodayCount();
        this.state.consecutiveFailures = 0;
        continue;
      }
      if (item?.status === 'ready_for_review') {
        needsReview += 1;
        continue;
      }
      needsReview += 1;
      await countAttemptTowardCapOnce(attempt.id);
      this.state.todayCount = await getTodayCount();
      await updateSubmission(attempt.id, {
        status: 'ambiguous',
        finishedAt: now(),
        reconciledAt: now(),
        reconciliationNote: 'Could not confirm submission; needs human review',
      });
      await updateQueueItem(attempt.jobId, {
        status: 'needs_input',
        lastError: appError(
          'UNKNOWN',
          'A previous submission could not be verified. Check My Jobs.',
        ),
      });
      await setMeta(`needs:${attempt.jobId}`, {
        questions: [],
        missingDocumentTypes: [],
        reason: 'review',
      });
    }
    if (needsReview > 0 && token === this.runToken) {
      this.state.status = 'needs_user';
      this.state.message = `${needsReview} previous submission(s) need review before continuing.`;
      await saveEngineState(this.state);
      this.broadcastFn({ type: 'state.changed', state: { ...this.state } });
    }
    return needsReview > 0;
  }
}

export const engine = new Engine();
