import { useCallback, useEffect } from 'react';
import type { AnswerValue, AppError } from '@/core/contracts';
import { isBroadcast, sendRequest, subscribeToBroadcasts, type NeedsRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

const EMPTY_NEEDS: NeedsRequest[] = [];

export interface NeedsController {
  needs: NeedsRequest[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  answer: (
    jobId: string,
    questionId: string,
    value: AnswerValue,
    remember: boolean,
  ) => Promise<AppError | null>;
  skip: (jobId: string, reason: string) => Promise<AppError | null>;
}

export function useNeeds(): NeedsController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.needs.list' }), []);
  const resource = usePolledResource(fetcher, { intervalMs: 8_000 });
  const { refresh } = resource;

  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (isBroadcast(message) && message.type === 'needs.you') {
          void refresh();
        }
      }),
    [refresh],
  );

  const answer = useCallback(
    async (
      jobId: string,
      questionId: string,
      value: AnswerValue,
      remember: boolean,
    ): Promise<AppError | null> => {
      const result = await sendRequest({
        type: 'ui.job.answer',
        jobId,
        questionId,
        value,
        remember,
      });
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

  return {
    needs: resource.data ?? EMPTY_NEEDS,
    loading: resource.loading,
    error: resource.error,
    refresh,
    answer,
    skip,
  };
}
