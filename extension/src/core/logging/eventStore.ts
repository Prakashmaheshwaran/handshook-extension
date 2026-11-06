import { DB_STORES, LIMITS, type JobEvent } from '@/core/contracts';
import { getDb } from '@/core/storage/db';

export async function appendEvent(event: JobEvent): Promise<void> {
  const db = await getDb();
  await db.put(DB_STORES.events, event);
  const all = await db.getAllFromIndex(DB_STORES.events, 'byAt');
  if (all.length > LIMITS.maxEvents) {
    const tx = db.transaction(DB_STORES.events, 'readwrite');
    for (const old of all.slice(0, all.length - LIMITS.maxEvents)) {
      await tx.store.delete(old.id);
    }
    await tx.done;
  }
}

export async function listEvents(limit = 200, level?: JobEvent['level']): Promise<JobEvent[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(DB_STORES.events, 'byAt');
  const filtered = level ? all.filter((event) => event.level === level) : all;
  return filtered.slice(-limit).reverse();
}

export async function clearEvents(): Promise<void> {
  const db = await getDb();
  await db.clear(DB_STORES.events);
}
