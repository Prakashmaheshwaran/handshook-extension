import { z } from 'zod';
import { pacingTimings, type DelayRange, type PacingSpeed } from './pacing';
export {
  ESTIMATED_APPLY_TIME_MS,
  PACING_PRESETS,
  describePacingRate,
  estimateAppsPerHour,
  formatPacingRate,
  type AppRateEstimate,
  type DelayRange,
  type PacingSpeed,
  type PacingTimings,
} from './pacing';
import { safeExternalUrl } from '@/core/util/application-policy';

export const PROTOCOL_VERSION = 1 as const;

export const STORAGE_KEYS = {
  settings: 'handshook.settings.v1',
  engine: 'handshook.engine.v1',
  onboarding: 'handshook.onboarding.v1',
  aiKeys: 'handshook.ai.keys.v1',
  aiMigration: 'handshook.ai.migration.v1',
} as const;

export const DB_NAME = 'handshook';
export const DB_VERSION = 1;

export const DB_STORES = {
  jobs: 'jobs',
  queue: 'queue',
  events: 'events',
  answers: 'answers',
  documents: 'documents',
  aiCache: 'aiCache',
  submissions: 'submissions',
  meta: 'meta',
} as const;

export const LIMITS = {
  maxEvents: 5_000,
  maxAiCache: 2_000,
  maxApplyAttempts: 2,
  maxConcurrentJobs: 1,
  maxTabs: 1,
  defaultRequestTimeoutMs: 30_000,
  applyTimeoutMs: 5 * 60_000,
  reviewTimeoutMs: 15 * 60_000,
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'CHALLENGE'
  | 'CAP_REACHED'
  | 'EXTERNAL_APPLY'
  | 'MISSING_DOCUMENT'
  | 'UNKNOWN_QUESTION'
  | 'UI_CHANGED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ALREADY_APPLIED'
  | 'JOB_CLOSED'
  | 'NOT_OPEN'
  | 'CANCELLED'
  | 'STORAGE_MIGRATION_FAILED'
  | 'PROTOCOL_MISMATCH'
  | 'UNSUPPORTED_MESSAGE'
  | 'INVALID_INPUT'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: string;
}

export const appErrorSchema = z.object({
  code: z.enum([
    'AUTH_REQUIRED',
    'RATE_LIMITED',
    'FORBIDDEN',
    'CHALLENGE',
    'CAP_REACHED',
    'EXTERNAL_APPLY',
    'MISSING_DOCUMENT',
    'UNKNOWN_QUESTION',
    'UI_CHANGED',
    'NETWORK',
    'TIMEOUT',
    'ALREADY_APPLIED',
    'JOB_CLOSED',
    'NOT_OPEN',
    'CANCELLED',
    'STORAGE_MIGRATION_FAILED',
    'PROTOCOL_MISMATCH',
    'UNSUPPORTED_MESSAGE',
    'INVALID_INPUT',
    'UNKNOWN',
  ]),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  cause: z.string().optional(),
});

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: AppError): Result<T> {
  return { ok: false, error };
}

export function appError(
  code: ErrorCode,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
): AppError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    details: options.details,
    cause: options.cause instanceof Error ? options.cause.message : undefined,
  };
}

export type ApplyType = 'quick_apply' | 'handshake_form' | 'external' | 'unknown';

export type JobStatus =
  | 'discovered'
  | 'filtered'
  | 'queued'
  | 'opening'
  | 'filling'
  | 'ready_for_review'
  | 'submitting'
  | 'verifying'
  | 'applied'
  | 'would_apply'
  | 'external'
  | 'needs_input'
  | 'waiting'
  | 'already_applied'
  | 'skipped'
  | 'failed'
  | 'blocked';

export type TerminalJobStatus =
  'applied' | 'external' | 'already_applied' | 'skipped' | 'filtered' | 'blocked';

export type EngineStatus =
  'idle' | 'onboarding' | 'scanning' | 'running' | 'paused' | 'needs_user' | 'stopped' | 'error';

export type RunMode = 'review' | 'autopilot' | 'dry_run';

export type PauseReason =
  | 'user'
  | 'cap_reached'
  | 'active_hours'
  | 'auth_required'
  | 'rate_limited'
  | 'ui_changed'
  | 'too_many_failures'
  | 'tab_closed'
  | 'browser_restarted'
  | 'storage_error'
  | 'protocol_mismatch';

export type DocumentType = 'resume' | 'cover_letter' | 'transcript' | 'other';

export type QuestionType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'number'
  | 'combobox'
  | 'unknown';

export type AnswerValue = string | number | boolean | string[] | null;

export type AiAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export type AiProvider = 'heuristic' | 'openrouter';

export interface AiKeys {
  openRouterApiKey?: string;
}

export interface OpenRouterModelSummary {
  id: string;
  name: string;
  contextLength: number | null;
  promptPricePerMillion: number | null;
  completionPricePerMillion: number | null;
  isFree: boolean;
  supportsStructuredOutputs: boolean;
  supportsResponseFormat: boolean;
  expirationDate: string | null;
}

export interface OpenRouterKeyInfo {
  label: string;
  limit: number | null;
  limitRemaining: number | null;
  usage: number;
  isFreeTier: boolean;
  freeDailyRemaining: number | null;
}

export interface AiStatusPayload {
  enabled: boolean;
  provider: 'auto' | AiProvider;
  openRouterConfigured: boolean;
  openRouterMessage?: string;
  openRouterPermission: 'granted' | 'not_granted';
  geminiReplacedNotice: boolean;
}

export interface AiTestResult {
  provider: AiProvider;
  ok: boolean;
  message: string;
  model?: string;
  costUsd?: number;
}

export interface OpenRouterModelsPayload {
  models: OpenRouterModelSummary[];
  fetchedAt: number;
}

export interface AiMigrationDismissedPayload {
  dismissed: true;
}

/**
 * Files the legacy migration screen can read. `auto` lets the parser detect the
 * shape from the JSON keys; the other values are explicit user choices.
 */
export type LegacyFileKind = 'conf' | 'tracker' | 'rate_stats' | 'backup';
export type LegacyFileKindInput = LegacyFileKind | 'auto';

export interface Job {
  id: string;
  host: string;
  title: string;
  employer: string;
  url: string;
  description: string;
  location?: string;
  employmentType?: string;
  remote?: boolean;
  salary?: string;
  postedAt?: string;
  applyType: ApplyType;
  /** Validated employer Apply href for the manual-only beta list; url remains the Handshake posting. */
  externalUrl?: string;
  applyStartAt?: string;
  requiredDocumentTypes: DocumentType[];
  source: 'search' | 'import' | 'manual';
  discoveredAt: number;
  fitScore?: number;
  fitReasons?: string[];
}

export interface QueueItem {
  jobId: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  addedAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  lastError?: AppError;
  /** Why a job was skipped; kept apart from `lastError` so it is not treated as a failure. */
  skipReason?: string;
  pendingQuestionIds?: string[];
  missingDocumentTypes?: DocumentType[];
  /** Explicit choices for this job only; empty IDs mean None. */
  documentSelection?: DocumentSelection;
  submissionAttemptId?: string;
  runId?: string;
}

export interface NeedsRequest {
  jobId: string;
  jobTitle: string;
  employer: string;
  questions: QuestionDescriptor[];
  missingDocumentTypes: DocumentType[];
  documentSelection?: DocumentSelection;
  reason: 'questions' | 'documents' | 'auth' | 'challenge' | 'ui_changed' | 'review';
  /** Optional handoff copy, e.g. how to finish a manual Quick Apply. */
  message?: string;
  createdAt: number;
}

export interface QueuePayload {
  items: QueueItem[];
  jobs: Job[];
  summary: QueueSummary;
  needs: NeedsRequest[];
}

export interface QueueSummary {
  counts: Partial<Record<JobStatus, number>>;
  total: number;
  todayCount: number;
  dailyCap: number;
  remainingToday: number;
  currentJobId?: string;
  pauseReason?: PauseReason;
}

export interface SavedSearch {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** OpenRouter model preselected for matching and page assist; needs the user's own key. */
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * Bumped when product defaults change in a way existing installs should adopt
 * once. Revision 2: full automation (Autopilot, no review step, one-click Apply,
 * saved answers used without per-answer approval, AI page assist).
 */
export const SETTINGS_DEFAULTS_REVISION = 2;

export interface Settings {
  schemaVersion: 1;
  /** Last product-defaults revision applied to these settings (absent = 1). */
  defaultsRevision?: number;
  mode: RunMode;
  host: string;
  onboardingComplete: boolean;
  search: {
    collectExternalJobs: boolean;
    savedSearches: SavedSearch[];
    activeSearchId?: string;
    maxPagesPerRun: number;
    maxJobsPerRun: number;
    minFitScore: number;
    includeKeywords: string[];
    excludeKeywords: string[];
    locations: string[];
    remoteOnly: boolean;
    employmentTypes: string[];
  };
  pacing: {
    speed: PacingSpeed;
    useAdvanced: boolean;
    scanDelayMinMs: number;
    scanDelayMaxMs: number;
    humanDelayMinMs: number;
    humanDelayMaxMs: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitterPercent: number;
    dailyCap: number;
    hardCap: number;
    sessionBatchSize: number;
    sessionBreakMinMs: number;
    sessionBreakMaxMs: number;
    /** Legacy backup field; normalized to null. Runs have no time-of-day restriction. */
    activeHours: { start: string; end: string } | null;
    maxConsecutiveFailures: number;
    maxAttemptsPerJob: number;
  };
  /**
   * Handshake document IDs the user typed or pasted (from a `/docs/<id>` link).
   * Handshook never scrapes the documents page; names are the user's own labels.
   */
  documents: {
    defaultResumeId?: string;
    defaultResumeName?: string;
    coverLetterId?: string;
    coverLetterName?: string;
    transcriptId?: string;
    transcriptName?: string;
    otherDocumentId?: string;
    otherDocumentName?: string;
    /** Up to MAX_ADDITIONAL_RESUMES extra resumes; AI matching may pick these or the default. */
    additionalResumes?: AdditionalResume[];
    autoSelectResume: boolean;
  };
  ai: {
    enabled: boolean;
    provider: 'auto' | AiProvider;
    minConfidence: number;
    /**
     * When a known control (Apply, Submit, a document field) cannot be found,
     * ask the OpenRouter model to pick it from a list of the page's control
     * labels. Needs an OpenRouter key; deterministic safety checks still apply.
     */
    pageAssist: boolean;
    /**
     * When a form question's wording differs from every saved answer, ask the
     * OpenRouter model which saved answer (by label) it asks for. Answer values
     * never leave the device; the extension fills the saved value itself.
     */
    answerAssist: boolean;
    /**
     * After the answer bank, let the model answer questions that do not depend
     * on a personal fact (how you heard, why this role) from the job posting and
     * the user's non-sensitive saved answers. Sensitive answers are never sent.
     */
    answerWrite: boolean;
    openRouter: {
      model: string | null;
      fallbackModels: string[];
      allowDataCollection: boolean;
      zeroDataRetention: boolean;
      maxPromptPricePerMillion: number | null;
    };
  };
  safety: {
    reviewBeforeSubmit: boolean;
    /** One-click actions send Handshake-profile defaults, not selected document IDs. */
    allowOneClickApply: boolean;
    allowSensitiveAutoSubmit: boolean;
    allowEeoAutoFill: boolean;
    allowFreeTextAutoFill: boolean;
    stopOnUnknownQuestion: boolean;
    verifySubmissions: boolean;
  };
  ui: {
    theme: 'system' | 'light' | 'dark';
    showAdvanced: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  defaultsRevision: SETTINGS_DEFAULTS_REVISION,
  mode: 'autopilot',
  host: 'app.joinhandshake.com',
  onboardingComplete: false,
  search: {
    collectExternalJobs: false,
    savedSearches: [],
    maxPagesPerRun: 3,
    maxJobsPerRun: 100,
    minFitScore: 0.55,
    includeKeywords: [],
    excludeKeywords: [],
    locations: [],
    remoteOnly: false,
    employmentTypes: [],
  },
  pacing: {
    ...pacingTimings(4),
    speed: 4,
    useAdvanced: false,
    dailyCap: 15,
    hardCap: 100,
    activeHours: null,
    maxConsecutiveFailures: 3,
    maxAttemptsPerJob: 2,
  },
  documents: {
    autoSelectResume: true,
  },
  ai: {
    enabled: true,
    provider: 'auto',
    minConfidence: 0.55,
    pageAssist: true,
    answerAssist: true,
    answerWrite: true,
    openRouter: {
      model: DEFAULT_OPENROUTER_MODEL,
      fallbackModels: [],
      allowDataCollection: false,
      zeroDataRetention: false,
      maxPromptPricePerMillion: null,
    },
  },
  // Click-and-forget is the default; each switch is an opt-out. A required
  // question with no saved answer still waits: Handshook never invents facts.
  safety: {
    reviewBeforeSubmit: false,
    allowOneClickApply: true,
    allowSensitiveAutoSubmit: true,
    allowEeoAutoFill: true,
    allowFreeTextAutoFill: true,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
  },
  ui: {
    theme: 'system',
    showAdvanced: false,
  },
};

/**
 * Hosts Handshook may talk to. Both Handshake regions are supported; any
 * subdomain of these apexes is valid (for example `app.joinhandshake.co.uk`).
 */
export const HANDSHAKE_APEX_DOMAINS = ['joinhandshake.com', 'joinhandshake.co.uk'] as const;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** True for a Handshake apex domain or one of its subdomains. */
export function isAllowedHandshakeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.length === 0 || normalized.length > 253) return false;
  if (normalized.includes('..')) return false;
  const labels = normalized.split('.');
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  return HANDSHAKE_APEX_DOMAINS.some(
    (apex) => normalized === apex || normalized.endsWith(`.${apex}`),
  );
}

export interface DocumentRecord {
  id: string;
  type: DocumentType;
  title: string;
  filename?: string;
  description?: string;
  updatedAt?: string;
  uploadedAt?: string;
  /** Missing on older inventories; only an explicit false prevents selection. */
  ready?: boolean;
  isDefault?: boolean;
}

/** Most additional resumes a user can save next to the default resume. */
export const MAX_ADDITIONAL_RESUMES = 5;

/** A named extra resume, identified by its Handshake document ID. */
export interface AdditionalResume {
  id: string;
  name: string;
}

export interface DocumentSelection {
  resumeId?: string;
  coverLetterId?: string;
  transcriptId?: string;
  otherDocumentId?: string;
}

export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionDescriptor {
  id: string;
  label: string;
  helpText?: string;
  type: QuestionType;
  required: boolean;
  options?: QuestionOption[];
  currentValue?: AnswerValue;
  section?: string;
  fingerprint: string;
  confidence?: number;
  suggestedAnswer?: AnswerValue;
  answerSource?: 'bank' | 'job' | 'suggested' | 'none';
}

export interface Answer {
  id: string;
  label: string;
  aliases: string[];
  type: QuestionType;
  value: AnswerValue;
  options?: Record<string, string>;
  category?: 'identity' | 'work' | 'education' | 'preferences' | 'eeo' | 'custom';
  autoSubmitAllowed: boolean;
  sensitive: boolean;
  updatedAt: number;
}

/**
 * A question Handshook met on an application form and could not answer from
 * the answer bank, kept so the user can answer it once (Settings → Answers).
 */
export interface InboxQuestion {
  /** `type|normalized label`: the same wording and type is one entry. */
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: QuestionOption[];
  section?: string;
  /** `run`: a job waited on it. `scan`: a Dry run read it from a form. */
  source: 'run' | 'scan';
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  /** Most recent jobs that asked it, newest first. */
  jobIds: string[];
}

export interface JobAnswerOverride {
  jobId: string;
  questionId: string;
  value: AnswerValue;
  createdAt: number;
}

export interface AnswerMatch {
  questionId: string;
  answerId?: string;
  value?: AnswerValue;
  confidence: number;
  source: 'job' | 'bank' | 'none';
  reason: string;
}

export type ApplyOutcome =
  | 'applied'
  | 'external'
  | 'needs_input'
  | 'ready_for_review'
  | 'verifying'
  | 'already_applied'
  | 'waiting'
  | 'failed'
  /**
   * One-click Quick Apply has no intermediate step to fill. Review mode must
   * not click it; the user is asked to submit in the Handshook tab themselves.
   */
  | 'manual_submit_required'
  /** Dry run: the page was inspected but nothing was filled or submitted. */
  | 'would_apply';

/** One-click sends do not expose or let Handshook choose the actual document IDs. */
export type DocumentsUsed = { type: DocumentType; id: string }[] | 'handshake_profile_defaults';

export interface ApplyResult {
  jobId: string;
  outcome: ApplyOutcome;
  error?: AppError;
  questions?: QuestionDescriptor[];
  missingDocumentTypes?: DocumentType[];
  confirmationText?: string;
  submittedAt?: number;
  documentsUsed?: DocumentsUsed;
}

export interface SubmissionAttempt {
  id: string;
  runId: string;
  jobId: string;
  host: string;
  startedAt: number;
  finishedAt?: number;
  /** Daily cap reservation for a confirmed or uncertain send; counted once. */
  capCountedAt?: number;
  status: 'started' | 'submitted' | 'applied' | 'failed' | 'ambiguous';
  applyType: ApplyType;
  documents: DocumentsUsed;
  questionIds: string[];
  confirmationText?: string;
  error?: AppError;
  reconciledAt?: number;
  reconciliationNote?: string;
}

export interface EngineState {
  version: 1;
  status: EngineStatus;
  mode: RunMode;
  host: string;
  runId?: string;
  startedAt?: number;
  pausedAt?: number;
  pauseReason?: PauseReason;
  currentJobId?: string;
  currentPhase?: string;
  nextActionAt?: number;
  scanComplete?: boolean;
  todayCount: number;
  dailyCap: number;
  consecutiveFailures: number;
  lastError?: AppError;
  message?: string;
  updatedAt: number;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobEvent {
  id: string;
  at: number;
  level: EventLevel;
  type: string;
  jobId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface OnboardingState {
  version: 1;
  step: 'welcome' | 'session' | 'documents' | 'answers' | 'search' | 'mode' | 'done';
  host?: string;
  sessionStatus?: 'unknown' | 'logged_in' | 'logged_out';
  answersConfigured?: boolean;
  searchConfigured?: boolean;
  completedAt?: number;
}

export interface ResumeOption {
  id: string;
  title: string;
  description: string;
}

export interface MatchInput {
  jobTitle: string;
  jobDescription: string;
  resumes: ResumeOption[];
}

export interface MatchResult {
  resumeId: string;
  confidence: number;
  reason: string;
  provider: AiProvider;
  cached?: boolean;
  modelId?: string;
}

export interface ResumeMatcher {
  id: AiProvider;
  availability(): Promise<AiAvailability>;
  match(input: MatchInput, signal?: AbortSignal): Promise<MatchResult>;
  modelId?(): Promise<string>;
}

export interface SelectorStrategy {
  name: string;
  kind: 'css' | 'text' | 'role' | 'aria' | 'label';
  description: string;
  find(root: ParentNode): Element | null;
  findAll?(root: ParentNode): Element[];
}

export interface SelectorHealth {
  at: number;
  page: 'search' | 'job' | 'modal' | 'documents' | 'my_jobs' | 'unknown';
  selector: string;
  strategy: string;
  ok: boolean;
  detail?: string;
}

export interface ScanOptions {
  searchUrl: string;
  maxPages: number;
  maxJobs: number;
  pageDelayMs: number;
}

export interface ApplyOptions {
  /** Bounded, cancellable pauses between form actions. Engine always supplies this. */
  humanDelay?: DelayRange;
  mode: RunMode;
  documents: DocumentSelection;
  documentsAvailable?: DocumentRecord[];
  answers: Answer[];
  /**
   * Answers the user explicitly supplied for this job/question (Needs You or a
   * per-job override). They may be filled even when the global auto-fill opt-ins
   * are off; submission still follows `reviewBeforeSubmit` and the auto-submit
   * opt-ins.
   */
  explicitAnswerIds?: string[];
  /** Missing on an older caller means no permission for a one-click submission. */
  allowOneClickApply?: boolean;
  allowSensitiveAutoSubmit: boolean;
  allowEeoAutoFill: boolean;
  allowFreeTextAutoFill: boolean;
  reviewBeforeSubmit: boolean;
  /** Pause on an unanswered required question instead of guessing. */
  stopOnUnknownQuestion: boolean;
  /** Look for the confirmation state before reporting an application as applied. */
  verifySubmissions: boolean;
  timeoutMs: number;
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

export type MessageResponse<T = unknown> =
  { requestId: string; ok: true; data: T } | { requestId: string; ok: false; error: AppError };

export type UiRequest =
  | { type: 'ui.engine.start'; requestId: string; mode?: RunMode }
  | { type: 'ui.engine.pause'; requestId: string; reason?: PauseReason }
  | { type: 'ui.engine.resume'; requestId: string }
  | { type: 'ui.engine.stop'; requestId: string }
  | { type: 'ui.engine.getState'; requestId: string }
  | {
      type: 'ui.queue.list';
      requestId: string;
      status?: JobStatus[];
      limit?: number;
      offset?: number;
    }
  | { type: 'ui.queue.retry'; requestId: string; jobId: string }
  | { type: 'ui.queue.skip'; requestId: string; jobId: string; reason: string }
  | { type: 'ui.queue.applyNow'; requestId: string; jobId: string }
  | { type: 'ui.answer.list'; requestId: string }
  | { type: 'ui.answer.save'; requestId: string; answer: Answer }
  | { type: 'ui.answer.delete'; requestId: string; answerId: string }
  | { type: 'ui.questions.list'; requestId: string }
  | { type: 'ui.questions.dismiss'; requestId: string; key: string }
  | {
      type: 'ui.job.answer';
      requestId: string;
      jobId: string;
      questionId: string;
      value: AnswerValue;
      remember: boolean;
    }
  | { type: 'ui.settings.get'; requestId: string }
  | { type: 'ui.settings.update'; requestId: string; patch: SettingsPatch }
  | { type: 'ui.onboarding.get'; requestId: string }
  | { type: 'ui.onboarding.update'; requestId: string; patch: Partial<OnboardingState> }
  | { type: 'ui.session.check'; requestId: string }
  | { type: 'ui.runner.focus'; requestId: string }
  | { type: 'ui.ai.status'; requestId: string }
  | { type: 'ui.ai.setKey'; requestId: string; apiKey: string }
  | { type: 'ui.ai.clearKey'; requestId: string }
  | { type: 'ui.ai.test'; requestId: string; provider: AiProvider }
  | { type: 'ui.ai.openrouter.models'; requestId: string; refresh?: boolean }
  | { type: 'ui.ai.openrouter.keyInfo'; requestId: string }
  | { type: 'ui.ai.dismissMigrationNotice'; requestId: string }
  | { type: 'ui.diagnostics.export'; requestId: string }
  | { type: 'ui.diagnostics.get'; requestId: string }
  | { type: 'ui.diagnostics.clear'; requestId: string }
  | { type: 'ui.events.list'; requestId: string; limit?: number }
  | { type: 'ui.needs.list'; requestId: string }
  | {
      type: 'ui.needs.documentsResolved';
      requestId: string;
      jobId: string;
      documents?: DocumentSelection;
    }
  | { type: 'ui.queue.documents'; requestId: string; jobId: string; documents: DocumentSelection }
  | {
      type: 'ui.migration.import';
      requestId: string;
      kind: LegacyFileKindInput;
      content: string;
    }
  | { type: 'ui.migration.export'; requestId: string; format: 'csv' | 'json' }
  | { type: 'ui.data.reset'; requestId: string; confirm: true };

export type ContentRequest =
  | { type: 'content.ping'; requestId: string }
  | { type: 'content.detectSession'; requestId: string }
  | { type: 'content.scan'; requestId: string; options: ScanOptions }
  | { type: 'content.inspectJob'; requestId: string; jobId: string }
  | { type: 'content.apply'; requestId: string; job: Job; options: ApplyOptions }
  | { type: 'content.cancel'; requestId: string; jobId: string }
  | { type: 'content.revokeSubmit'; requestId: string; jobId: string; applyRequestId: string }
  | {
      type: 'content.verifySubmission';
      requestId: string;
      jobId: string;
      host?: string;
      attemptId: string;
      timeoutMs: number;
    };

export type ContentEvent =
  | {
      type: 'content.event.progress';
      jobId?: string;
      requestId?: string;
      phase: string;
      message: string;
    }
  | { type: 'content.event.result'; jobId: string; requestId: string; result: ApplyResult }
  | { type: 'content.event.discovered'; jobs: Job[] }
  | { type: 'content.event.session'; status: 'logged_in' | 'logged_out'; host: string }
  /**
   * Selector health after a scan/apply. The content adapter may send one entry
   * or the whole `getSelectorHealth()` snapshot; the background normalizes both.
   */
  | {
      type: 'content.event.selectorHealth';
      health: SelectorHealth | readonly SelectorHealth[];
    }
  | { type: 'content.event.log'; requestId?: string; event: JobEvent };

export type Broadcast =
  | { type: 'state.changed'; state: EngineState }
  | { type: 'queue.changed'; summary: QueueSummary }
  | { type: 'event.appended'; event: JobEvent }
  | {
      type: 'needs.you';
      jobId: string;
      questions?: QuestionDescriptor[];
      missingDocumentTypes?: DocumentType[];
    }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string };

export type AutopilotInputs = {
  mode: RunMode;
  applyType: ApplyType;
  fitScore?: number;
  minFitScore: number;
  missingDocumentTypes: DocumentType[];
  unknownQuestionCount: number;
  sensitiveUnapprovedCount: number;
  dailyCapReached: boolean;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  sessionLoggedIn: boolean;
};

export interface AutopilotDecision {
  allowed: boolean;
  reasons: string[];
}

/** Handshake document IDs are short tokens; names are the user's own labels. */
export const DOCUMENT_ID_MAX_LENGTH = 64;
export const DOCUMENT_NAME_MAX_LENGTH = 120;

export const additionalResumeSchema = z.object({
  id: z.string().trim().min(1).max(DOCUMENT_ID_MAX_LENGTH),
  name: z.string().trim().min(1).max(DOCUMENT_NAME_MAX_LENGTH),
});

export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  defaultsRevision: z.number().int().min(1).optional(),
  mode: z.enum(['review', 'autopilot', 'dry_run']),
  host: z
    .string()
    .min(1)
    .refine(isAllowedHandshakeHost, 'Use a joinhandshake.com or joinhandshake.co.uk host'),
  onboardingComplete: z.boolean(),
  search: z.object({
    collectExternalJobs: z.boolean().default(false),
    savedSearches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        url: z.string(),
        enabled: z.boolean(),
        createdAt: z.number(),
        updatedAt: z.number(),
      }),
    ),
    activeSearchId: z.string().optional(),
    maxPagesPerRun: z.number().int().min(0).max(20),
    maxJobsPerRun: z.number().int().min(1).max(500),
    minFitScore: z.number().min(0).max(1),
    includeKeywords: z.array(z.string()),
    excludeKeywords: z.array(z.string()),
    locations: z.array(z.string()),
    remoteOnly: z.boolean(),
    employmentTypes: z.array(z.string()),
  }),
  pacing: z.object({
    speed: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    useAdvanced: z.boolean(),
    scanDelayMinMs: z.number().int().min(0).max(30_000),
    scanDelayMaxMs: z.number().int().min(0).max(30_000),
    humanDelayMinMs: z.number().int().min(0).max(3000),
    humanDelayMaxMs: z.number().int().min(0).max(3000),
    minDelayMs: z.number().int().min(10_000),
    maxDelayMs: z.number().int().min(10_000),
    jitterPercent: z.number().min(0).max(50),
    dailyCap: z.number().int().min(1).max(100),
    hardCap: z.number().int().min(1).max(100),
    sessionBatchSize: z.number().int().min(1).max(100),
    sessionBreakMinMs: z.number().int().min(0),
    sessionBreakMaxMs: z.number().int().min(0),
    activeHours: z.object({ start: z.string(), end: z.string() }).nullable(),
    maxConsecutiveFailures: z.number().int().min(1).max(20),
    maxAttemptsPerJob: z.number().int().min(1).max(5),
  }),
  documents: z.object({
    defaultResumeId: z.string().max(DOCUMENT_ID_MAX_LENGTH).optional(),
    defaultResumeName: z.string().max(DOCUMENT_NAME_MAX_LENGTH).optional(),
    coverLetterId: z.string().max(DOCUMENT_ID_MAX_LENGTH).optional(),
    coverLetterName: z.string().max(DOCUMENT_NAME_MAX_LENGTH).optional(),
    transcriptId: z.string().max(DOCUMENT_ID_MAX_LENGTH).optional(),
    transcriptName: z.string().max(DOCUMENT_NAME_MAX_LENGTH).optional(),
    otherDocumentId: z.string().max(DOCUMENT_ID_MAX_LENGTH).optional(),
    otherDocumentName: z.string().max(DOCUMENT_NAME_MAX_LENGTH).optional(),
    additionalResumes: z.array(additionalResumeSchema).max(MAX_ADDITIONAL_RESUMES).optional(),
    autoSelectResume: z.boolean(),
  }),
  ai: z.object({
    enabled: z.boolean(),
    provider: z.enum(['auto', 'heuristic', 'openrouter']),
    minConfidence: z.number().min(0).max(1),
    pageAssist: z.boolean(),
    answerAssist: z.boolean(),
    answerWrite: z.boolean(),
    openRouter: z
      .object({
        model: z.string().trim().min(1).nullable(),
        fallbackModels: z.array(z.string().trim().min(1)).max(2),
        allowDataCollection: z.boolean(),
        zeroDataRetention: z.boolean(),
        maxPromptPricePerMillion: z.number().finite().nonnegative().nullable(),
      })
      .refine(
        (value) =>
          new Set(value.fallbackModels).size === value.fallbackModels.length &&
          !value.fallbackModels.includes(value.model ?? ''),
        { message: 'Fallback models must be distinct and different from the selected model' },
      ),
  }),
  safety: z.object({
    reviewBeforeSubmit: z.boolean(),
    allowOneClickApply: z.boolean().default(false),
    allowSensitiveAutoSubmit: z.boolean(),
    allowEeoAutoFill: z.boolean(),
    allowFreeTextAutoFill: z.boolean(),
    stopOnUnknownQuestion: z.boolean(),
    verifySubmissions: z.boolean(),
  }),
  ui: z.object({
    theme: z.enum(['system', 'light', 'dark']),
    showAdvanced: z.boolean(),
  }),
});

export const jobSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  title: z.string(),
  employer: z.string(),
  url: z.string(),
  description: z.string(),
  location: z.string().optional(),
  employmentType: z.string().optional(),
  remote: z.boolean().optional(),
  salary: z.string().optional(),
  postedAt: z.string().optional(),
  applyType: z.enum(['quick_apply', 'handshake_form', 'external', 'unknown']),
  externalUrl: z.string().optional().transform(safeExternalUrl),
  applyStartAt: z.string().optional(),
  requiredDocumentTypes: z.array(z.enum(['resume', 'cover_letter', 'transcript', 'other'])),
  source: z.enum(['search', 'import', 'manual']),
  discoveredAt: z.number(),
  fitScore: z.number().optional(),
  fitReasons: z.array(z.string()).optional(),
});

export const answerSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  aliases: z.array(z.string()),
  type: z.enum([
    'text',
    'textarea',
    'select',
    'radio',
    'checkbox',
    'date',
    'number',
    'combobox',
    'unknown',
  ]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  options: z.record(z.string(), z.string()).optional(),
  category: z.enum(['identity', 'work', 'education', 'preferences', 'eeo', 'custom']).optional(),
  autoSubmitAllowed: z.boolean(),
  sensitive: z.boolean(),
  updatedAt: z.number(),
});

export const questionSchema = z.object({
  id: z.string(),
  label: z.string(),
  helpText: z.string().optional(),
  type: z.enum([
    'text',
    'textarea',
    'select',
    'radio',
    'checkbox',
    'date',
    'number',
    'combobox',
    'unknown',
  ]),
  required: z.boolean(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  currentValue: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional(),
  section: z.string().optional(),
  fingerprint: z.string(),
  confidence: z.number().optional(),
  suggestedAnswer: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional(),
  answerSource: z.enum(['bank', 'job', 'suggested', 'none']).optional(),
});

export const applyResultSchema = z.object({
  jobId: z.string(),
  outcome: z.enum([
    'applied',
    'external',
    'needs_input',
    'ready_for_review',
    'verifying',
    'already_applied',
    'waiting',
    'failed',
    'manual_submit_required',
    'would_apply',
  ]),
  error: appErrorSchema.optional(),
  questions: z.array(questionSchema).optional(),
  missingDocumentTypes: z
    .array(z.enum(['resume', 'cover_letter', 'transcript', 'other']))
    .optional(),
  confirmationText: z.string().optional(),
  submittedAt: z.number().optional(),
  documentsUsed: z
    .union([
      z.array(
        z.object({
          type: z.enum(['resume', 'cover_letter', 'transcript', 'other']),
          id: z.string(),
        }),
      ),
      z.literal('handshake_profile_defaults'),
    ])
    .optional(),
});

export const aiMatchSchema = z.object({
  resumeId: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});

/* -------------------------------------------------------------------------- */
/* Boundary validation                                                        */
/* -------------------------------------------------------------------------- */

export const answerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const jobStatusSchema = z.enum([
  'discovered',
  'filtered',
  'queued',
  'opening',
  'filling',
  'ready_for_review',
  'submitting',
  'verifying',
  'applied',
  'would_apply',
  'external',
  'needs_input',
  'waiting',
  'already_applied',
  'skipped',
  'failed',
  'blocked',
]);

export const pauseReasonSchema = z.enum([
  'user',
  'cap_reached',
  'active_hours',
  'auth_required',
  'rate_limited',
  'ui_changed',
  'too_many_failures',
  'tab_closed',
  'browser_restarted',
  'storage_error',
  'protocol_mismatch',
]);

export const documentTypeSchema = z.enum(['resume', 'cover_letter', 'transcript', 'other']);

export const aiProviderSchema = z.enum(['heuristic', 'openrouter']);

export const selectorHealthSchema = z.object({
  at: z.number(),
  page: z.enum(['search', 'job', 'modal', 'documents', 'my_jobs', 'unknown']),
  selector: z.string().min(1),
  strategy: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const onboardingSchema = z.object({
  version: z.literal(1),
  step: z.enum(['welcome', 'session', 'documents', 'answers', 'search', 'mode', 'done']),
  host: z.string().optional(),
  sessionStatus: z.enum(['unknown', 'logged_in', 'logged_out']).optional(),
  answersConfigured: z.boolean().optional(),
  searchConfigured: z.boolean().optional(),
  completedAt: z.number().optional(),
});

/** Patch shape accepted by `ui.settings.update`; each section is itself partial. */
export const settingsPatchSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  defaultsRevision: z.number().int().min(1).optional(),
  mode: z.enum(['review', 'autopilot', 'dry_run']).optional(),
  host: z
    .string()
    .min(1)
    .refine(isAllowedHandshakeHost, 'Use a joinhandshake.com or joinhandshake.co.uk host')
    .optional(),
  onboardingComplete: z.boolean().optional(),
  search: settingsSchema.shape.search
    .partial()
    // A full settings read supplies the migration default; an unrelated patch must not reset it.
    .extend({ collectExternalJobs: z.boolean().optional() })
    .optional(),
  pacing: settingsSchema.shape.pacing.partial().optional(),
  documents: settingsSchema.shape.documents.partial().optional(),
  ai: settingsSchema.shape.ai.partial().optional(),
  safety: settingsSchema.shape.safety
    .partial()
    .extend({ allowOneClickApply: z.boolean().optional() })
    .optional(),
  ui: settingsSchema.shape.ui.partial().optional(),
});

const requestBase = { requestId: z.string().min(1) };

/**
 * Every request the panel may send. Unknown or malformed messages are rejected
 * at the worker boundary before any handler runs.
 */
export const documentSelectionSchema = z.object({
  resumeId: z.string().optional(),
  coverLetterId: z.string().optional(),
  transcriptId: z.string().optional(),
  otherDocumentId: z.string().optional(),
});

export const uiRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ui.engine.start'),
    ...requestBase,
    mode: z.enum(['review', 'autopilot', 'dry_run']).optional(),
  }),
  z.object({
    type: z.literal('ui.engine.pause'),
    ...requestBase,
    reason: pauseReasonSchema.optional(),
  }),
  z.object({ type: z.literal('ui.engine.resume'), ...requestBase }),
  z.object({ type: z.literal('ui.engine.stop'), ...requestBase }),
  z.object({ type: z.literal('ui.engine.getState'), ...requestBase }),
  z.object({
    type: z.literal('ui.queue.list'),
    ...requestBase,
    status: z.array(jobStatusSchema).optional(),
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('ui.queue.retry'), ...requestBase, jobId: z.string().min(1) }),
  z.object({
    type: z.literal('ui.queue.skip'),
    ...requestBase,
    jobId: z.string().min(1),
    reason: z.string(),
  }),
  z.object({ type: z.literal('ui.queue.applyNow'), ...requestBase, jobId: z.string().min(1) }),
  z.object({ type: z.literal('ui.answer.list'), ...requestBase }),
  z.object({ type: z.literal('ui.answer.save'), ...requestBase, answer: answerSchema }),
  z.object({ type: z.literal('ui.answer.delete'), ...requestBase, answerId: z.string().min(1) }),
  z.object({ type: z.literal('ui.questions.list'), ...requestBase }),
  z.object({
    type: z.literal('ui.questions.dismiss'),
    ...requestBase,
    key: z.string().min(1).max(400),
  }),
  z.object({
    type: z.literal('ui.job.answer'),
    ...requestBase,
    jobId: z.string().min(1),
    questionId: z.string().min(1),
    value: answerValueSchema,
    remember: z.boolean(),
  }),
  z.object({ type: z.literal('ui.settings.get'), ...requestBase }),
  z.object({ type: z.literal('ui.settings.update'), ...requestBase, patch: settingsPatchSchema }),
  z.object({ type: z.literal('ui.onboarding.get'), ...requestBase }),
  z.object({
    type: z.literal('ui.onboarding.update'),
    ...requestBase,
    patch: onboardingSchema.partial(),
  }),
  z.object({ type: z.literal('ui.session.check'), ...requestBase }),
  z.object({ type: z.literal('ui.runner.focus'), ...requestBase }),
  z.object({ type: z.literal('ui.ai.status'), ...requestBase }),
  z.object({
    type: z.literal('ui.ai.setKey'),
    ...requestBase,
    apiKey: z.string().trim().min(1).regex(/^\S+$/),
  }),
  z.object({ type: z.literal('ui.ai.clearKey'), ...requestBase }),
  z.object({ type: z.literal('ui.ai.test'), ...requestBase, provider: aiProviderSchema }),
  z.object({
    type: z.literal('ui.ai.openrouter.models'),
    ...requestBase,
    refresh: z.boolean().optional(),
  }),
  z.object({ type: z.literal('ui.ai.openrouter.keyInfo'), ...requestBase }),
  z.object({ type: z.literal('ui.ai.dismissMigrationNotice'), ...requestBase }),
  z.object({ type: z.literal('ui.diagnostics.export'), ...requestBase }),
  z.object({ type: z.literal('ui.diagnostics.get'), ...requestBase }),
  z.object({ type: z.literal('ui.diagnostics.clear'), ...requestBase }),
  z.object({
    type: z.literal('ui.events.list'),
    ...requestBase,
    limit: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('ui.needs.list'), ...requestBase }),
  z.object({
    type: z.literal('ui.needs.documentsResolved'),
    ...requestBase,
    jobId: z.string().min(1),
    documents: documentSelectionSchema.optional(),
  }),
  z.object({
    type: z.literal('ui.queue.documents'),
    ...requestBase,
    jobId: z.string().min(1),
    documents: documentSelectionSchema,
  }),
  z.object({
    type: z.literal('ui.migration.import'),
    ...requestBase,
    kind: z.enum(['conf', 'tracker', 'rate_stats', 'backup', 'auto']),
    content: z.string(),
  }),
  z.object({
    type: z.literal('ui.migration.export'),
    ...requestBase,
    format: z.enum(['csv', 'json']),
  }),
  z.object({ type: z.literal('ui.data.reset'), ...requestBase, confirm: z.literal(true) }),
]);

/** Payload types stay usable in-process; every transport adds this envelope. */
export const protocolEnvelopeSchema = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) });
export const PROTOCOL_RELOAD_MESSAGE =
  'Handshook was updated. Reload the Handshake tab and reopen the panel before continuing.';

export function validateProtocolEnvelope(value: unknown): Result<true> {
  return protocolEnvelopeSchema.safeParse(value).success
    ? ok(true)
    : err(appError('PROTOCOL_MISMATCH', PROTOCOL_RELOAD_MESSAGE));
}

const messageIdSchema = z.string().min(1).max(200);
const wireRequestBase = { ...protocolEnvelopeSchema.shape, requestId: messageIdSchema };
const handshakeUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        isAllowedHandshakeHost(url.hostname)
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS Handshake URL');
const messageJobSchema = jobSchema
  .extend({
    id: messageIdSchema,
    host: z.string().refine(isAllowedHandshakeHost),
    url: handshakeUrlSchema,
  })
  .refine((job) => {
    try {
      return new URL(job.url).hostname === job.host;
    } catch {
      return false;
    }
  }, 'Job host must match its URL');

export const applyOptionsSchema = z.object({
  humanDelay: z
    .object({
      minMs: z.number().int().min(0).max(3000),
      maxMs: z.number().int().min(0).max(3000),
    })
    .refine((range) => range.maxMs >= range.minMs, 'Maximum delay must be at least the minimum')
    .optional(),
  mode: z.enum(['review', 'autopilot', 'dry_run']),
  documents: z.object({
    resumeId: z.string().optional(),
    coverLetterId: z.string().optional(),
    transcriptId: z.string().optional(),
    otherDocumentId: z.string().optional(),
  }),
  documentsAvailable: z
    .array(
      z.object({
        id: z.string(),
        type: documentTypeSchema,
        title: z.string(),
        description: z.string().optional(),
        filename: z.string().optional(),
        updatedAt: z.string().optional(),
        uploadedAt: z.string().optional(),
        ready: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .optional(),
  answers: z.array(answerSchema),
  explicitAnswerIds: z.array(z.string()).optional(),
  allowOneClickApply: z.boolean().optional(),
  allowSensitiveAutoSubmit: z.boolean(),
  allowEeoAutoFill: z.boolean(),
  allowFreeTextAutoFill: z.boolean(),
  reviewBeforeSubmit: z.boolean(),
  stopOnUnknownQuestion: z.boolean(),
  verifySubmissions: z.boolean(),
  timeoutMs: z.number().int().positive().max(LIMITS.applyTimeoutMs),
});

/** One allowlisted schema per command; additional commands register at the bridge. */
export const contentRequestSchemas = {
  'content.ping': z.object({ type: z.literal('content.ping'), ...wireRequestBase }),
  'content.detectSession': z.object({
    type: z.literal('content.detectSession'),
    ...wireRequestBase,
  }),
  'content.scan': z.object({
    type: z.literal('content.scan'),
    ...wireRequestBase,
    options: z.object({
      searchUrl: handshakeUrlSchema,
      maxPages: z.number().int().positive(),
      maxJobs: z.number().int().positive(),
      pageDelayMs: z.number().nonnegative(),
    }),
  }),
  'content.inspectJob': z.object({
    type: z.literal('content.inspectJob'),
    ...wireRequestBase,
    jobId: messageIdSchema,
  }),
  'content.apply': z.object({
    type: z.literal('content.apply'),
    ...wireRequestBase,
    job: messageJobSchema,
    options: applyOptionsSchema,
  }),
  'content.cancel': z.object({
    type: z.literal('content.cancel'),
    ...wireRequestBase,
    jobId: messageIdSchema,
  }),
  'content.verifySubmission': z.object({
    type: z.literal('content.verifySubmission'),
    ...wireRequestBase,
    jobId: messageIdSchema,
    host: z.string().optional(),
    attemptId: messageIdSchema,
    timeoutMs: z.number().int().positive(),
  }),
} as const;

export const contentRequestSchema = z.union([
  contentRequestSchemas['content.ping'],
  contentRequestSchemas['content.detectSession'],
  contentRequestSchemas['content.scan'],
  contentRequestSchemas['content.inspectJob'],
  contentRequestSchemas['content.apply'],
  contentRequestSchemas['content.cancel'],
  contentRequestSchemas['content.verifySubmission'],
]);

const jobEventSchema = z.object({
  id: messageIdSchema,
  at: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  type: z.string().min(1),
  jobId: messageIdSchema.optional(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const contentEventSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('content.event.progress'),
      ...protocolEnvelopeSchema.shape,
      jobId: messageIdSchema.optional(),
      requestId: messageIdSchema.optional(),
      phase: z.string().min(1),
      message: z.string(),
    }),
    z.object({
      type: z.literal('content.event.result'),
      ...wireRequestBase,
      jobId: messageIdSchema,
      result: applyResultSchema,
    }),
    z.object({
      type: z.literal('content.event.discovered'),
      ...protocolEnvelopeSchema.shape,
      jobs: z.array(messageJobSchema),
    }),
    z.object({
      type: z.literal('content.event.session'),
      ...protocolEnvelopeSchema.shape,
      status: z.enum(['logged_in', 'logged_out']),
      host: z.string().refine(isAllowedHandshakeHost),
    }),
    z.object({
      type: z.literal('content.event.selectorHealth'),
      ...protocolEnvelopeSchema.shape,
      health: z.union([selectorHealthSchema, z.array(selectorHealthSchema)]),
    }),
    z.object({
      type: z.literal('content.event.log'),
      ...protocolEnvelopeSchema.shape,
      requestId: messageIdSchema.optional(),
      event: jobEventSchema,
    }),
  ])
  .superRefine((event, context) => {
    if (event.type === 'content.event.result') {
      if (event.jobId !== event.result.jobId)
        context.addIssue({ code: 'custom', path: ['result', 'jobId'], message: 'Job mismatch' });
      if (
        event.result.outcome === 'applied' &&
        (!event.result.confirmationText?.trim() || !event.result.submittedAt)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'A confirmation and submission time are required',
        });
      }
    }
    if (
      (event.type === 'content.event.progress' && event.jobId) ||
      (event.type === 'content.event.log' && event.event.jobId)
    ) {
      if (!event.requestId)
        context.addIssue({
          code: 'custom',
          path: ['requestId'],
          message: 'The active apply request is required',
        });
    }
  });

const engineStateMessageSchema = z.object({
  version: z.literal(1),
  status: z.enum(['idle', 'scanning', 'running', 'paused', 'needs_user', 'error']),
  mode: z.enum(['review', 'autopilot', 'dry_run']),
  host: z.string(),
  runId: z.string().optional(),
  startedAt: z.number().optional(),
  pausedAt: z.number().optional(),
  pauseReason: pauseReasonSchema.optional(),
  currentJobId: z.string().optional(),
  currentPhase: z.string().optional(),
  nextActionAt: z.number().optional(),
  scanComplete: z.boolean().optional(),
  todayCount: z.number().nonnegative(),
  dailyCap: z.number().nonnegative(),
  consecutiveFailures: z.number().nonnegative(),
  lastError: appErrorSchema.optional(),
  message: z.string().optional(),
  updatedAt: z.number(),
});
const queueSummaryMessageSchema = z.object({
  counts: z.partialRecord(jobStatusSchema, z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
  todayCount: z.number().nonnegative(),
  dailyCap: z.number().nonnegative(),
  remainingToday: z.number().nonnegative(),
  currentJobId: z.string().optional(),
  pauseReason: pauseReasonSchema.optional(),
});
export const broadcastSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state.changed'),
    ...protocolEnvelopeSchema.shape,
    state: engineStateMessageSchema,
  }),
  z.object({
    type: z.literal('queue.changed'),
    ...protocolEnvelopeSchema.shape,
    summary: queueSummaryMessageSchema,
  }),
  z.object({
    type: z.literal('event.appended'),
    ...protocolEnvelopeSchema.shape,
    event: jobEventSchema,
  }),
  z.object({
    type: z.literal('needs.you'),
    ...protocolEnvelopeSchema.shape,
    jobId: messageIdSchema,
    questions: z.array(questionSchema).optional(),
    missingDocumentTypes: z.array(documentTypeSchema).optional(),
  }),
  z.object({
    type: z.literal('toast'),
    ...protocolEnvelopeSchema.shape,
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
]);

export function parseUiRequest(value: unknown): Result<UiRequest> {
  const parsed = uiRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      appError('INVALID_INPUT', 'The panel sent an invalid request', {
        details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      }),
    );
  }
  return ok(parsed.data as UiRequest);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSettings(value: unknown): Result<Settings> {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      appError('INVALID_INPUT', 'Settings are invalid', {
        details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      }),
    );
  }
  return ok(parsed.data as Settings);
}

export function parseAnswer(value: unknown): Result<Answer> {
  const parsed = answerSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      appError('INVALID_INPUT', 'Answer is invalid', {
        details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      }),
    );
  }
  return ok(parsed.data as Answer);
}

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return {
    ...base,
    ...patch,
    search: { ...base.search, ...(patch.search ?? {}) },
    pacing: { ...base.pacing, ...(patch.pacing ?? {}) },
    documents: { ...base.documents, ...(patch.documents ?? {}) },
    ai: {
      ...base.ai,
      ...(patch.ai ?? {}),
      openRouter: { ...base.ai.openRouter, ...(patch.ai?.openRouter ?? {}) },
    },
    safety: { ...base.safety, ...(patch.safety ?? {}) },
    ui: { ...base.ui, ...(patch.ui ?? {}) },
  };
}
