/**
 * Resume-match cache (ARCHITECTURE.md §13 "Cache key", CONTRACTS.md §13.1).
 *
 * Versioned keys bind the provider/model/prompt to the job and complete resume
 * metadata. Only hashes are persisted as keys, never raw input text.
 *
 * The store is `DB_STORES.aiCache` (key path `key`, index `byCreatedAt`). The
 * entry shape is owned by `src/core/storage/db.ts`:
 *   { key, createdAt, result }
 * Cached results are re-validated on read so a corrupted/tampered entry falls
 * back to a fresh match instead of selecting an unknown resume.
 */

import { z } from 'zod';
import { DB_STORES, LIMITS } from '@/core/contracts';
import type { AiProvider, MatchInput, MatchResult } from '@/core/contracts';
import { getDb } from '@/core/storage/db';
import { sha256Hex } from '@/core/util/hash';
import type { MatchCache } from '@/ai/types';
import { AI_PROMPT_VERSION } from '@/ai/models';

/** Persisted entry shape. Must stay in sync with `db.ts` (owned by T05). */
export interface AiCacheEntry {
  key: string;
  createdAt: number;
  result: unknown;
}

/** Narrow storage adapter so tests can run without IndexedDB. */
export interface AiCacheStore {
  get(key: string): Promise<AiCacheEntry | undefined>;
  put(entry: AiCacheEntry): Promise<void>;
  getAll(): Promise<AiCacheEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const cachedResultSchema = z.object({
  resumeId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
  provider: z.enum(['heuristic', 'openrouter']),
  modelId: z.string().optional(),
});

/**
 * Deterministic cache key. Resume ids are sorted so the key does not depend on
 * the order documents were discovered in.
 */
export async function cacheKey(
  input: MatchInput,
  provider: AiProvider = 'openrouter',
  model = provider === 'heuristic' ? 'heuristic' : '',
  promptVersion = AI_PROMPT_VERSION,
): Promise<string> {
  const resumes = input.resumes
    .map(({ id, title, description }) => JSON.stringify([id, title, description]))
    .sort();
  const resumeFingerprint = await sha256Hex(JSON.stringify(resumes));
  return sha256Hex(
    JSON.stringify([
      'ai-cache-v2',
      provider,
      model,
      promptVersion,
      input.jobTitle,
      input.jobDescription,
      resumeFingerprint,
    ]),
  );
}

function idbStore(): AiCacheStore {
  return {
    async get(key) {
      const db = await getDb();
      return db.get(DB_STORES.aiCache, key);
    },
    async put(entry) {
      const db = await getDb();
      await db.put(DB_STORES.aiCache, entry);
    },
    async getAll() {
      const db = await getDb();
      return db.getAll(DB_STORES.aiCache);
    },
    async delete(key) {
      const db = await getDb();
      await db.delete(DB_STORES.aiCache, key);
    },
    async clear() {
      const db = await getDb();
      await db.clear(DB_STORES.aiCache);
    },
  };
}

/** In-memory store, exposed for tests and for a future in-memory fast path. */
export function createMemoryCacheStore(): AiCacheStore {
  const entries = new Map<string, AiCacheEntry>();
  return {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (entry) => {
      entries.set(entry.key, entry);
      return Promise.resolve();
    },
    getAll: () => Promise.resolve([...entries.values()]),
    delete: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      entries.clear();
      return Promise.resolve();
    },
  };
}

export interface CreateAiCacheOptions {
  store?: AiCacheStore;
  /** Injectable clock so `createdAt` is deterministic in tests. */
  now?: () => number;
}

export function createAiCache(options: CreateAiCacheOptions = {}): MatchCache {
  const store = options.store ?? idbStore();
  const now = options.now ?? Date.now;

  return {
    async get(key) {
      const entry = await store.get(key);
      if (!entry) return undefined;
      const parsed = cachedResultSchema.safeParse(entry.result);
      if (!parsed.success) {
        // Drop unusable entries immediately so they cannot accumulate.
        await store.delete(key);
        return undefined;
      }
      return { ...parsed.data, cached: true };
    },
    async put(key, result: MatchResult) {
      await store.put({
        key,
        createdAt: now(),
        result: {
          resumeId: result.resumeId,
          confidence: result.confidence,
          reason: result.reason,
          provider: result.provider,
          modelId: result.modelId,
        },
      });
    },
    async prune(limit: number = LIMITS.maxAiCache) {
      const max = Math.max(0, Math.floor(limit));
      const entries = await store.getAll();
      if (entries.length <= max) return 0;
      const oldestFirst = [...entries].sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          (left.key === right.key ? 0 : left.key < right.key ? -1 : 1),
      );
      const removeCount = oldestFirst.length - max;
      const doomed = oldestFirst.slice(0, removeCount);
      for (const entry of doomed) {
        await store.delete(entry.key);
      }
      return doomed.length;
    },
    clear: () => store.clear(),
  };
}

/** Removes every cached match. Used by the danger-zone reset and diagnostics. */
export async function clearAiCache(): Promise<void> {
  await createAiCache().clear();
}

/** Trims the cache to `LIMITS.maxAiCache` entries (oldest first). */
export async function pruneAiCache(limit: number = LIMITS.maxAiCache): Promise<number> {
  return createAiCache().prune(limit);
}
