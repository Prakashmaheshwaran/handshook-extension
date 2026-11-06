# Frozen Contracts

**Normative source for T02 and every implementation agent.**

**1.1.0 OpenRouter amendment (2026-10-27):** the AI sections below follow the agreed
OR-1/OR-2/OR-3 contract. OR-1 owns source schemas/runtime, OR-2 owns UI, and OR-3 owns
this documentation. The former Gemini provider is supported only as migration input.

These are the shared types and message shapes for the extension. T02 implements them with Zod schemas and infers the TypeScript types. Feature agents import from `@/core/contracts` and **must not redefine them**.

If a contract is wrong or missing, write a change request in your handoff file. Integration approves and T02 (or integration) updates this document and the schemas. Do not edit contracts in a feature task.

---

## 1. Protocol and constants

```ts
export const PROTOCOL_VERSION = 1 as const;

export const STORAGE_KEYS = {
  settings: 'handshook.settings.v1',
  engine: 'handshook.engine.v1',
  onboarding: 'handshook.onboarding.v1',
  aiKeys: 'handshook.ai.keys.v1',
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

export const HOSTS = [
  'https://*.joinhandshake.com/*',
  'https://joinhandshake.com/*',
  'https://*.joinhandshake.co.uk/*',
  'https://joinhandshake.co.uk/*',
] as const;
```

---

## 2. Result and errors

```ts
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
  message: string; // user-safe, never contains secrets
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: string; // serialized, redacted; never a raw Error object
}

export function ok<T>(value: T): Result<T>;
export function err<T = never>(error: AppError): Result<T>;
```

---

## 3. Core enums

```ts
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
```

---

## 4. Job and queue

```ts
export interface Job {
  id: string; // numeric Handshake ID as string, never a number
  host: string; // e.g. app.joinhandshake.com
  title: string;
  employer: string;
  url: string; // absolute https URL
  externalUrl?: string; // validated manual employer link; never used by the runner
  description: string; // plain text, sanitized, truncated for storage if huge
  location?: string;
  employmentType?: string; // Job, Internship, etc.
  remote?: boolean;
  salary?: string;
  postedAt?: string; // ISO if known
  applyType: ApplyType;
  applyStartAt?: string; // ISO
  requiredDocumentTypes: DocumentType[];
  source: 'search' | 'import' | 'manual';
  discoveredAt: number; // epoch ms
  fitScore?: number; // 0..1
  fitReasons?: string[];
}

export interface QueueItem {
  jobId: string;
  status: JobStatus;
  priority: number; // higher first
  attempts: number;
  addedAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  lastError?: AppError;
  pendingQuestionIds?: string[];
  missingDocumentTypes?: DocumentType[];
  documentSelection?: DocumentSelection; // overrides only this job; never changes defaults
  submissionAttemptId?: string;
  runId?: string;
}

export interface QueueSummary {
  counts: Record<JobStatus, number>;
  total: number;
  todayCount: number;
  dailyCap: number;
  remainingToday: number;
  currentJobId?: string;
  pausedReason?: PauseReason;
}
```

**Dedup key:** `${job.id}` is globally unique across school hosts in practice; still store `host` and treat `${host}:${id}` as the logical key in UI/tracking.

---

## 5. Settings

```ts
export interface SavedSearch {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  schemaVersion: 1;
  /** Last product-defaults revision applied to these settings (absent = 1). */
  defaultsRevision?: number;
  mode: RunMode;
  host: string;
  onboardingComplete: boolean;

  search: {
    savedSearches: SavedSearch[];
    activeSearchId?: string;
    maxPagesPerRun: number; // default 3
    maxJobsPerRun: number; // default 100
    minFitScore: number; // default 0.55
    includeKeywords: string[];
    excludeKeywords: string[];
    locations: string[];
    remoteOnly: boolean;
    employmentTypes: string[];
    collectExternalJobs: boolean; // default false; manual beta list only
  };

  pacing: {
    speed: 1 | 2 | 3 | 4 | 5; // default 4 (Faster, 32–40/hour)
    useAdvanced: boolean; // default false; otherwise derive timings from speed
    minDelayMs: number; // default 63_000
    maxDelayMs: number; // default 73_000
    jitterPercent: number; // default 20
    dailyCap: number; // default 15 for new installs; existing caps survive migration
    hardCap: number; // default 100
    sessionBatchSize: number; // default 10
    sessionBreakMinMs: number; // default 120_000
    sessionBreakMaxMs: number; // default 240_000
    scanDelayMinMs: number; // default 4_000
    scanDelayMaxMs: number; // default 10_000
    humanDelayMinMs: number; // default 300
    humanDelayMaxMs: number; // default 900
    activeHours: { start: string; end: string } | null; // legacy backup field; always normalized to null
    maxConsecutiveFailures: number; // default 3
    maxAttemptsPerJob: number; // default 2
  };

  /**
   * Handshake document IDs the user typed or pasted from a `/docs/<id>` link.
   * Handshook never scrapes the documents page; names are the user's own labels.
   * A cleared field is `''` (and no additional resumes is `[]`), because settings patches
   * cross extension messaging, which drops `undefined` keys; an invalid ID is never persisted.
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
    additionalResumes?: AdditionalResume[]; // max MAX_ADDITIONAL_RESUMES
    autoSelectResume: boolean; // default true
  };

  ai: {
    enabled: boolean; // default true
    provider: 'auto' | AiProvider; // default "auto"
    minConfidence: number; // default 0.55
    /**
     * When a known control (Apply, Submit, a document field) cannot be found,
     * ask the model to pick it from a list of the page's control labels. Needs
     * an OpenRouter key; deterministic safety checks still apply.
     */
    pageAssist: boolean; // default true
    openRouter: {
      model: string | null; // default DEFAULT_OPENROUTER_MODEL
      fallbackModels: string[]; // default []; max 2, distinct, not equal to model
      allowDataCollection: boolean; // default false
      zeroDataRetention: boolean; // default false
      maxPromptPricePerMillion: number | null; // default null; USD per 1M input tokens
    };
  };

  safety: {
    reviewBeforeSubmit: boolean; // default false; true is the Review opt-out
    allowOneClickApply: boolean; // default true; accepts Handshake-profile default files
    allowSensitiveAutoSubmit: boolean; // default true
    allowEeoAutoFill: boolean; // default true
    allowFreeTextAutoFill: boolean; // default true
    stopOnUnknownQuestion: boolean; // default true
    verifySubmissions: boolean; // default true
  };

  ui: {
    theme: 'system' | 'light' | 'dark';
    showAdvanced: boolean;
  };
}

export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const SETTINGS_DEFAULTS_REVISION = 2;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  defaultsRevision: SETTINGS_DEFAULTS_REVISION,
  mode: 'autopilot',
  host: 'app.joinhandshake.com',
  onboardingComplete: false,
  search: {
    savedSearches: [],
    maxPagesPerRun: 3,
    maxJobsPerRun: 100,
    minFitScore: 0.55,
    includeKeywords: [],
    excludeKeywords: [],
    locations: [],
    remoteOnly: false,
    employmentTypes: [],
    collectExternalJobs: false,
  },
  pacing: {
    speed: 4,
    useAdvanced: false,
    minDelayMs: 63_000,
    maxDelayMs: 73_000,
    jitterPercent: 20,
    dailyCap: 15,
    hardCap: 100,
    sessionBatchSize: 10,
    sessionBreakMinMs: 120_000,
    sessionBreakMaxMs: 240_000,
    scanDelayMinMs: 4_000,
    scanDelayMaxMs: 10_000,
    humanDelayMinMs: 300,
    humanDelayMaxMs: 900,
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
```

`ui.settings.update` takes a **deep partial** patch. T02 defines `SettingsPatch` (Zod deep partial) and merges with defaults, validating the result.

**Defaults revision (ADR-020).** `SETTINGS_DEFAULTS_REVISION` is 2.
`needsAutomationDefaults(raw)` is true when a stored settings object has no
`defaultsRevision` or one below 2. `upgradeStoredSettings` then applies these once:
`mode` stays `dry_run` if it was explicit, otherwise `review` becomes `autopilot`;
`reviewBeforeSubmit` becomes false; `allowOneClickApply`, `allowSensitiveAutoSubmit`,
`allowEeoAutoFill`, `allowFreeTextAutoFill`, `ai.enabled` and `ai.pageAssist` become
true; a missing model becomes `DEFAULT_OPENROUTER_MODEL` (null when that ID is already a
fallback, which would fail validation); and `defaultsRevision` becomes 2. Invalid
stored rows are dropped rather than failing the whole object. Later saves keep the
user's choices, including turning any of these off.

Legacy default timing upgrades to the Faster (32–40/hour) preset while customized timing enables Advanced.
Existing daily caps remain unchanged, including 25 for sparse legacy settings. Missing
external-link collection migrates to false; unrelated partial search patches preserve
an explicit preference. External links appear in Beta settings.

The run-scoped pacing session checkpoints the scan cursor, internal jobs and external
evidence before each page wait. External links never consume the internal job limit,
enter scoring, or become automation targets, even after worker suspension.

The OpenRouter API key is **not** part of `Settings`. It lives only in `handshook.ai.keys.v1`:

```ts
export interface AiKeys {
  openRouterApiKey?: string;
}
```

Restrict `chrome.storage.local` to trusted extension contexts before key access.
The key is unencrypted locally, never returned to the UI/content scripts, and never
exported/logged. Redact exact configured keys and `sk-or-` patterns.

**Migration on settings load and backup import:** map provider `gemini` to
`openrouter`, delete any stored `geminiApiKey` (never reuse/import it), and fill a
missing `ai.openRouter` with defaults. When a Gemini configuration existed, persist
`handshook.ai.migration.v1 = { geminiReplaced: true, notified: false }` for a one-time
notice. Dismissing it marks it notified; subsequent loads must not re-arm the notice.
Old backups with provider `gemini` import cleanly. Cloud matching then needs a new
OpenRouter key, model selection, and optional host grant.

---

## 6. Documents

```ts
export interface DocumentRecord {
  id: string; // Handshake document ID the user entered
  type: DocumentType;
  title: string; // the user's name, or '' when only an ID is known
  filename?: string;
  description?: string; // optional user-provided summary for AI resume matching
  updatedAt?: string; // ISO if available
  uploadedAt?: string; // display date or ISO
  ready?: boolean; // Explicit false is listed but cannot be selected; absent is legacy-compatible
  isDefault?: boolean;
}

export interface DocumentSelection {
  resumeId?: string;
  coverLetterId?: string;
  transcriptId?: string;
  otherDocumentId?: string;
}

export const MAX_ADDITIONAL_RESUMES = 5;

export interface AdditionalResume {
  id: string;
  name: string; // required label the user typed
}

export const DOCUMENT_ID_MAX_LENGTH = 64;
export const DOCUMENT_NAME_MAX_LENGTH = 120;
```

**Manual entry is the only source.** `parseHandshakeDocumentId(input)` accepts a
bare ID (`[A-Za-z0-9_-]{1,64}`) or a link on a Handshake host whose path contains
`/docs/<id>` or `/documents/<id>`, and returns the ID or `null`. Settings save the
parsed ID and never an invalid one; clearing a settings field stores `undefined`.
`configuredDocuments(settings.documents, override?)` builds the available list in
order: default resume (`isDefault: true`), additional resumes (max 5), then cover
letter, transcript, and other. IDs present only in a per-job `override` are included
with `title: ''` so the explicit choice can be validated. `documentLabel(record)`
returns the user's name or `Document <id>`. `aiResumeCandidates(documents)` returns
every configured resume record.

Explicit IDs require an exact ID/type match. `documentsAvailable` is the configured
list, not proof of the page's selected files; the adapter verifies each selected
control by ID. An empty ID means **None** and survives JSON transport; an omitted
optional attachment also means no choice. Required cover letter/transcript/other
fields wait in Needs You until the user enters an ID, even if an uploaded file of
that type exists. Per-job choices override settings and a job resume bypasses AI.
When a name is empty, never type into a search picker and never match an option by
title; match by ID only.

Handshook keeps no cached document list, collection request, or freshness timestamp: it
never reads, lists, or refreshes the documents page. The UI opens that page through
`handshakeLinks(settings.host).documents` in a normal new tab. `ui.queue.documents`
validates and saves per-job choices without resuming; `ui.needs.documentsResolved`
accepts optional choices, revalidates required files against the configured IDs, and
resumes only through the existing runner/replay/recovery guards. One-click Apply still
sends the Handshake-profile defaults (see `QUICK_APPLY_DOCUMENTS_HELP`).

---

## 7. Questions and answers

```ts
export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionDescriptor {
  id: string; // sha256(normalizedLabel + type + optionLabels)
  label: string;
  helpText?: string;
  type: QuestionType;
  required: boolean;
  options?: QuestionOption[];
  currentValue?: AnswerValue;
  section?: string;
  fingerprint: string;
  confidence?: number; // 0..1 for matched answer
  suggestedAnswer?: AnswerValue;
  answerSource?: 'bank' | 'job' | 'suggested' | 'none';
}

export interface Answer {
  id: string; // canonical key, e.g. "work_authorization"
  label: string;
  aliases: string[];
  type: QuestionType;
  value: AnswerValue;
  options?: Record<string, string>; // label (normalized) -> option value
  category?: 'identity' | 'work' | 'education' | 'preferences' | 'eeo' | 'custom';
  autoSubmitAllowed: boolean; // explicit user opt-in; default false for sensitive
  sensitive: boolean;
  updatedAt: number;
}

export interface JobAnswerOverride {
  jobId: string;
  questionId: string;
  value: AnswerValue;
  createdAt: number;
}
```

**Sensitive categories** (policy, not schema): work authorization, sponsorship, felony/background, veteran status, disability, gender, race/ethnicity, date of birth, SSN, salary expectations. Sensitive answers default `autoSubmitAllowed: false`.

**Answer matching result:**

```ts
export interface AnswerMatch {
  questionId: string;
  answerId?: string;
  value?: AnswerValue;
  confidence: number; // 0..1
  source: 'job' | 'bank' | 'none';
  reason: string;
}
```

---

## 8. Apply results and submissions

```ts
export type ApplyOutcome =
  | 'applied'
  | 'would_apply'
  | 'manual_submit_required'
  | 'verifying'
  | 'external'
  | 'needs_input'
  | 'ready_for_review'
  | 'already_applied'
  | 'waiting'
  | 'failed';

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
  id: string; // uuid
  runId: string;
  jobId: string;
  host: string;
  startedAt: number;
  finishedAt?: number;
  capCountedAt?: number; // durable once-only reservation for confirmed/uncertain sends
  status: 'started' | 'submitted' | 'applied' | 'failed' | 'ambiguous';
  applyType: ApplyType;
  documents: DocumentsUsed;
  questionIds: string[];
  confirmationText?: string;
  error?: AppError;
  reconciledAt?: number;
  reconciliationNote?: string;
}
```

---

## 9. Engine state and events

```ts
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
  currentPhase?: string; // "scanning" | "opening" | "filling" | "submitting" | ...
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
  type: string; // "job.applied", "selector.miss", "engine.paused", ...
  jobId?: string;
  message: string;
  data?: Record<string, unknown>; // redacted before persistence
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
```

---

## 10. AI contracts

```ts
export interface ResumeOption {
  id: string;
  title: string;
  description: string;
}

export interface MatchInput {
  jobTitle: string;
  jobDescription: string; // plain text, truncated by caller
  resumes: ResumeOption[];
}

export interface MatchResult {
  resumeId: string;
  confidence: number; // 0..1
  reason: string;
  provider: AiProvider;
  cached?: boolean;
  modelId?: string; // actual responding model for provider-aware cache identity
}

export interface ResumeMatcher {
  id: AiProvider;
  availability(): Promise<AiAvailability>;
  match(input: MatchInput, signal?: AbortSignal): Promise<MatchResult>;
  modelId?(): Promise<string>;
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

export interface AiTestResult {
  provider: AiProvider;
  ok: boolean;
  message: string;
  model?: string; // model that actually answered
  costUsd?: number;
}
```

**Page assist (apply-time control lookup).** The content script asks the background to
pick a control that the deterministic selectors missed. The model may only choose an
index from the list it is given; it never supplies a selector, answer, document, or code.

```ts
export const PAGE_ASSIST_TARGETS = [
  'applyButton',
  'submitButton',
  'resumeField',
  'coverLetterField',
  'transcriptField',
  'otherDocumentField',
] as const;
export type PageAssistTarget = (typeof PAGE_ASSIST_TARGETS)[number];
export type PageAssistScope = 'job' | 'dialog';

export const PAGE_ASSIST_MAX_CANDIDATES = 80;
export const PAGE_ASSIST_TEXT_MAX = 120;
export const PAGE_ASSIST_ATTRIBUTES = [
  'aria-haspopup',
  'aria-expanded',
  'aria-label',
  'data-hook',
  'data-testid',
  'data-kind',
  'data-variant',
  'data-size',
  'name',
] as const;

export interface PageAssistCandidate {
  index: number; // 0-based position in the submitted list
  tag: string;
  role?: string;
  type?: string;
  name: string; // accessible name, <= 120 chars
  text?: string; // visible text, <= 120 chars
  placeholder?: string;
  context?: string; // nearest label, legend, or heading
  attributes: Partial<Record<(typeof PAGE_ASSIST_ATTRIBUTES)[number], string>>;
  inDialog: boolean;
  disabled: boolean;
}

export interface PageAssistRequest {
  type: 'engine.pageAssist';
  requestId: string;
  jobId: string;
  applyRequestId: string; // the exact in-flight apply attempt
  target: PageAssistTarget;
  scope: PageAssistScope;
  candidates: PageAssistCandidate[]; // 1..80
}

export interface PageAssistAnswer {
  index: number | null; // candidate index, or null when nothing safely matches
  source: 'learned' | 'ai' | 'none';
  confidence?: number; // 0..1
}
```

`ApplyControl.pageAssist?(query)` accepts `Pick<PageAssistRequest, 'target' | 'scope' |
'candidates'>` and resolves `PageAssistAnswer | null`; `null` means the query failed,
timed out, the setting is off, or no candidate is safe. Rules:

- The request is bound to the exact job and apply request. It is rejected if either does
  not match the active attempt.
- Candidates carry no field values, answers, document contents, `href`s, or URLs, and no
  attribute outside `PAGE_ASSIST_ATTRIBUTES`.
- The response index is validated against the submitted list; anything else is `null`.
  A confidence below `PAGE_ASSIST_MIN_CONFIDENCE` (0.7) also resolves to `null`.
- The content script vetoes destructive or out-of-scope controls (withdraw, delete,
  remove, cancel, upload, close/back, sign out, save, share, preview, and similar, or a
  control outside its target's expected location) before acting, and runs its normal
  post-action and pre-submit verification afterwards.
- A model pick is stored locally (up to three tag/role/name/attribute signatures per host
  and target) and tried before any network request, returned with `source: 'learned'`.
  Learned locators are local records, never part of an AI prompt, and every safety rule is
  re-applied to a learned match.
- Requests are bounded at 20 seconds from the background to the provider.
- Page assist does not change any submit gate: it can only name a control that the
  existing flow then uses.

**Application document selection:** the engine invokes matching only when both
`ai.enabled` and `documents.autoSelectResume` are true and there is no per-job resume
override. Candidates are `aiResumeCandidates(configuredDocuments(...))` — the default
resume plus any additional resumes the user entered. The default is kept if no
confident match exists, and the configured document list goes to the application
adapter for exact selection and Quick apply checks. The matcher API itself retains
its AI-off heuristic behavior for callers/tests.

**Provider order:** `AiProvider` is only `heuristic | openrouter`. `auto` tries
OpenRouter only with a key, selected model, and current permission, then falls back
to heuristic. Explicit provider failures fall back to heuristic without failing
the job; cancellation still stops the operation/application work. Matching and page
assist share the same key, model, fallbacks, and routing settings;
`DEFAULT_OPENROUTER_MODEL` (`deepseek/deepseek-v4.1-flash`) is preselected, and page
assist also requires `ai.pageAssist`.

**Validation rules:** strip optional Markdown fences from the response, then require
JSON with only `resumeId`, `confidence`, and `reason`. The ID must belong to
`input.resumes`, confidence must be 0–1, and reason at most 500 characters. The existing
`src/ai/validate.ts` allowlist is authoritative; reject invalid content and sanitize
provider explanations before caching or broadcasting.

**OpenRouter transport and routing (OR-1 implementation contract):**

- Only the optional origin `https://openrouter.ai/*`; remove the former Google origin.
  Request from a panel user gesture and re-check the grant immediately before every
  models/key/chat request, including retries and after pacing waits. No cloud matching
  traffic unless OpenRouter is active; explicit catalog/key/test actions also require
  permission. Catalog autoload additionally requires enabled Auto/OpenRouter settings;
  disabled/local-only settings use an explicit **Load models** action. No job/resume data
  in catalog/key lookups.
- Chat POST `/api/v1/chat/completions`: `Authorization: Bearer <key>` and JSON content
  type; optional fixed `X-OpenRouter-Title: Handshook`, never `HTTP-Referer`. Omit
  cookies/referrers and reject redirects. Send system/user messages from
  `src/ai/prompts.ts`, `temperature: 0`, `max_tokens` about 400, and `stream: false`.
- Send the selected `model`. If fallbacks exist, also send
  `models: [model, ...fallbackModels]` and `route: 'fallback'`; each model can bill
  at its own price. Never invent replacements or silently relax routing controls.
- `provider.data_collection` is `allow` only when `allowDataCollection` is true,
  otherwise `deny`. Add `provider.zdr: true` only for `zeroDataRetention`; add
  `provider.max_price.prompt` in USD per million tokens when the prompt cap is set.
  This is not a completion-price or total-spend limit.
- For `structured_outputs` support, use strict `response_format` JSON schema and
  `provider.require_parameters: true`. Otherwise use `{ type: 'json_object' }` for
  `response_format` support; otherwise omit the format and request JSON in the prompt.
- Inspect top-level `error` even on HTTP 200 and validate the returned content. Map
  invalid key, out of credits, unavailable/expired model, privacy-filter exclusion,
  moderation, rate limit, and timeout to actionable `openRouterMessage` text. Never
  echo raw provider error bodies or credentials.
- Preserve HX-06's bounded timeout/AbortSignal, shared request pacing, and bounded
  backoff. Honor bounded `Retry-After` on 429; use heuristic fallback on errors.
- Bound response bodies while reading: 64 KiB for chat/key, 8 MiB for catalog;
  cancel an oversized or aborted stream. Chat content is at most 16,384 characters,
  incoming model IDs 256, key labels 512, and choices four. Resume output remains
  constrained by the stricter allowlist/reason rules above.
- Cache identity includes provider `openrouter`, the actual `response.model`, prompt
  version, job input, and resume-set fingerprint. Do not cache under a model that
  did not answer or share cloud results with heuristic-only matching.
- Models GET `/api/v1/models?output_modalities=text`: Bearer key when configured,
  text-output catalog only, cache in IndexedDB meta for 24 hours; refresh bypasses
  cache. API price strings are USD **per token**; multiply by 1,000,000 for summaries.
  Preserve free variants as distinct IDs and expose expiration dates/capabilities.
  Accept at most 5,000 catalog entries, with IDs up to 256 characters, names 512 and
  expiration text 64. Missing, negative/variable or overflowing prices are unknown;
  displayed estimates never use NaN/infinity. Re-redact cached catalog text on read.
- Key GET `/api/v1/key`: return only the `OpenRouterKeyInfo` projection, including
  `free_model_daily_requests.remaining` when present, never the key itself.

---

## 11. Selector strategies and health

```ts
export type SelectorKind = 'css' | 'text' | 'role' | 'aria' | 'label';

export interface SelectorStrategy {
  name: string; // stable identifier for health metrics
  kind: SelectorKind;
  description: string;
  find(root: ParentNode): Element | null;
  findAll?(root: ParentNode): Element[];
}

export interface SelectorHealth {
  at: number;
  page: 'search' | 'job' | 'modal' | 'documents' | 'my_jobs' | 'unknown';
  selector: string; // strategy group, e.g. "apply.button"
  strategy: string; // winning strategy name
  ok: boolean;
  detail?: string;
}
```

Feature adapters own their `selectors/*.ts` files. T08 owns the generic DOM helpers and the selector-health reporter.

---

## 12. Message protocol

Transport messages carry `protocolVersion: PROTOCOL_VERSION` and are validated with
Zod; the payload types below remain usable in-process without that envelope. Requests
carry `requestId`, and responses echo it; broadcasts have no request ID. Apply request
IDs equal the persisted submission-attempt ID, including later Review/progress events.
Content events/RPCs require this extension, an allowed HTTPS top-level sender, and
exact restored runner/job/run/attempt provenance for apply-related operations. Stale
protocols fail visibly with reload guidance; no unfinished form is reloaded automatically.

### 12.1 Shared response

```ts
export type MessageResponse<T = unknown> =
  { requestId: string; ok: true; data: T } | { requestId: string; ok: false; error: AppError };
```

### 12.2 UI → background

```ts
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
  | {
      type: 'ui.job.answer';
      requestId: string;
      jobId: string;
      questionId: string;
      value: AnswerValue;
      remember: boolean;
    }
  | { type: 'ui.queue.documents'; requestId: string; jobId: string; documents: DocumentSelection }
  | {
      type: 'ui.needs.documentsResolved';
      requestId: string;
      jobId: string;
      documents?: DocumentSelection;
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
  | { type: 'ui.diagnostics.clear'; requestId: string }
  | { type: 'ui.data.reset'; requestId: string; confirm: true };
```

AI RPCs above remain panel-only and Zod-validated:

| Request                        | Result / behavior                                                                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.ai.status`                 | Retain existing fields; replace `geminiConfigured` with `openRouterConfigured: boolean` and `geminiMessage` with optional `openRouterMessage: string`. Add `openRouterPermission: 'granted' \| 'not_granted'` and `geminiReplacedNotice: boolean`. Never return a key. |
| `ui.ai.setKey`                 | Same request name, now OpenRouter: trim, reject empty/whitespace-containing keys, warn but do not reject an unfamiliar prefix other than `sk-or-`.                                                                                                                     |
| `ui.ai.clearKey`               | Remove the saved OpenRouter key and clear provider status.                                                                                                                                                                                                             |
| `ui.ai.test`                   | For `openrouter`, one tiny fictional matching request using the selected model/settings, returning `AiTestResult` including actual model/cost when available.                                                                                                          |
| `ui.ai.openrouter.models`      | `{ models: OpenRouterModelSummary[]; fetchedAt: number }`; clear error if host permission is not granted.                                                                                                                                                              |
| `ui.ai.openrouter.keyInfo`     | `OpenRouterKeyInfo`; requires the current grant and configured key.                                                                                                                                                                                                    |
| `ui.ai.dismissMigrationNotice` | `{ dismissed: true }`; persist notice dismissal.                                                                                                                                                                                                                       |

### 12.3 Background → content

```ts
export interface ScanOptions {
  searchUrl: string;
  maxPages: number;
  maxJobs: number;
  pageDelayMs: number;
}

export interface ApplyOptions {
  humanDelay?: { minMs: number; maxMs: number }; // 0..3000, cancellable; validated at the content boundary
  mode: RunMode;
  documents: DocumentSelection;
  documentsAvailable?: DocumentRecord[];
  answers: Answer[];
  explicitAnswerIds?: string[];
  allowOneClickApply?: boolean; // omitted = false, preserved by the wire schema
  allowSensitiveAutoSubmit: boolean;
  allowEeoAutoFill: boolean;
  allowFreeTextAutoFill: boolean;
  reviewBeforeSubmit: boolean;
  stopOnUnknownQuestion: boolean;
  verifySubmissions: boolean; // extended confirmation wait; evidence is always required
  timeoutMs: number;
}

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
      attemptId: string;
      timeoutMs: number;
    };
```

`content.revokeSubmit` registers its schema through `registerContentCommand`. The
content-to-background RPC `engine.authorizeSubmit` registers through `registerContentRpc`
with `{ type, requestId, jobId, applyRequestId }`; its versioned response contains
`data: { authorized: boolean }`. A current grant for the exact active attempt is required
immediately before every automatic submitting click. Missing/malformed/expired/version-
mismatched grants deny submission, and local cancellation/revocation is rechecked after
the grant arrives. Source schemas live in `src/core/contracts/submitAuthorization.ts`.

### 12.4 Content → background events

```ts
export type ContentEvent =
  | {
      type: 'content.event.progress';
      requestId?: string;
      jobId?: string;
      phase: string;
      message: string;
    }
  | { type: 'content.event.result'; requestId: string; jobId: string; result: ApplyResult }
  | { type: 'content.event.discovered'; jobs: Job[] }
  | { type: 'content.event.session'; status: 'logged_in' | 'logged_out'; host: string }
  | { type: 'content.event.selectorHealth'; health: SelectorHealth | SelectorHealth[] }
  | { type: 'content.event.log'; requestId?: string; event: JobEvent };
```

Job-scoped progress/log events require the original apply request ID on the wire.
An `applied` Review result requires a timestamp and positive confirmation evidence;
settlement and cap accounting are persistent/idempotent. Apply responses carry Needs You
data directly, rather than separate `needsInput`/`scanComplete` events.

### 12.5 Background → side panel broadcasts

```ts
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
```

### 12.6 Error responses

Unknown message → `{ ok: false, error: { code: "UNSUPPORTED_MESSAGE", ... } }`.
Validation failure → `INVALID_INPUT` with Zod issue paths in `details` (no values).
Protocol mismatch → `PROTOCOL_MISMATCH`; UI shows "Reload extension".

---

## 13. Storage schema

### 13.1 IndexedDB version 1

| Store         | Key path | Indexes                                                                           |
| ------------- | -------- | --------------------------------------------------------------------------------- |
| `jobs`        | `id`     | `byHost` (host), `byDiscoveredAt` (discoveredAt), `byApplyType` (applyType)       |
| `queue`       | `jobId`  | `byStatus` (status), `byUpdatedAt` (updatedAt), `byNextAttemptAt` (nextAttemptAt) |
| `events`      | `id`     | `byAt` (at), `byJobId` (jobId), `byLevel` (level)                                 |
| `answers`     | `id`     | `byUpdatedAt` (updatedAt), `bySensitive` (sensitive)                              |
| `documents`   | `id`     | `byType` (type)                                                                   |
| `aiCache`     | `key`    | `byCreatedAt` (createdAt)                                                         |
| `submissions` | `id`     | `byJobId` (jobId), `byCreatedAt` (startedAt)                                      |
| `meta`        | `key`    | —                                                                                 |

`meta` keys: `schemaVersion`, `installId`, `lastReconcileAt`, `lastMigrationAt`.

### 13.2 Daily counters

Do not store a single `todayCount` as the source of truth. Store daily counts keyed by local date in `meta` (e.g. `dailyCount:2026-10-25`) and derive `EngineState.todayCount`. Reset logically at local midnight; prune counters older than 60 days.

---

## 14. Confidence and gating rules

```ts
export interface AutopilotDecision {
  allowed: boolean;
  reasons: string[]; // user-facing, max 5
}

export interface AutopilotInputs {
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
}
```

`allowed` is true only if **all** hold:

- mode is `autopilot`
- applyType is `quick_apply` or `handshake_form`
- fitScore is defined and `>= minFitScore` (or minFitScore is 0)
- no missing documents
- `unknownQuestionCount === 0`
- `sensitiveUnapprovedCount === 0`
- daily cap not reached
- `consecutiveFailures < maxConsecutiveFailures`
- session logged in

Otherwise the job goes to review/needs-input. This function is pure and unit-tested in T12/T25.

`safety.reviewBeforeSubmit` is not a precondition for automation: it is the Review
opt-out, and when true a job that passes the gate stops at `ready_for_review` instead of
clicking Submit. `safety.allowOneClickApply`, `allowSensitiveAutoSubmit`,
`allowEeoAutoFill`, `allowFreeTextAutoFill`, and `stopOnUnknownQuestion` are checked by
their own paths. AI page assist never changes `allowed`; it can only change which
control a later step acts on, and its pick is still subject to every check here.

---

## 15. What not to put in contracts

- DOM selectors (feature-owned)
- React components or UI state
- Provider-specific request bodies
- Secrets
- Raw HTML
- Python config shapes (the migration layer converts into these contracts)

---

## 16. Change protocol

1. Feature agent writes `extension/.handoffs/<TASK_ID>.md` with the proposed change and why.
2. Integration reviews against architecture and security.
3. If approved, integration updates this file and `src/core/contracts/**` (or asks T02's owner if still active).
4. Feature agent rebases/rebuilds against the new contract. No parallel agent may edit contracts.
