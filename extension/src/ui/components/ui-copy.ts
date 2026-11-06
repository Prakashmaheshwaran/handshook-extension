import type {
  AppError,
  ApplyType,
  DocumentType,
  EngineState,
  EngineStatus,
  ErrorCode,
  EventLevel,
  JobStatus,
  PauseReason,
} from '@/core/contracts';
import type { BadgeTone } from './Badge';
import type { ToastLevel } from './Toast';

export interface StatusCopy {
  label: string;
  tone: BadgeTone;
}

export const JOB_STATUS_COPY: Record<JobStatus, StatusCopy> = {
  discovered: { label: 'Discovered', tone: 'neutral' },
  filtered: { label: 'Filtered out', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  opening: { label: 'Opening', tone: 'info' },
  filling: { label: 'Filling', tone: 'info' },
  ready_for_review: { label: 'Ready to review', tone: 'accent' },
  submitting: { label: 'Submitting', tone: 'info' },
  verifying: { label: 'Verifying', tone: 'info' },
  applied: { label: 'Applied', tone: 'success' },
  would_apply: { label: 'Dry run — would apply', tone: 'neutral' },
  external: { label: 'Employer site', tone: 'info' },
  needs_input: { label: 'Needs you', tone: 'warn' },
  waiting: { label: 'Scheduled', tone: 'neutral' },
  already_applied: { label: 'Already applied', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

export const ENGINE_STATUS_COPY: Record<EngineStatus, StatusCopy> = {
  idle: { label: 'Idle', tone: 'neutral' },
  onboarding: { label: 'Setup', tone: 'info' },
  scanning: { label: 'Scanning', tone: 'info' },
  running: { label: 'Running', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  needs_user: { label: 'Needs you', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
};

export const PAUSE_REASON_COPY: Record<PauseReason, string> = {
  user: 'Paused by you.',
  cap_reached: 'Daily cap reached. Start again after local midnight when the cap resets.',
  active_hours: 'Active hours were removed. Resume when ready.',
  auth_required: 'Your Handshake session expired. Log in, then resume.',
  rate_limited: 'Handshake asked for a slower pace. The run paused and this job was marked failed.',
  ui_changed: "Handshake's page changed and could not be read. Check diagnostics.",
  too_many_failures: 'Paused after repeated failures. Check the queue before resuming.',
  tab_closed: 'The runner tab was closed. Resume to open a new one.',
  browser_restarted: 'The browser restarted while a run was active.',
  storage_error: 'Local storage failed. Export your data, then reset.',
  protocol_mismatch: 'The panel and background are on different versions. Reload the extension.',
};

/**
 * Plain-language copy for error codes. The raw code is never the primary
 * message; screens show it only inside an Advanced/details disclosure.
 */
export const ERROR_CODE_COPY: Record<ErrorCode, string> = {
  AUTH_REQUIRED: 'Your Handshake session expired. Log in to Handshake, then retry.',
  RATE_LIMITED: 'Handshake asked for a slower pace. Wait a little, then retry.',
  FORBIDDEN: 'Handshake refused this action. Check that you are logged in and allowed to apply.',
  CHALLENGE: 'Handshake wants you to complete a verification step before continuing.',
  CAP_REACHED: "Today's application cap is reached. It resets at local midnight.",
  EXTERNAL_APPLY: 'This employer handles applications on their own site.',
  MISSING_DOCUMENT: 'A required document could not be attached or verified for this application.',
  UNKNOWN_QUESTION: 'The application has a question Handshook does not know how to answer.',
  UI_CHANGED: "Handshake's page changed and could not be read. The run paused instead of guessing.",
  NETWORK: 'Handshook could not reach the extension background or Handshake. Try again.',
  TIMEOUT: 'The action took too long. Try again.',
  ALREADY_APPLIED: 'You have already applied to this job.',
  JOB_CLOSED: 'This job is closed.',
  NOT_OPEN: 'This job is not open for applications.',
  CANCELLED: 'The run was cancelled before this finished.',
  STORAGE_MIGRATION_FAILED: 'Saved data could not be upgraded. Export a backup before resetting.',
  PROTOCOL_MISMATCH: 'The panel and background are on different versions. Reload the extension.',
  UNSUPPORTED_MESSAGE:
    'This version of the panel does not support that action. Reload the extension.',
  INVALID_INPUT: 'Some of the information is missing or invalid.',
  UNKNOWN: 'Something unexpected happened. Reload the extension and try again.',
};

export interface ErrorDescription {
  /** Plain-language copy suitable as the primary message. */
  message: string;
  code: ErrorCode;
  /** The original message, when it adds detail beyond the mapped copy. */
  originalMessage?: string;
}

// Only reviewed, application-owned messages may replace generic error copy.
// Never display arbitrary exception text: it can contain selectors or internals.
const RECOVERY_COPY: Partial<Record<ErrorCode, Readonly<Record<string, string>>>> = {
  UNKNOWN: {
    'Stop the run and finish any pending review before refreshing the runner.':
      'A run or review is still open. Stop the run, then finish or skip the pending application in Needs you before trying again.',
    'A previous submission could not be verified. Check My Jobs.':
      'This submission is unconfirmed. Check My Jobs on Handshake before doing anything else. You can skip this job in Needs you to continue; Handshook will not submit it again.',
    'A previous submission needs reconciliation':
      'This submission is unconfirmed. Check My Jobs on Handshake, then use Needs you to review or skip the job before continuing.',
    'The application response was lost. Check the job page or My Jobs before retrying.':
      'The application response was lost. Check My Jobs on Handshake before doing anything else; do not submit the application again.',
  },
  TIMEOUT: {
    'The application reply could not be validated. Check this job or My Jobs before retrying.':
      'Handshook could not confirm the application reply. Check My Jobs on Handshake before doing anything else; do not submit the application again.',
  },
  INVALID_INPUT: {
    'A previous submission needs verification before this job can run again.':
      'This submission is unconfirmed. Check My Jobs on Handshake, then skip this job in Needs you to continue. Retrying cannot submit it again.',
    'The previous attempt is not a settled non-submission.':
      'Handshook cannot prove the previous attempt was not submitted. Check My Jobs on Handshake before continuing; this job cannot safely be retried.',
    'This job already has a recorded application.':
      'This job already has a recorded application. Check it on Handshake; it will not be submitted again.',
  },
};

export function describeError(error: AppError): ErrorDescription {
  const recovery = RECOVERY_COPY[error.code];
  const mapped =
    recovery && Object.hasOwn(recovery, error.message)
      ? (recovery[error.message] ?? ERROR_CODE_COPY[error.code])
      : ERROR_CODE_COPY[error.code];
  const original = error.message.trim();
  return {
    message: mapped,
    code: error.code,
    originalMessage: original.length > 0 && original !== mapped ? original : undefined,
  };
}

export function friendlyErrorMessage(error: AppError): string {
  return describeError(error).message;
}

export type QueuePrimaryAction = 'answer' | 'review' | 'apply' | 'none';

/**
 * Which primary action makes sense for a queue row. Reviewing must never
 * re-apply: a filled application is opened, not requeued.
 */
export function queuePrimaryAction(status: JobStatus): QueuePrimaryAction {
  if (status === 'ready_for_review' || status === 'verifying') return 'review';
  if (status === 'needs_input') return 'answer';
  if (
    status === 'applied' ||
    status === 'would_apply' ||
    status === 'external' ||
    status === 'already_applied' ||
    status === 'skipped' ||
    status === 'filtered' ||
    status === 'blocked'
  ) {
    return 'none';
  }
  return 'apply';
}

export interface EngineActionNotice {
  level: ToastLevel;
  message: string;
}

/**
 * Turns the EngineState returned by start/resume/pause/stop into honest toast
 * copy. A start that comes back paused (cap, needs_user) must not
 * be reported as "Run started".
 */
export function describeEngineAction(
  state: EngineState | null,
  action: 'start' | 'pause' | 'resume' | 'stop',
): EngineActionNotice {
  if (!state) {
    return {
      level: 'warn',
      message: 'The background did not report the run state. Refresh and try again.',
    };
  }

  if (action === 'pause') {
    return state.status === 'paused'
      ? { level: 'success', message: 'Run paused.' }
      : { level: 'warn', message: state.message ?? 'The run could not be paused.' };
  }

  if (action === 'stop') {
    return state.status === 'idle' || state.status === 'stopped'
      ? { level: 'success', message: 'Run stopped. Nothing is running.' }
      : { level: 'warn', message: state.message ?? 'The run could not be stopped.' };
  }

  const starting = action === 'start';
  if (state.status === 'paused' || state.status === 'error') {
    const detail =
      state.message ?? (state.pauseReason ? PAUSE_REASON_COPY[state.pauseReason] : undefined);
    return {
      level: 'warn',
      message: starting
        ? `Run not started. ${detail ?? 'The run is paused.'}`
        : `Run not resumed. ${detail ?? 'The run is paused.'}`,
    };
  }

  if (state.status === 'needs_user') {
    return {
      level: 'warn',
      message: state.message ?? 'The run needs your input. Check Needs you.',
    };
  }

  if (state.status === 'running' || state.status === 'scanning') {
    return { level: 'success', message: starting ? 'Run started.' : 'Run resumed.' };
  }

  // For example a Start after today's cap is used: the run stays idle.
  return {
    level: 'warn',
    message: state.message
      ? `${starting ? 'Run not started' : 'Run not resumed'}. ${state.message}`
      : `The run did not ${starting ? 'start' : 'resume'}.`,
  };
}

const HANDSHAKE_APEX_DOMAINS = ['joinhandshake.com', 'joinhandshake.co.uk'] as const;
const HANDSHAKE_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** True for the apex domains and any subdomain of them. */
export function isHandshakeHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253 || host.includes('..')) return false;
  if (!host.split('.').every((label) => HANDSHAKE_HOST_LABEL.test(label))) return false;
  return HANDSHAKE_APEX_DOMAINS.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/**
 * Handshake job-search paths. Mirrors `handshake/host.ts` so the UI and the
 * adapters agree on what counts as a search page (the UI may not import it).
 */
const HANDSHAKE_SEARCH_PATHS = new Set([
  '/job-search',
  '/job_search',
  '/jobs',
  '/jobs/search',
  '/postings',
  '/search',
  '/stu/jobs',
  '/stu/search',
]);

export function isHandshakeJobSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.username.length > 0 || url.password.length > 0) return false;
    if (!isHandshakeHost(url.hostname)) return false;
    const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    return (
      HANDSHAKE_SEARCH_PATHS.has(path) ||
      path.startsWith('/job-search/') ||
      path.startsWith('/postings/')
    );
  } catch {
    return false;
  }
}

export const APPLY_TYPE_COPY: Record<ApplyType, string> = {
  quick_apply: 'Quick apply',
  handshake_form: 'Handshake form',
  external: 'Employer site',
  unknown: 'Unknown form',
};

export const DOCUMENT_TYPE_COPY: Record<DocumentType, string> = {
  resume: 'Resume',
  cover_letter: 'Cover letter',
  transcript: 'Transcript',
  other: 'Other document',
};

export const EVENT_LEVEL_TONE: Record<EventLevel, BadgeTone> = {
  debug: 'neutral',
  info: 'info',
  warn: 'warn',
  error: 'danger',
};

export function formatTime(at: number): string {
  if (!Number.isFinite(at)) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at);
}

export function formatDateTime(at: number): string {
  if (!Number.isFinite(at)) return 'unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

export function formatWhen(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return 'unknown';
  const delta = now - at;
  if (delta < 0) return formatDateTime(at);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
}

export function formatPercent(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/**
 * Policy hint shared by the UI (the background keeps its own authoritative
 * copy). Sensitive answers are never auto-submitted without an explicit opt-in.
 */
export function looksSensitive(label: string): boolean {
  return /authoriz|sponsor|felony|background|veteran|disab|gender|race|ethnic|birth|ssn|salary|compensation|eeo/i.test(
    label,
  );
}
