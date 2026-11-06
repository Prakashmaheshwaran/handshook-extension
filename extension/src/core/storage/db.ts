import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_STORES, DB_VERSION, LIMITS } from '@/core/contracts';
import type {
  Answer,
  DocumentRecord,
  Job,
  JobEvent,
  QueueItem,
  SubmissionAttempt,
} from '@/core/contracts';
import { todayKey } from '@/core/util/time';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';

interface HandshookDB extends DBSchema {
  jobs: {
    key: string;
    value: Job;
    indexes: { byHost: string; byDiscoveredAt: number; byApplyType: string };
  };
  queue: {
    key: string;
    value: QueueItem;
    indexes: { byStatus: string; byUpdatedAt: number; byNextAttemptAt: number };
  };
  events: {
    key: string;
    value: JobEvent;
    indexes: { byAt: number; byJobId: string; byLevel: string };
  };
  answers: { key: string; value: Answer; indexes: { byUpdatedAt: number; bySensitive: string } };
  documents: { key: string; value: DocumentRecord; indexes: { byType: string } };
  aiCache: {
    key: string;
    value: { key: string; createdAt: number; result: unknown };
    indexes: { byCreatedAt: number };
  };
  submissions: {
    key: string;
    value: SubmissionAttempt;
    indexes: { byJobId: string; byCreatedAt: number };
  };
  meta: { key: string; value: { key: string; value: unknown } };
}

let dbPromise: Promise<IDBPDatabase<HandshookDB>> | null = null;
let resetInProgress = false;

export function getDb(): Promise<IDBPDatabase<HandshookDB>> {
  if (resetInProgress) {
    return Promise.reject(
      new Error('Local data is being reset. Wait for the reset to finish, then retry.'),
    );
  }
  if (!dbPromise) {
    dbPromise = openDB<HandshookDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const jobs = db.createObjectStore(DB_STORES.jobs, { keyPath: 'id' });
        jobs.createIndex('byHost', 'host');
        jobs.createIndex('byDiscoveredAt', 'discoveredAt');
        jobs.createIndex('byApplyType', 'applyType');

        const queue = db.createObjectStore(DB_STORES.queue, { keyPath: 'jobId' });
        queue.createIndex('byStatus', 'status');
        queue.createIndex('byUpdatedAt', 'updatedAt');
        queue.createIndex('byNextAttemptAt', 'nextAttemptAt');

        const events = db.createObjectStore(DB_STORES.events, { keyPath: 'id' });
        events.createIndex('byAt', 'at');
        events.createIndex('byJobId', 'jobId');
        events.createIndex('byLevel', 'level');

        const answers = db.createObjectStore(DB_STORES.answers, { keyPath: 'id' });
        answers.createIndex('byUpdatedAt', 'updatedAt');
        answers.createIndex('bySensitive', 'sensitive');

        const documents = db.createObjectStore(DB_STORES.documents, { keyPath: 'id' });
        documents.createIndex('byType', 'type');

        const aiCache = db.createObjectStore(DB_STORES.aiCache, { keyPath: 'key' });
        aiCache.createIndex('byCreatedAt', 'createdAt');

        const submissions = db.createObjectStore(DB_STORES.submissions, { keyPath: 'id' });
        submissions.createIndex('byJobId', 'jobId');
        submissions.createIndex('byCreatedAt', 'startedAt');

        const meta = db.createObjectStore(DB_STORES.meta, { keyPath: 'key' });
        // A new database already uses the current answer defaults; only data
        // saved by an older build gets the one-time answer upgrade.
        void meta.put({ key: ANSWERS_DEFAULTS_KEY, value: ANSWERS_DEFAULTS_REVISION });
      },
    });
  }
  return dbPromise;
}

export async function resetDb(): Promise<void> {
  if (resetInProgress) throw new Error('A reset is already in progress.');
  resetInProgress = true;
  try {
    if (dbPromise) {
      try {
        (await dbPromise).close();
      } catch {
        // The database never opened.
      }
    }
    dbPromise = null;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Local data could not be deleted'));
      // M13: a blocked delete means another context still holds the database.
      // Reporting success here would leave data behind while telling the user
      // it was cleared.
      request.onblocked = () =>
        reject(
          new Error(
            'Local data could not be deleted because another Handshook tab still has it open. Close other Handshook tabs and reset again.',
          ),
        );
    });
  } finally {
    resetInProgress = false;
  }
}

/** Bumped when stored answers should adopt a new product default once. */
export const ANSWERS_DEFAULTS_REVISION = 1;
export const ANSWERS_DEFAULTS_KEY = 'answersDefaultsRevision';

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const entry = await db.get(DB_STORES.meta, key);
  return entry?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.meta, { key, value });
}

export async function getTodayCount(date = new Date()): Promise<number> {
  const day = todayKey(date);
  const db = await getDb();
  const tx = db.transaction(
    [DB_STORES.meta, DB_STORES.submissions, DB_STORES.jobs, DB_STORES.queue],
    'readonly',
  );
  const count =
    ((await tx.objectStore(DB_STORES.meta).get(`dailyCount:${day}`))?.value as
      number | undefined) ?? 0;
  let excluded = 0;
  let internal = 0;
  for (const attempt of await tx.objectStore(DB_STORES.submissions).getAll()) {
    if (attempt.capCountedAt === undefined || todayKey(new Date(attempt.capCountedAt)) !== day)
      continue;
    if (
      !isInternalApplication(attempt.applyType) ||
      isExternalJob(
        await tx.objectStore(DB_STORES.jobs).get(attempt.jobId),
        await tx.objectStore(DB_STORES.queue).get(attempt.jobId),
      )
    )
      excluded += 1;
    else internal += 1;
  }
  await tx.done;
  // Correct identifiable old external reservations without deleting journal/history.
  // Keep uncertain internal sends and any unallocated imported cap reservations.
  return Math.max(internal, count - excluded, 0);
}

export async function incrementTodayCount(date = new Date()): Promise<number> {
  const key = `dailyCount:${todayKey(date)}`;
  const db = await getDb();
  const tx = db.transaction(DB_STORES.meta, 'readwrite');
  const current = ((await tx.store.get(key))?.value as number | undefined) ?? 0;
  const next = current + 1;
  await tx.store.put({ key, value: next });
  await tx.done;
  return next;
}

export async function pruneLocalData(): Promise<void> {
  const db = await getDb();
  const events = await db.getAll(DB_STORES.events);
  if (events.length > LIMITS.maxEvents) {
    const tx = db.transaction(DB_STORES.events, 'readwrite');
    for (const event of events.slice(0, events.length - LIMITS.maxEvents)) {
      await tx.store.delete(event.id);
    }
    await tx.done;
  }
  const cache = await db.getAll(DB_STORES.aiCache);
  if (cache.length > LIMITS.maxAiCache) {
    const tx = db.transaction(DB_STORES.aiCache, 'readwrite');
    for (const entry of cache.slice(0, cache.length - LIMITS.maxAiCache)) {
      await tx.store.delete(entry.key);
    }
    await tx.done;
  }
}

export async function resetAllLocalData(): Promise<void> {
  await resetDb();
}
