/**
 * Application tracker (`queue` store, keyPath `jobId`).
 *
 * Port of `job_tracker.py` (docs/PORT-NOTES.md §9) with contract statuses:
 * terminal statuses never get reapplied, retryable statuses may return to the
 * queue. Every write is an upsert keyed by `jobId`, so repeated events are
 * idempotent and never double-track.
 *
 * Deviation from Python: Python's `unsupported` has no contract status; that
 * case is tracked as `external` here. `skipped` is terminal per
 * docs/CONTRACTS.md §3 even though Python allowed reprocessing.
 */

import {
  DB_STORES,
  type ApplyType,
  type AppError,
  type Job,
  type JobStatus,
  type QueueItem,
  type QueueSummary,
  type Settings,
  type TerminalJobStatus,
} from '@/core/contracts';
import { getDb, getTodayCount } from '@/core/storage/db';
import { getJob, putJob } from '@/core/storage/jobs';
import { now } from '@/core/util/time';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';

export const TERMINAL_STATUSES: readonly TerminalJobStatus[] = [
  'applied',
  'external',
  'already_applied',
  'skipped',
  'filtered',
  'blocked',
];

const TERMINAL_STATUS_SET: ReadonlySet<JobStatus> = new Set(TERMINAL_STATUSES);

const RETRYABLE_STATUSES: readonly JobStatus[] = ['failed', 'waiting', 'needs_input'];

const IN_PROGRESS_STATUSES: readonly JobStatus[] = [
  'opening',
  'filling',
  'submitting',
  'verifying',
  'ready_for_review',
];

/** Statuses eligible for `pruneTracker`. `applied` and submissions are never pruned. */
const PRUNABLE_STATUSES: readonly JobStatus[] = ['external', 'skipped', 'filtered'];

export const DEFAULT_QUEUE_LIMIT = 200;

const DAY_MS = 86_400_000;

export interface QueueFilter {
  status?: JobStatus[];
  limit?: number;
  offset?: number;
}

/** Minimal job data needed to create a job record when tracking before discovery stored it. */
export interface TrackedJobSeed {
  host: string;
  title: string;
  employer: string;
  url: string;
  applyType?: ApplyType;
}

export function isTerminalStatus(status: JobStatus): status is TerminalJobStatus {
  return TERMINAL_STATUS_SET.has(status);
}

export function isRetryableStatus(status: JobStatus): boolean {
  return RETRYABLE_STATUSES.includes(status);
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

async function ensureJob(jobId: string, seed: TrackedJobSeed): Promise<void> {
  const existing = await getJob(jobId);
  if (existing) return;
  const job: Job = {
    id: jobId,
    host: seed.host,
    title: seed.title,
    employer: seed.employer,
    url: seed.url,
    description: '',
    applyType: seed.applyType ?? 'unknown',
    requiredDocumentTypes: [],
    source: 'manual',
    discoveredAt: now(),
  };
  await putJob(job);
}

/** Returns the terminal status for a job, or null if it is untracked/retryable. */
export async function isTracked(jobId: string): Promise<TerminalJobStatus | null> {
  const item = await getQueueItem(jobId);
  if (!item) return null;
  return isTerminalStatus(item.status) ? item.status : null;
}

export async function upsertQueueItem(item: QueueItem): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.queue, item);
}

export async function getQueueItem(jobId: string): Promise<QueueItem | undefined> {
  const db = await getDb();
  return db.get(DB_STORES.queue, jobId);
}

/**
 * Sorted by priority (desc) then addedAt (asc), with `jobId` as a stable
 * tiebreak. Filtering happens in memory because the store is small and this
 * keeps multi-status filters and pagination consistent.
 */
export async function listQueue(filter: QueueFilter = {}): Promise<QueueItem[]> {
  const db = await getDb();
  const all = await db.getAll(DB_STORES.queue);
  const statuses = filter.status && filter.status.length > 0 ? new Set(filter.status) : null;
  const filtered = statuses ? all.filter((item) => statuses.has(item.status)) : all;
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  const limit = Math.max(0, Math.floor(filter.limit ?? DEFAULT_QUEUE_LIMIT));
  return filtered.sort(compareQueueItems).slice(offset, offset + limit);
}

/**
 * Merges a patch into an existing item and bumps `updatedAt`. `jobId` and
 * `addedAt` are immutable. Returns undefined when the job is not tracked.
 */
export async function updateQueueItem(
  jobId: string,
  patch: Partial<QueueItem>,
): Promise<QueueItem | undefined> {
  const existing = await getQueueItem(jobId);
  if (!existing) return undefined;
  const next: QueueItem = {
    ...existing,
    ...patch,
    jobId: existing.jobId,
    addedAt: existing.addedAt,
    updatedAt: now(),
  };
  await upsertQueueItem(next);
  return next;
}

/**
 * Records a status for a job, creating the queue entry on first sight. The
 * `status` argument wins over `patch.status` so wrappers cannot drift.
 */
export async function trackStatus(
  jobId: string,
  status: JobStatus,
  patch: Partial<QueueItem> = {},
): Promise<QueueItem> {
  const existing = await getQueueItem(jobId);
  const timestamp = now();
  const next: QueueItem = {
    ...(existing ?? {
      jobId,
      priority: 0,
      attempts: 0,
      addedAt: timestamp,
      updatedAt: timestamp,
    }),
    ...patch,
    jobId,
    addedAt: existing?.addedAt ?? timestamp,
    updatedAt: timestamp,
    status,
  };
  await upsertQueueItem(next);
  return next;
}

export async function trackApplied(
  jobId: string,
  seed?: TrackedJobSeed,
  patch?: Partial<QueueItem>,
): Promise<QueueItem> {
  if (seed) await ensureJob(jobId, seed);
  const job = await getJob(jobId);
  if (isExternalJob(job, await getQueueItem(jobId))) return trackStatus(jobId, 'external', patch);
  if (!isInternalApplication(job?.applyType)) {
    return trackStatus(jobId, 'already_applied', patch);
  }
  return trackStatus(jobId, 'applied', patch);
}

export async function trackExternal(
  jobId: string,
  seed?: TrackedJobSeed,
  patch?: Partial<QueueItem>,
): Promise<QueueItem> {
  if (seed) await ensureJob(jobId, seed);
  return trackStatus(jobId, 'external', patch);
}

export async function trackAlreadyApplied(
  jobId: string,
  seed?: TrackedJobSeed,
  patch?: Partial<QueueItem>,
): Promise<QueueItem> {
  if (seed) await ensureJob(jobId, seed);
  return trackStatus(jobId, 'already_applied', patch);
}

export async function trackFailed(
  jobId: string,
  error: AppError,
  patch?: Partial<QueueItem>,
): Promise<QueueItem> {
  return trackStatus(jobId, 'failed', { ...patch, lastError: error });
}

export async function trackWaiting(
  jobId: string,
  nextAttemptAt: number,
  patch?: Partial<QueueItem>,
): Promise<QueueItem> {
  return trackStatus(jobId, 'waiting', { ...patch, nextAttemptAt });
}

export async function trackNeedsInput(
  jobId: string,
  patch: Partial<QueueItem> = {},
): Promise<QueueItem> {
  return trackStatus(jobId, 'needs_input', patch);
}

/**
 * Deletes queue entries that are in a prunable terminal state and older than
 * `olderThanDays` (by `updatedAt`). Never removes `applied` or submissions.
 * Returns the number of deleted queue items.
 */
export async function pruneTracker(olderThanDays: number): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return 0;
  const cutoff = now() - olderThanDays * DAY_MS;
  const db = await getDb();
  const all = await db.getAll(DB_STORES.queue);
  const stale = all.filter(
    (item) => PRUNABLE_STATUSES.includes(item.status) && item.updatedAt < cutoff,
  );
  if (stale.length === 0) return 0;
  const tx = db.transaction(DB_STORES.queue, 'readwrite');
  for (const item of stale) {
    await tx.store.delete(item.jobId);
  }
  await tx.done;
  return stale.length;
}

export async function getQueueSummary(settings: Settings): Promise<QueueSummary> {
  const db = await getDb();
  const jobs = new Map((await db.getAll(DB_STORES.jobs)).map((job) => [job.id, job]));
  const items = (await listQueue({ limit: Number.MAX_SAFE_INTEGER })).filter(
    (item) => !isExternalJob(jobs.get(item.jobId), item),
  );
  const counts: Partial<Record<JobStatus, number>> = {};
  let currentJobId: string | undefined;
  for (const item of items) {
    // Imported/legacy rows keep their replay barrier without claiming an internal application.
    const status =
      item.status === 'applied' && !isInternalApplication(jobs.get(item.jobId)?.applyType)
        ? 'already_applied'
        : item.status;
    counts[status] = (counts[status] ?? 0) + 1;
    if (currentJobId === undefined && IN_PROGRESS_STATUSES.includes(item.status)) {
      currentJobId = item.jobId;
    }
  }
  const todayCount = await getTodayCount();
  const dailyCap = settings.pacing.dailyCap;
  return {
    counts,
    total: items.length,
    todayCount,
    dailyCap,
    remainingToday: Math.max(0, dailyCap - todayCount),
    ...(currentJobId ? { currentJobId } : {}),
  };
}
