/**
 * Job-detail extraction and the read-only job API.
 *
 * The DOM is the primary source. `GET /stu/jobs/{id}` (fallback `/jobs/{id}`)
 * enriches it with the apply setting, required document types, and the apply
 * window. Nothing here clicks, writes, or posts.
 */

import {
  appError,
  isRecord,
  type AppError,
  type ApplyType,
  type DocumentType,
  type ErrorCode,
  type Job,
} from '@/core/contracts';
import { classifyApplyType, externalApplyUrl, mapApplyTypeSetting } from './applyType';
import { CancelledError, throwIfAborted, type WaitOptions } from './dom';
import { JOB_PAGE_READY_TIMEOUT_MS, waitForJobPageReady } from './verification';
import { runStrategy } from './health';
import { buildJobUrl, isValidJobId, parseHandshakeHost } from './host';
import { jobSelectors, isStatusRegion } from './selectors/job';
import { collapseWhitespace, normalizeText, truncate } from './text';

const DESCRIPTION_LIMIT = 20_000;
const JOB_PAGE = 'job' as const;

export type JobPageState = 'login' | 'challenge' | 'applied' | 'closed' | 'not_open';

/** Typed inspection failure carrying the frozen `AppError` shape. */
export class JobInspectionError extends Error {
  readonly code: ErrorCode;
  readonly appError: AppError;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'JobInspectionError';
    this.code = code;
    this.appError = appError(code, message);
  }

  toAppError(): AppError {
    return this.appError;
  }
}

function readGroupText(
  root: ParentNode,
  group: keyof typeof jobSelectors,
  healthGroup: string,
): string {
  const match = runStrategy(healthGroup, jobSelectors[group], root, JOB_PAGE);
  return collapseWhitespace(match?.el.textContent ?? '');
}

function readPostedAt(doc: Document): string | undefined {
  const match = runStrategy('job.postedAt', jobSelectors.postedAt, doc, JOB_PAGE);
  const raw = match?.el.getAttribute('datetime');
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function urlFromHost(host: string, jobId: string): string {
  try {
    return buildJobUrl(host, jobId);
  } catch {
    return '';
  }
}

/**
 * Deterministic extraction from the detail page. Missing fields are empty
 * strings; `inspectJob` decides whether that means `UI_CHANGED`.
 */
export function extractJobFromDom(doc: Document, host: string, jobId: string): Job {
  const title = readGroupText(doc, 'title', 'job.title');
  const employer = readGroupText(doc, 'employer', 'job.employer');
  const description = readGroupText(doc, 'description', 'job.description');
  const location = readGroupText(doc, 'location', 'job.location');
  const employmentType = readGroupText(doc, 'employmentType', 'job.employmentType');
  const salary = readGroupText(doc, 'salary', 'job.salary');
  const postedAt = readPostedAt(doc);

  return {
    id: jobId,
    host,
    title,
    employer,
    url: urlFromHost(host, jobId),
    description: truncate(description, DESCRIPTION_LIMIT),
    applyType: classifyApplyType(doc),
    externalUrl: externalApplyUrl(doc),
    requiredDocumentTypes: [],
    source: 'search',
    discoveredAt: Date.now(),
    ...(location ? { location } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(salary ? { salary } : {}),
    ...(postedAt ? { postedAt } : {}),
  };
}

/** Detect a blocking page state before attempting extraction. */
export function detectJobPageState(doc: Document): JobPageState | null {
  if (runStrategy('job.challenge', jobSelectors.challenge, doc, JOB_PAGE)) return 'challenge';
  if (runStrategy('job.login', jobSelectors.login, doc, JOB_PAGE)) return 'login';
  // H5: final-state copy is only trusted inside status/action regions. A job
  // description that happens to contain "already applied" or "position closed"
  // must not stop or misclassify an application.
  if (runStrategy('job.applied', jobSelectors.alreadyApplied, doc, JOB_PAGE, isStatusRegion)) {
    return 'applied';
  }
  if (runStrategy('job.closed', jobSelectors.closed, doc, JOB_PAGE, isStatusRegion)) {
    return 'closed';
  }
  if (runStrategy('job.notOpen', jobSelectors.notOpen, doc, JOB_PAGE, isStatusRegion)) {
    return 'not_open';
  }
  return null;
}

/** Document-type ID mapping from the Handshake job API. */
export function mapDocumentTypeId(id: number): DocumentType | null {
  switch (id) {
    case 1:
      return 'resume';
    case 2:
      return 'cover_letter';
    case 3:
      return 'transcript';
    case 5:
      return 'other';
    default:
      return null;
  }
}

function mapDocumentTypeName(value: string): DocumentType | null {
  const normalized = normalizeText(value);
  if (normalized === 'resume' || normalized === 'cv') return 'resume';
  if (normalized === 'cover letter' || normalized === 'coverletter') return 'cover_letter';
  if (normalized === 'transcript') return 'transcript';
  if (normalized === 'other' || normalized === 'other document') return 'other';
  return null;
}

/** Map IDs/names, dropping unsupported values instead of guessing. */
export function mapDocumentTypes(value: unknown): DocumentType[] {
  if (!Array.isArray(value)) return [];
  const mapped: DocumentType[] = [];
  for (const entry of value) {
    const raw = isRecord(entry)
      ? (entry.document_type_id ?? entry.documentTypeId ?? entry.id)
      : entry;
    const type =
      typeof raw === 'number'
        ? mapDocumentTypeId(raw)
        : typeof raw === 'string'
          ? /^\d+$/.test(raw.trim())
            ? mapDocumentTypeId(Number(raw))
            : mapDocumentTypeName(raw)
          : null;
    if (type && !mapped.includes(type)) mapped.push(type);
  }
  return mapped;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1_000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (/^\d+$/.test(trimmed)) return toIso(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

function htmlToText(value: string): string {
  if (!/[<>&]/.test(value)) return truncate(collapseWhitespace(value), DESCRIPTION_LIMIT);
  if (typeof DOMParser === 'undefined') {
    return truncate(collapseWhitespace(value.replace(/<[^>]*>/g, ' ')), DESCRIPTION_LIMIT);
  }
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  return truncate(collapseWhitespace(parsed.body.textContent ?? ''), DESCRIPTION_LIMIT);
}

function readLocation(value: unknown): string | undefined {
  const text = asText(value);
  if (text) return text;
  if (isRecord(value)) {
    const name = asText(value.name) ?? asText(value.label);
    if (name) return name;
    const city = asText(value.city);
    const region = asText(value.region ?? value.state);
    if (city) return region ? `${city}, ${region}` : city;
    return undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => readLocation(entry))
      .filter((entry): entry is string => typeof entry === 'string');
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return undefined;
}

function readEmploymentType(value: unknown): string | undefined {
  const text = asText(value);
  if (text) return text;
  if (isRecord(value)) return asText(value.name) ?? asText(value.label);
  return undefined;
}

function readSalary(value: unknown): string | undefined {
  const text = asText(value);
  if (text) return text;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isRecord(value)) {
    return asText(value.formatted) ?? asText(value.display) ?? asText(value.amount) ?? undefined;
  }
  return undefined;
}

function readEmployer(job: Record<string, unknown>): string | undefined {
  const direct = asText(job.employer_name) ?? asText(job.employerName);
  if (direct) return direct;
  if (isRecord(job.employer)) {
    return asText(job.employer.name) ?? asText(job.employer.display_name);
  }
  return asText(job.employer);
}

function readApplyType(job: Record<string, unknown>): ApplyType | undefined {
  const setting = isRecord(job.job_apply_setting) ? job.job_apply_setting : null;
  const raw = setting?.apply_type ?? job.apply_type;
  const mapped = mapApplyTypeSetting(raw);
  return mapped === 'unknown' ? undefined : mapped;
}

function parseJobPayload(job: Record<string, unknown>): Partial<Job> {
  const title = asText(job.title);
  const employer = readEmployer(job);
  const description = asText(job.description);
  const location = readLocation(job.location) ?? readLocation(job.locations);
  const employmentType =
    readEmploymentType(job.employment_type) ?? readEmploymentType(job.job_type);
  const salary = readSalary(job.salary) ?? readSalary(job.compensation);
  const applyType = readApplyType(job);
  const applyStartAt = toIso(job.apply_start ?? job.apply_start_at);
  const postedAt = toIso(job.posted_at ?? job.created_at);
  const requiredDocumentTypes = mapDocumentTypes(job.required_job_document_types);
  const remote = typeof job.remote === 'boolean' ? job.remote : undefined;

  return {
    ...(title ? { title } : {}),
    ...(employer ? { employer } : {}),
    ...(description ? { description: htmlToText(description) } : {}),
    ...(location ? { location } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(salary ? { salary } : {}),
    ...(applyType ? { applyType } : {}),
    ...(applyStartAt ? { applyStartAt } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(remote === undefined ? {} : { remote }),
    requiredDocumentTypes,
  };
}

function unwrapJobPayload(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.job)) return body.job;
  return body;
}

/**
 * Fetch job details with same-origin cookies. 403 stops immediately; 422/404
 * and network errors fall through to the next endpoint. Returns `null` when
 * every endpoint fails so callers can continue with DOM-only data.
 */
export async function fetchJobDetails(
  jobId: string,
  host: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Partial<Job> | null> {
  if (!parseHandshakeHost(host) || !isValidJobId(jobId)) return null;

  const endpoints = [`https://${host}/stu/jobs/${jobId}`, `https://${host}/jobs/${jobId}`];
  for (const endpoint of endpoints) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new CancelledError();
      continue;
    }

    if (response.status === 429) {
      throw new JobInspectionError(
        'RATE_LIMITED',
        'Handshake is limiting requests. Wait before resuming the run.',
      );
    }
    if (response.status === 401) {
      throw new JobInspectionError('AUTH_REQUIRED', 'Sign in to Handshake, then resume the run.');
    }
    if (response.status === 403) return null;
    if (response.status === 422 || response.status === 404) continue;
    if (!response.ok) continue;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      continue;
    }
    const payload = unwrapJobPayload(body);
    if (payload) return parseJobPayload(payload);
  }
  return null;
}

function assertInspectInputs(host: string, jobId: string): void {
  if (!parseHandshakeHost(host)) throw new TypeError('inspectJob requires a Handshake host');
  if (!isValidJobId(jobId)) throw new TypeError('inspectJob requires a numeric job ID');
}

function stateError(state: JobPageState): JobInspectionError {
  switch (state) {
    case 'login':
      return new JobInspectionError('AUTH_REQUIRED', 'Sign in to Handshake to continue');
    case 'challenge':
      return new JobInspectionError('CHALLENGE', 'Handshake is showing a verification challenge');
    case 'applied':
      return new JobInspectionError('ALREADY_APPLIED', 'You already applied to this job');
    case 'closed':
      return new JobInspectionError('JOB_CLOSED', 'This job is no longer accepting applications');
    case 'not_open':
      return new JobInspectionError('NOT_OPEN', 'Applications for this job are not open yet');
  }
}

/**
 * Merge DOM extraction with the read-only job API. Throws
 * `JobInspectionError` for login/challenge/applied/closed/not-open pages and
 * for a missing title/description (`UI_CHANGED`).
 */
export async function inspectJob(
  doc: Document,
  host: string,
  jobId: string,
  fetchImpl?: typeof fetch,
  options: WaitOptions = {},
): Promise<Job> {
  assertInspectInputs(host, jobId);
  await waitForJobPageReady(doc, {
    ...options,
    timeoutMs: Math.min(JOB_PAGE_READY_TIMEOUT_MS, options.timeoutMs ?? JOB_PAGE_READY_TIMEOUT_MS),
  });
  throwIfAborted(options.signal);

  const state = detectJobPageState(doc);
  if (state) throw stateError(state);

  const domJob = extractJobFromDom(doc, host, jobId);
  const fetcher = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const api = fetcher ? await fetchJobDetails(jobId, host, fetcher, options.signal) : null;
  throwIfAborted(options.signal);

  const title = domJob.title || api?.title || '';
  const description = api?.description || domJob.description || '';
  if (title.length === 0) {
    throw new JobInspectionError('UI_CHANGED', 'Job title could not be read from the page');
  }
  // Description is used for AI matching and filtering, not for submitting. A
  // lazy-loaded/hidden description must not block an otherwise valid application.

  const location = api?.location ?? domJob.location;
  const employmentType = api?.employmentType ?? domJob.employmentType;
  const salary = api?.salary ?? domJob.salary;
  const remote = api?.remote ?? domJob.remote;
  const postedAt = domJob.postedAt ?? api?.postedAt;
  const applyType =
    api?.applyType === 'external' || domJob.applyType === 'external'
      ? 'external'
      : api?.applyType && api.applyType !== 'unknown'
        ? api.applyType
        : domJob.applyType;

  return {
    id: jobId,
    host,
    title,
    employer: domJob.employer || api?.employer || '',
    url: domJob.url || urlFromHost(host, jobId),
    description,
    applyType,
    externalUrl: domJob.externalUrl,
    requiredDocumentTypes: api?.requiredDocumentTypes ?? [],
    source: 'search',
    discoveredAt: Date.now(),
    ...(location ? { location } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(salary ? { salary } : {}),
    ...(remote === undefined ? {} : { remote }),
    ...(postedAt ? { postedAt } : {}),
    ...(api?.applyStartAt ? { applyStartAt: api.applyStartAt } : {}),
  };
}

/** Convenience re-export so callers can classify without importing two files. */
export { classifyApplyType, mapApplyTypeSetting };
