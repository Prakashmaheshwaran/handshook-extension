import {
  DB_STORES,
  appError,
  err,
  ok,
  type Job,
  type JobEvent,
  type Result,
} from '@/core/contracts';
import { makeEvent } from '@/core/logging/logger';
import { getDb } from '@/core/storage/db';
import { todayKey } from '@/core/util/time';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';

interface AppliedEventStores {
  meta: {
    get(key: string): Promise<{ key: string; value: unknown } | undefined>;
    put(record: { key: string; value: unknown }): Promise<unknown>;
  };
  jobs: { get(key: string): Promise<Job | undefined> };
  events: { put(event: JobEvent): Promise<unknown> };
}

/** Call inside the settlement transaction; the marker survives Activity pruning. */
export async function appendAppliedEventOnce(
  stores: AppliedEventStores,
  attemptId: string,
  jobId: string,
): Promise<JobEvent | null> {
  const key = `appliedEvent:${attemptId}`;
  if (await stores.meta.get(key)) return null;
  const job = await stores.jobs.get(jobId);
  if (!isInternalApplication(job?.applyType)) return null;
  const activity = {
    ...makeEvent(
      'info',
      'job.applied',
      `Applied: ${job?.title ?? jobId} at ${job?.employer ?? 'Handshake'}`,
      { jobId },
    ),
    id: attemptId,
  };
  await stores.events.put(activity);
  await stores.meta.put({ key, value: true });
  return activity;
}

/**
 * The engine calls this only after correlated positive page verification (or an
 * already-applied queue record). Recheck persisted identity and settle every
 * durable side effect together, just like an acknowledged manual Review result.
 */
export async function settleReconciledSubmission(
  attemptId: string,
  jobId: string,
  host: string,
  note: 'Verified applied on job page after restart' | 'Queue already marked applied',
): Promise<Result<JobEvent | null>> {
  const db = await getDb();
  const tx = db.transaction(
    [DB_STORES.queue, DB_STORES.submissions, DB_STORES.meta, DB_STORES.events, DB_STORES.jobs],
    'readwrite',
  );
  const submissions = tx.objectStore(DB_STORES.submissions);
  const queue = tx.objectStore(DB_STORES.queue);
  const meta = tx.objectStore(DB_STORES.meta);
  const attempt = await submissions.get(attemptId);
  const item = await queue.get(jobId);
  const job = await tx.objectStore(DB_STORES.jobs).get(jobId);
  if (
    !attempt ||
    !item ||
    !isInternalApplication(attempt.applyType) ||
    isExternalJob(job, item) ||
    // Older persisted queue rows may lack a journal reference. Correlated
    // positive verification can claim it; a different current attempt cannot.
    (item.submissionAttemptId !== undefined && item.submissionAttemptId !== attemptId) ||
    attempt.jobId !== jobId ||
    attempt.host !== host ||
    !['started', 'submitted', 'ambiguous', 'applied'].includes(attempt.status)
  ) {
    await tx.done;
    return err(
      appError('FORBIDDEN', 'The verified application no longer matches its pending attempt.'),
    );
  }
  const at = Date.now();
  const counted = attempt.capCountedAt !== undefined;
  await submissions.put({
    ...attempt,
    status: 'applied',
    finishedAt: attempt.finishedAt ?? at,
    reconciledAt: at,
    reconciliationNote: note,
    error: undefined,
    capCountedAt: attempt.capCountedAt ?? at,
  });
  await queue.put({
    ...item,
    status: 'applied',
    updatedAt: at,
    submissionAttemptId: attemptId,
    lastError: undefined,
    pendingQuestionIds: [],
    missingDocumentTypes: [],
  });
  await meta.put({ key: `needs:${jobId}`, value: null });
  if (!counted) {
    const key = `dailyCount:${todayKey()}`;
    const count = ((await meta.get(key))?.value as number | undefined) ?? 0;
    await meta.put({ key, value: count + 1 });
  }
  const event = await appendAppliedEventOnce(
    {
      meta,
      jobs: tx.objectStore(DB_STORES.jobs),
      events: tx.objectStore(DB_STORES.events),
    },
    attemptId,
    jobId,
  );
  await tx.done;
  return ok(event);
}
