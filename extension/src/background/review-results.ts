import { DB_STORES, appError, err, ok, type ContentEvent, type Result } from '@/core/contracts';
import { getDb } from '@/core/storage/db';
import { todayKey } from '@/core/util/time';
import { redactText } from '@/core/logging/redact';
import { hasPositiveSubmissionEvidence } from '@/core/contracts/submitAuthorization';
import { appendAppliedEventOnce } from '@/core/storage/submission-settlement';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';

export async function getReviewAppliedEvent(attemptId: string) {
  return (await getDb()).get(DB_STORES.events, attemptId);
}

/** Queue and journal commit together. The shared durable cap marker makes retries safe. */
export async function settleReviewResult(
  event: Extract<ContentEvent, { type: 'content.event.result' }>,
  runId: string | undefined,
): Promise<Result<boolean>> {
  if (event.result.outcome !== 'applied') return ok(false);
  if (!hasPositiveSubmissionEvidence(event.result))
    return err(appError('INVALID_INPUT', 'Positive submission evidence is required.'));
  const db = await getDb();
  const tx = db.transaction(
    [DB_STORES.queue, DB_STORES.submissions, DB_STORES.meta, DB_STORES.events, DB_STORES.jobs],
    'readwrite',
  );
  const queue = tx.objectStore(DB_STORES.queue);
  const submissions = tx.objectStore(DB_STORES.submissions);
  const item = await queue.get(event.jobId);
  const attempt = await submissions.get(event.requestId);
  const job = await tx.objectStore(DB_STORES.jobs).get(event.jobId);
  if (
    !item ||
    !attempt ||
    !isInternalApplication(attempt.applyType) ||
    isExternalJob(job, item) ||
    item.submissionAttemptId !== event.requestId ||
    attempt.jobId !== event.jobId ||
    !runId ||
    attempt.runId !== runId ||
    ![
      'opening',
      'filling',
      'submitting',
      'ready_for_review',
      'needs_input',
      'verifying',
      'skipped',
      'applied',
    ].includes(item.status)
  ) {
    await tx.done;
    return err(appError('FORBIDDEN', 'This Review result does not match the pending application.'));
  }
  const changed = attempt.status !== 'applied';
  if (changed) {
    const at = Date.now();
    await submissions.put({
      ...attempt,
      status: 'applied',
      finishedAt: at,
      reconciledAt: at,
      reconciliationNote: 'Confirmed by the user in the runner tab',
      confirmationText: redactText(event.result.confirmationText ?? ''),
      error: undefined,
    });
    await queue.put({
      ...item,
      status: 'applied',
      updatedAt: at,
      lastError: undefined,
      pendingQuestionIds: [],
      missingDocumentTypes: [],
    });
    await tx.objectStore(DB_STORES.meta).put({ key: `needs:${event.jobId}`, value: null });
  }
  const counted = attempt.capCountedAt === undefined;
  if (counted) {
    const meta = tx.objectStore(DB_STORES.meta);
    const key = `dailyCount:${todayKey()}`;
    const count = ((await meta.get(key))?.value as number | undefined) ?? 0;
    await meta.put({ key, value: count + 1 });
    const settled = await submissions.get(event.requestId);
    if (settled) await submissions.put({ ...settled, capCountedAt: Date.now() });
  }
  const eventAdded = await appendAppliedEventOnce(
    {
      meta: tx.objectStore(DB_STORES.meta),
      jobs: tx.objectStore(DB_STORES.jobs),
      events: tx.objectStore(DB_STORES.events),
    },
    event.requestId,
    event.jobId,
  );
  await tx.done;
  return ok(changed || counted || eventAdded !== null);
}
