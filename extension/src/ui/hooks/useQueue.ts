import { useCallback, useEffect } from 'react';
import type { AppError, Job, QueueItem, QueueSummary } from '@/core/contracts';
import { isBroadcast, sendRequest, subscribeToBroadcasts, type NeedsRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

const EMPTY_ITEMS: QueueItem[] = [];
const EMPTY_JOBS: Job[] = [];
const EMPTY_NEEDS: NeedsRequest[] = [];

export interface QueueController {
  items: QueueItem[];
  jobs: Job[];
  needs: NeedsRequest[];
  summary: QueueSummary | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  retry: (jobId: string) => Promise<AppError | null>;
  skip: (jobId: string, reason: string) => Promise<AppError | null>;
  applyNow: (jobId: string) => Promise<AppError | null>;
  jobsById: Map<string, Job>;
}

export function useQueue(externalOnly = false): QueueController {
  const fetcher = useCallback(
    () =>
      sendRequest({
        type: 'ui.queue.list',
        limit: 100,
        offset: 0,
        ...(externalOnly ? { status: ['external'] } : {}),
      }),
    [externalOnly],
  );
  const resource = usePolledResource(fetcher, { intervalMs: 6_000 });
  const { refresh, mutate } = resource;

  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (!isBroadcast(message)) return;
        if (message.type === 'queue.changed') {
          mutate((current) =>
            current
              ? { ...current, summary: message.summary }
              : { items: [], jobs: [], needs: [], summary: message.summary },
          );
          void refresh();
        } else if (message.type === 'needs.you') {
          // Details remain authoritative in the worker; fetch on the event,
          // including when the periodic fallback has not fired yet.
          void refresh();
        }
      }),
    [refresh, mutate],
  );

  const retry = useCallback(
    async (jobId: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.queue.retry', jobId });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  const skip = useCallback(
    async (jobId: string, reason: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.queue.skip', jobId, reason });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  const applyNow = useCallback(
    async (jobId: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.queue.applyNow', jobId });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  const jobsById = new Map<string, Job>();
  for (const job of resource.data?.jobs ?? EMPTY_JOBS) {
    jobsById.set(job.id, job);
  }

  return {
    items: resource.data?.items ?? EMPTY_ITEMS,
    jobs: resource.data?.jobs ?? EMPTY_JOBS,
    needs: resource.data?.needs ?? EMPTY_NEEDS,
    summary: resource.data?.summary ?? null,
    loading: resource.loading,
    error: resource.error,
    refresh,
    retry,
    skip,
    applyNow,
    jobsById,
  };
}
