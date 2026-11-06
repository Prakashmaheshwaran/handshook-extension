import { DB_STORES, type SubmissionAttempt } from '@/core/contracts';
import { getDb } from '@/core/storage/db';
import { uuid } from '@/core/util/hash';
import { todayKey } from '@/core/util/time';
import { isInternalApplication, isExternalJob } from '@/core/util/application-policy';

/** Atomically reserve the daily cap once for a confirmed OR uncertain send. */
export async function countAttemptTowardCapOnce(attemptId: string): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(
    [DB_STORES.meta, DB_STORES.submissions, DB_STORES.jobs, DB_STORES.queue],
    'readwrite',
  );
  const attempt = await tx.objectStore(DB_STORES.submissions).get(attemptId);
  if (
    !attempt ||
    attempt.capCountedAt !== undefined ||
    !isInternalApplication(attempt.applyType) ||
    isExternalJob(
      await tx.objectStore(DB_STORES.jobs).get(attempt.jobId),
      await tx.objectStore(DB_STORES.queue).get(attempt.jobId),
    )
  ) {
    await tx.done;
    return false;
  }
  const meta = tx.objectStore(DB_STORES.meta);
  const key = `dailyCount:${todayKey()}`;
  const count = ((await meta.get(key))?.value as number | undefined) ?? 0;
  await meta.put({ key, value: count + 1 });
  await tx.objectStore(DB_STORES.submissions).put({ ...attempt, capCountedAt: Date.now() });
  await tx.done;
  return true;
}

export async function createSubmission(
  attempt: Omit<SubmissionAttempt, 'id'>,
): Promise<SubmissionAttempt> {
  const db = await getDb();
  const record: SubmissionAttempt = { ...attempt, id: uuid() };
  await db.put(DB_STORES.submissions, record);
  return record;
}

export async function updateSubmission(
  id: string,
  patch: Partial<SubmissionAttempt>,
): Promise<SubmissionAttempt | undefined> {
  const db = await getDb();
  const tx = db.transaction(DB_STORES.submissions, 'readwrite');
  const current = await tx.store.get(id);
  if (!current) {
    await tx.done;
    return undefined;
  }
  // A late form handoff cannot erase an already observed manual submission.
  const next = {
    ...current,
    ...patch,
    id,
    capCountedAt: current.capCountedAt ?? patch.capCountedAt,
    ...(current.status === 'applied'
      ? {
          status: current.status,
          confirmationText: current.confirmationText,
          error: undefined,
        }
      : {}),
  };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** Removes an attempt that never represented a submission (for example a dry run). */
export async function deleteSubmission(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(DB_STORES.submissions, id);
}

export async function getSubmissionsForJob(jobId: string): Promise<SubmissionAttempt[]> {
  const db = await getDb();
  return db.getAllFromIndex(DB_STORES.submissions, 'byJobId', jobId);
}

export async function listUnresolvedSubmissions(): Promise<SubmissionAttempt[]> {
  const db = await getDb();
  const all = await db.getAll(DB_STORES.submissions);
  return all.filter((attempt) => ['started', 'submitted', 'ambiguous'].includes(attempt.status));
}
