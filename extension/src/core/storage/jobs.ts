/**
 * Job repository (`jobs` store, keyPath `id`).
 *
 * Only background-side code writes here; UI/content go through messages. Jobs
 * are JSON-safe contract objects, so no mapping layer is needed.
 */

import { DB_STORES, type Job } from '@/core/contracts';
import { getDb } from '@/core/storage/db';

export const DEFAULT_JOB_LIST_LIMIT = 200;

export async function putJob(job: Job): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.jobs, job);
}

export async function getJob(id: string): Promise<Job | undefined> {
  const db = await getDb();
  return db.get(DB_STORES.jobs, id);
}

/**
 * Newest first by `discoveredAt` (id breaks ties). The store is small enough to
 * sort in memory, which keeps tie-breaking deterministic at the limit boundary.
 */
export async function listJobs(limit = DEFAULT_JOB_LIST_LIMIT): Promise<Job[]> {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) return [];
  const db = await getDb();
  const jobs = await db.getAllFromIndex(DB_STORES.jobs, 'byDiscoveredAt');
  return jobs
    .sort((a, b) => {
      if (b.discoveredAt !== a.discoveredAt) return b.discoveredAt - a.discoveredAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, count);
}

export async function deleteJob(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(DB_STORES.jobs, id);
}

export async function countJobs(): Promise<number> {
  const db = await getDb();
  return db.count(DB_STORES.jobs);
}
