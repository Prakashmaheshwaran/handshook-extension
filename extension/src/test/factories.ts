/**
 * Deterministic test factories.
 *
 * Every factory takes `(overrides, index)`. The `index` seeds IDs and timestamps so
 * the same call always produces the same object — no `Date.now()` or `Math.random()`
 * inside a test run, no snapshot churn. Use the index to build related objects that
 * share IDs (e.g. `makeJob({}, 3)` and `makeQueueItem({}, 3)` both use job `900003`).
 *
 * Import from feature tests with `@/test/factories`. E2E helpers import this module
 * by relative path (Playwright resolves `@/` inconsistently across versions).
 */

import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Answer,
  type AppError,
  type DocumentRecord,
  type EngineState,
  type ErrorCode,
  type Job,
  type JobEvent,
  type JobStatus,
  type QuestionDescriptor,
  type QueueItem,
  type Settings,
  type SettingsPatch,
  type EventLevel,
} from '../core/contracts';

/** Fixed "now" for the whole suite: 2026-01-15T12:00:00.000Z. */
export const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Fixed ISO timestamp matching {@link FIXED_NOW}. */
export const FIXED_ISO = new Date(FIXED_NOW).toISOString();

/** Offset from {@link FIXED_NOW} in milliseconds. */
export function makeTimestamp(offsetMs = 0): number {
  return FIXED_NOW + offsetMs;
}

/** ISO timestamp offset from {@link FIXED_NOW} in milliseconds. */
export function makeIsoTimestamp(offsetMs = 0): string {
  return new Date(makeTimestamp(offsetMs)).toISOString();
}

/** Numeric-looking Handshake job ID for an index (1 -> "900001"). */
export function makeJobId(index = 1): string {
  assertIndex(index);
  return String(900_000 + index);
}

/** Stable prefixed identifier for an index (1 -> "answer-0001"). */
export function makeId(prefix: string, index = 1): string {
  assertIndex(index);
  return `${prefix}-${String(index).padStart(4, '0')}`;
}

/**
 * Settings built from the frozen contract defaults with a one-level-deep patch.
 * The contract defaults are full automation: `mode: 'autopilot'`, safety switches
 * on, `ai.enabled` and `ai.pageAssist` on. A test that needs Review mode must pass
 * `{ mode: 'review' }` (and `safety.reviewBeforeSubmit: true`) explicitly.
 * `DEFAULT_SETTINGS.onboardingComplete` is `false`; onboarding scenarios should
 * pass `{ onboardingComplete: true }`.
 */
export function makeSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

/** A sanitized job. Default URL always follows the resolved ID. */
export function makeJob(overrides: Partial<Job> = {}, index = 1): Job {
  const id = overrides.id ?? makeJobId(index);
  const job: Job = {
    id,
    host: 'app.joinhandshake.com',
    title: `Software Engineering Intern ${index}`,
    employer: `Sample Employer ${index}`,
    url: `https://app.joinhandshake.com/jobs/${id}`,
    description:
      'Build and ship features with a small team. This is sanitized fixture text used for tests only.',
    location: 'Remote',
    employmentType: 'Internship',
    remote: true,
    applyType: 'quick_apply',
    requiredDocumentTypes: ['resume'],
    source: 'search',
    discoveredAt: makeTimestamp(index * 1_000),
  };

  const merged: Job = { ...job, ...overrides };
  return { ...merged, url: overrides.url ?? `https://app.joinhandshake.com/jobs/${merged.id}` };
}

/** A queue entry. Defaults to the same job ID as {@link makeJob} for the same index. */
export function makeQueueItem(overrides: Partial<QueueItem> = {}, index = 1): QueueItem {
  return {
    jobId: makeJobId(index),
    status: 'queued' satisfies JobStatus,
    priority: 0,
    attempts: 0,
    addedAt: makeTimestamp(index * 1_000),
    updatedAt: makeTimestamp(index * 2_000),
    ...overrides,
  };
}

/** An answer-bank entry. Sensitive answers are not auto-submittable by default. */
export function makeAnswer(overrides: Partial<Answer> = {}, index = 1): Answer {
  return {
    id: makeId('answer', index),
    label: `Sample answer ${index}`,
    aliases: [],
    type: 'text',
    value: `Sample value ${index}`,
    category: 'custom',
    autoSubmitAllowed: false,
    sensitive: false,
    updatedAt: makeTimestamp(index * 1_000),
    ...overrides,
  };
}

/** A screening question descriptor found on an application form. */
export function makeQuestion(
  overrides: Partial<QuestionDescriptor> = {},
  index = 1,
): QuestionDescriptor {
  return {
    id: makeId('question', index),
    label: `Sample question ${index}?`,
    type: 'text',
    required: true,
    fingerprint: `fingerprint-${String(index).padStart(4, '0')}`,
    answerSource: 'none',
    ...overrides,
  };
}

/** A Handshake profile document. */
export function makeDocument(overrides: Partial<DocumentRecord> = {}, index = 1): DocumentRecord {
  return {
    id: makeId('document', index),
    type: 'resume',
    title: `Sample Resume ${index}`,
    filename: `sample-resume-${String(index).padStart(4, '0')}.pdf`,
    updatedAt: makeIsoTimestamp(index * 1_000),
    isDefault: false,
    ...overrides,
  };
}

/** Engine state. Deterministic and idle by default. */
export function makeEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    version: 1,
    status: 'idle',
    mode: 'review',
    host: 'app.joinhandshake.com',
    todayCount: 0,
    dailyCap: DEFAULT_SETTINGS.pacing.dailyCap,
    consecutiveFailures: 0,
    updatedAt: makeTimestamp(),
    ...overrides,
  };
}

/** A structured job event. */
export function makeEvent(overrides: Partial<JobEvent> = {}, index = 1): JobEvent {
  return {
    id: makeId('event', index),
    at: makeTimestamp(index * 1_000),
    level: 'info' satisfies EventLevel,
    type: 'engine.started',
    message: `Sample event ${index}`,
    ...overrides,
  };
}

/** A typed application error for failure-path tests. */
export function makeAppError(
  code: ErrorCode = 'UNKNOWN',
  overrides: Partial<Omit<AppError, 'code'>> = {},
): AppError {
  return {
    code,
    message: 'Something went wrong',
    retryable: false,
    ...overrides,
  };
}

/** Convenience: `count` jobs with sequential deterministic IDs. */
export function makeJobs(count: number): Job[] {
  assertIndex(count);
  return Array.from({ length: count }, (_, offset) => makeJob({}, offset + 1));
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Factory index must be a positive integer (received ${String(index)})`);
  }
}
