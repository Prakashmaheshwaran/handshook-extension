import {
  DB_STORES,
  type Job,
  type JobStatus,
  type QueueItem,
  type Settings,
} from '@/core/contracts';
import { getDb } from '@/core/storage/db';
import {
  EXTERNAL_DISMISSED,
  isExternalJob,
  isInternalApplication,
} from '@/core/util/application-policy';
export { getQueueSummary } from '@/core/storage/tracker';

export type JobEvaluator = (
  job: Job,
  settings: Settings,
  now?: number,
  stage?: 'discovery' | 'details',
) => { pass: boolean; reasons: string[]; fitScore: number; fitReasons: string[] };

const TERMINAL: JobStatus[] = [
  'applied',
  'external',
  'already_applied',
  'skipped',
  'blocked',
  'filtered',
];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Statuses that describe a final outcome for a job. They must never be moved
 * back to `queued` by retry/apply-now/skip or a needs-flow action: doing so
 * could re-submit an application the user already made.
 */
export const IMMUTABLE_STATUSES: readonly JobStatus[] = [
  'applied',
  'external',
  'already_applied',
  'filtered',
  'blocked',
];

export function isImmutableStatus(status: JobStatus): boolean {
  return IMMUTABLE_STATUSES.includes(status);
}

export async function putJob(job: Job): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.jobs, job);
}

export async function getJob(jobId: string): Promise<Job | undefined> {
  const db = await getDb();
  return db.get(DB_STORES.jobs, jobId);
}

export async function listJobs(limit = 200): Promise<Job[]> {
  const db = await getDb();
  const jobs = await db.getAllFromIndex(DB_STORES.jobs, 'byDiscoveredAt');
  return jobs.slice(-limit).reverse();
}

export async function getQueueItem(jobId: string): Promise<QueueItem | undefined> {
  const db = await getDb();
  return db.get(DB_STORES.queue, jobId);
}

export async function putQueueItem(item: QueueItem): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.queue, item);
}

export async function updateQueueItem(
  jobId: string,
  patch: Partial<QueueItem>,
): Promise<QueueItem | undefined> {
  const db = await getDb();
  const tx = db.transaction(DB_STORES.queue, 'readwrite');
  const current = await tx.store.get(jobId);
  if (!current) {
    await tx.done;
    return undefined;
  }
  const next = {
    ...current,
    ...patch,
    jobId,
    updatedAt: Date.now(),
    ...(current.status === 'applied' ? { status: current.status, lastError: undefined } : {}),
  };
  await tx.store.put(next);
  await tx.done;
  return next;
}

export async function enqueueJobs(
  jobs: Job[],
  settings: Settings,
  evaluate: JobEvaluator,
  now = Date.now(),
): Promise<{ queued: number; filtered: number }> {
  let queued = 0;
  let filtered = 0;
  const existing = await Promise.all(jobs.map((job) => getQueueItem(job.id)));
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (!job) continue;
    const current = existing[index];
    const stored = await getJob(job.id);
    // External links never enter the application queue or its fit evaluation.
    if (isExternalJob(job, current) || isExternalJob(stored, current)) {
      if (settings.search.collectExternalJobs || current) {
        await putJob({
          ...stored,
          ...job,
          applyType: 'external',
          externalUrl: job.externalUrl ?? stored?.externalUrl,
          fitScore: undefined,
          fitReasons: undefined,
        });
        if (!current || !isTerminal(current.status)) {
          await putQueueItem({
            ...(current ?? { jobId: job.id, attempts: 0, addedAt: now }),
            status: 'external',
            priority: 0,
            updatedAt: now,
            nextAttemptAt: undefined,
            lastError: undefined,
            pendingQuestionIds: [],
            missingDocumentTypes: [],
          });
        }
      }
      continue;
    }
    if (current?.status && isTerminal(current.status)) continue;
    const evaluation = evaluate(job, settings, now, 'discovery');
    const enriched: Job = {
      ...job,
      fitScore: evaluation.fitScore,
      fitReasons: evaluation.fitReasons,
    };
    await putJob(enriched);
    if (current) {
      // A re-scan must not reset work in progress. Keep status, attempts,
      // backoff, needs, and errors exactly as they were; only refresh priority.
      await putQueueItem({
        ...current,
        priority: Math.round(evaluation.fitScore * 100),
        updatedAt: now,
      });
      queued += 1;
      continue;
    }
    if (!evaluation.pass) {
      await putQueueItem({
        jobId: job.id,
        status: 'filtered',
        priority: 0,
        attempts: 0,
        addedAt: now,
        updatedAt: now,
        skipReason: evaluation.reasons.join('; '),
        lastError: undefined,
      });
      filtered += 1;
      continue;
    }
    await putQueueItem({
      jobId: job.id,
      status: 'queued',
      priority: Math.round(evaluation.fitScore * 100),
      attempts: 0,
      addedAt: now,
      updatedAt: now,
    });
    queued += 1;
  }
  return { queued, filtered };
}

function canPromote(item: QueueItem, maxAttempts: number): boolean {
  return (
    item.status === 'waiting' ||
    (item.status === 'failed' && item.lastError?.retryable === true && item.attempts < maxAttempts)
  );
}

/** Only explicitly scheduled retries may re-enter the queue; never Needs You. */
export async function promoteDueJobs(now: number, maxAttempts: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([DB_STORES.queue, DB_STORES.jobs], 'readwrite');
  const items = await tx.objectStore(DB_STORES.queue).getAll();
  for (const item of items) {
    if (isExternalJob(await tx.objectStore(DB_STORES.jobs).get(item.jobId), item)) continue;
    if (
      canPromote(item, maxAttempts) &&
      item.nextAttemptAt !== undefined &&
      item.nextAttemptAt <= now
    ) {
      await tx
        .objectStore(DB_STORES.queue)
        .put({ ...item, status: 'queued', nextAttemptAt: undefined, updatedAt: now });
    }
  }
  await tx.done;
}

export async function getNextQueueWakeAt(
  now: number,
  maxAttempts: number,
): Promise<number | undefined> {
  const items = await listQueue({ limit: Number.MAX_SAFE_INTEGER });
  const times = items
    .filter(
      (item) =>
        item.status === 'queued' ||
        (canPromote(item, maxAttempts) && item.nextAttemptAt !== undefined),
    )
    .map((item) => Math.max(now, item.nextAttemptAt ?? now));
  return times.length > 0 ? Math.min(...times) : undefined;
}

export async function getNextQueued(
  now = Date.now(),
  maxAttempts = 2,
): Promise<QueueItem | undefined> {
  await promoteDueJobs(now, maxAttempts);
  const queued = await listQueue({ status: ['queued'], limit: Number.MAX_SAFE_INTEGER });
  const eligible = queued
    .filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= now)
    .sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
  return eligible[0];
}

export async function listQueue(
  filter: {
    status?: JobStatus[];
    limit?: number;
    offset?: number;
    includeExternal?: boolean;
  } = {},
): Promise<QueueItem[]> {
  const db = await getDb();
  let items = await db.getAll(DB_STORES.queue);
  const jobs = new Map((await db.getAll(DB_STORES.jobs)).map((job) => [job.id, job]));
  items = items.filter(
    (item) =>
      !isExternalJob(jobs.get(item.jobId), item) ||
      (filter.includeExternal === true && item.skipReason !== EXTERNAL_DISMISSED),
  );
  // Older rows can carry needs/failed/applied status despite an external classification.
  items = items.map((item) => {
    const job = jobs.get(item.jobId);
    if (isExternalJob(job, item)) return { ...item, status: 'external' };
    if (item.status === 'applied' && !isInternalApplication(job?.applyType))
      return { ...item, status: 'already_applied' };
    return item;
  });
  if (filter.status?.length) {
    items = items.filter((item) => filter.status?.includes(item.status));
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const offset = filter.offset ?? 0;
  return items.slice(offset, offset + (filter.limit ?? 200));
}

export async function pruneQueue(olderThanDays: number): Promise<number> {
  const db = await getDb();
  const items = await db.getAll(DB_STORES.queue);
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const prunable: JobStatus[] = ['external', 'skipped', 'filtered', 'blocked'];
  let removed = 0;
  for (const item of items) {
    if (prunable.includes(item.status) && item.updatedAt < cutoff) {
      await db.delete(DB_STORES.queue, item.jobId);
      removed += 1;
    }
  }
  return removed;
}
