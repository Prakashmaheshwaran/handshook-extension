/**
 * Diagnostics is an allowlist, not a scrubbed copy of storage. New fields and
 * new free-form codes stay private until explicitly reviewed here.
 */
import { z } from 'zod';
import {
  appErrorSchema,
  isRecord,
  jobStatusSchema,
  onboardingSchema,
  pauseReasonSchema,
  settingsSchema,
  type EngineState,
  type JobEvent,
  type OnboardingState,
  type QueueSummary,
  type Settings,
} from '@/core/contracts';
import { REDACTED, redactText } from '@/core/logging/redact';

export const REDACTION_VERSION = 4;
export const DIAGNOSTICS_NOTICE =
  'Shareable diagnostics: personal text, search URLs, keywords, tenant hosts, names, contact details, job and document content, identifiers, credentials, and page text are removed. Only reviewed status codes, settings, counters, timestamps, selector keys, and sanitized action-area structure are retained. The structure includes fixed control labels and attributes, visibility flags, and bounded counts. Safety opt-ins are included as booleans; document presence and counts are included, but document IDs, names and contents are not.';

const ENGINE_STATUSES = [
  'idle',
  'onboarding',
  'scanning',
  'running',
  'paused',
  'needs_user',
  'stopped',
  'error',
] as const;
const PHASES = [
  'scanning',
  'opening',
  'inspecting',
  'matching',
  'filling',
  'submitting',
  'verifying',
  'ready_for_review',
  'waiting',
  'review',
  'idle',
] as const;
export const EVENT_TYPES = [
  'engine.started',
  'engine.paused',
  'engine.stopped',
  'engine.tick_failed',
  'engine.session_break',
  'engine.auth_required',
  'engine.ui_changed',
  'engine.rate_limited',
  'scan.started',
  'scan.page',
  'scan.complete',
  'ai.error',
  'ai.resume_selected',
  'autopilot.review_required',
  'job.manual_submit_required',
  'migration.imported',
  'selector.miss',
  'selector.hit',
  ...jobStatusSchema.options.map((status) => `job.${status}`),
  ...appErrorSchema.shape.code.options.map((code) => `job.${code.toLowerCase()}`),
];

export function diagnosticLabel(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? redactText(value) : REDACTED;
}

function number(value: unknown): number | undefined {
  const parsed = z.number().finite().nonnegative().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function boolean(value: unknown): boolean | undefined {
  const parsed = z.boolean().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function hidden(value: unknown): string | undefined {
  return value === undefined ? undefined : REDACTED;
}

export function diagnosticHost(value: unknown): string {
  return diagnosticLabel(value, ['app.joinhandshake.com', 'app.joinhandshake.co.uk']);
}

export function diagnosticSettings(settings: Settings) {
  return {
    schemaVersion: settings.schemaVersion,
    defaultsRevision: number(settings.defaultsRevision),
    mode: diagnosticLabel(settings.mode, settingsSchema.shape.mode.options),
    host: diagnosticHost(settings.host),
    onboardingComplete: settings.onboardingComplete,
    search: {
      savedSearches: settings.search.savedSearches.map((search) => ({
        id: REDACTED,
        name: REDACTED,
        url: REDACTED,
        enabled: search.enabled,
      })),
      activeSearchId: hidden(settings.search.activeSearchId),
      maxPagesPerRun: settings.search.maxPagesPerRun,
      maxJobsPerRun: settings.search.maxJobsPerRun,
      minFitScore: settings.search.minFitScore,
      includeKeywords: settings.search.includeKeywords.map(() => REDACTED),
      excludeKeywords: settings.search.excludeKeywords.map(() => REDACTED),
      locations: settings.search.locations.map(() => REDACTED),
      remoteOnly: settings.search.remoteOnly,
      employmentTypes: settings.search.employmentTypes.map(() => REDACTED),
    },
    pacing: {
      minDelayMs: settings.pacing.minDelayMs,
      maxDelayMs: settings.pacing.maxDelayMs,
      jitterPercent: settings.pacing.jitterPercent,
      dailyCap: settings.pacing.dailyCap,
      hardCap: settings.pacing.hardCap,
      sessionBatchSize: settings.pacing.sessionBatchSize,
      sessionBreakMinMs: settings.pacing.sessionBreakMinMs,
      sessionBreakMaxMs: settings.pacing.sessionBreakMaxMs,
      activeHours: settings.pacing.activeHours ? REDACTED : null,
      maxConsecutiveFailures: settings.pacing.maxConsecutiveFailures,
      maxAttemptsPerJob: settings.pacing.maxAttemptsPerJob,
    },
    documents: {
      defaultResumeSet: Boolean(settings.documents.defaultResumeId),
      additionalResumes: settings.documents.additionalResumes?.length ?? 0,
      coverLetterSet: Boolean(settings.documents.coverLetterId),
      transcriptSet: Boolean(settings.documents.transcriptId),
      otherDocumentSet: Boolean(settings.documents.otherDocumentId),
      autoSelectResume: settings.documents.autoSelectResume,
    },
    ai: {
      enabled: settings.ai.enabled,
      provider: diagnosticLabel(
        settings.ai.provider,
        settingsSchema.shape.ai.shape.provider.options,
      ),
      minConfidence: settings.ai.minConfidence,
      pageAssist: boolean(settings.ai.pageAssist),
      answerAssist: boolean(settings.ai.answerAssist),
      answerWrite: boolean(settings.ai.answerWrite),
    },
    safety: {
      reviewBeforeSubmit: settings.safety.reviewBeforeSubmit,
      allowOneClickApply: settings.safety.allowOneClickApply,
      allowSensitiveAutoSubmit: settings.safety.allowSensitiveAutoSubmit,
      allowEeoAutoFill: settings.safety.allowEeoAutoFill,
      allowFreeTextAutoFill: settings.safety.allowFreeTextAutoFill,
      stopOnUnknownQuestion: settings.safety.stopOnUnknownQuestion,
      verifySubmissions: settings.safety.verifySubmissions,
    },
    ui: {
      theme: diagnosticLabel(settings.ui.theme, settingsSchema.shape.ui.shape.theme.options),
      showAdvanced: settings.ui.showAdvanced,
    },
  };
}

export function diagnosticEngine(engine: EngineState) {
  return {
    version: number(engine.version),
    status: diagnosticLabel(engine.status, ENGINE_STATUSES),
    mode: diagnosticLabel(engine.mode, settingsSchema.shape.mode.options),
    host: diagnosticHost(engine.host),
    runId: hidden(engine.runId),
    startedAt: number(engine.startedAt),
    pausedAt: number(engine.pausedAt),
    pauseReason:
      engine.pauseReason === undefined
        ? undefined
        : diagnosticLabel(engine.pauseReason, pauseReasonSchema.options),
    currentJobId: hidden(engine.currentJobId),
    currentPhase:
      engine.currentPhase === undefined ? undefined : diagnosticLabel(engine.currentPhase, PHASES),
    nextActionAt: number(engine.nextActionAt),
    scanComplete: boolean(engine.scanComplete),
    todayCount: number(engine.todayCount),
    dailyCap: number(engine.dailyCap),
    consecutiveFailures: number(engine.consecutiveFailures),
    lastError: engine.lastError
      ? {
          code: diagnosticLabel(engine.lastError.code, appErrorSchema.shape.code.options),
          retryable: boolean(engine.lastError.retryable),
          message: REDACTED,
        }
      : undefined,
    message: hidden(engine.message),
    updatedAt: number(engine.updatedAt),
  };
}

export function diagnosticOnboarding(onboarding: OnboardingState) {
  return {
    version: number(onboarding.version),
    step: diagnosticLabel(onboarding.step, onboardingSchema.shape.step.options),
    host: onboarding.host === undefined ? undefined : diagnosticHost(onboarding.host),
    sessionStatus: diagnosticLabel(onboarding.sessionStatus, [
      'unknown',
      'logged_in',
      'logged_out',
    ]),
    answersConfigured: boolean(onboarding.answersConfigured),
    searchConfigured: boolean(onboarding.searchConfigured),
    completedAt: number(onboarding.completedAt),
  };
}

function diagnosticEventData(input: unknown) {
  const data = isRecord(input) ? input : {};
  const output: Record<string, string | number | boolean> = {};
  for (const key of [
    'count',
    'total',
    'found',
    'pages',
    'attempts',
    'durationMs',
    'confidence',
    'todayCount',
    'resumes',
    'searches',
    'keywords',
    'pacingKeys',
    'imported',
    'kept',
    'answers',
    'documents',
    'jobs',
    'tracker',
    'statusCode',
  ]) {
    const value = number(data[key]);
    if (value !== undefined) output[key] = value;
  }
  for (const key of ['ok', 'retryable', 'cached', 'settings']) {
    const value = boolean(data[key]);
    if (value !== undefined) output[key] = value;
  }
  for (const [key, allowed] of [
    ['code', appErrorSchema.shape.code.options],
    ['reason', pauseReasonSchema.options],
    ['phase', PHASES],
    ['provider', settingsSchema.shape.ai.shape.provider.options],
    ['status', [...ENGINE_STATUSES, ...jobStatusSchema.options]],
  ] as const) {
    if (data[key] !== undefined) output[key] = diagnosticLabel(data[key], allowed);
  }
  return output;
}

export function diagnosticEvent(event: JobEvent) {
  return {
    id: REDACTED,
    at: number(event.at),
    level: diagnosticLabel(event.level, ['debug', 'info', 'warn', 'error']),
    type: diagnosticLabel(event.type, EVENT_TYPES),
    jobId: hidden(event.jobId),
    message: REDACTED,
    data: diagnosticEventData(event.data),
  };
}

export function diagnosticQueue(summary: QueueSummary) {
  return {
    counts: Object.fromEntries(
      jobStatusSchema.options.flatMap((status) => {
        const count = number(summary.counts[status]);
        return count === undefined ? [] : [[status, count]];
      }),
    ),
    total: number(summary.total),
    todayCount: number(summary.todayCount),
    dailyCap: number(summary.dailyCap),
    remainingToday: number(summary.remainingToday),
    currentJobId: hidden(summary.currentJobId),
  };
}
