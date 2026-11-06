import { useCallback } from 'react';
import type { Answer, AppError } from '@/core/contracts';
import { sendRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

const EMPTY_ANSWERS: Answer[] = [];

export interface AnswersController {
  answers: Answer[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  save: (answer: Answer) => Promise<AppError | null>;
  remove: (answerId: string) => Promise<AppError | null>;
}

export function useAnswers(): AnswersController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.answer.list' }), []);
  const resource = usePolledResource(fetcher);
  const { refresh } = resource;

  const save = useCallback(
    async (answer: Answer): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.answer.save', answer });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  const remove = useCallback(
    async (answerId: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.answer.delete', answerId });
      if (!result.ok) return result.error;
      await refresh();
      return null;
    },
    [refresh],
  );

  return {
    answers: resource.data ?? EMPTY_ANSWERS,
    loading: resource.loading,
    error: resource.error,
    refresh,
    save,
    remove,
  };
}
