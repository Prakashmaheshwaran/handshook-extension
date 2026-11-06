import { useCallback } from 'react';
import type { AppError, InboxQuestion } from '@/core/contracts';
import { sendRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

const EMPTY: InboxQuestion[] = [];

export interface QuestionInboxController {
  questions: InboxQuestion[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  dismiss: (key: string) => Promise<AppError | null>;
}

/** Questions met on application forms that no saved answer covers yet. */
export function useQuestionInbox(): QuestionInboxController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.questions.list' }), []);
  const resource = usePolledResource(fetcher);
  const { refresh } = resource;

  const dismiss = useCallback(
    async (key: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.questions.dismiss', key });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  return {
    questions: Array.isArray(resource.data) ? resource.data : EMPTY,
    loading: resource.loading,
    error: resource.error,
    refresh,
    dismiss,
  };
}
