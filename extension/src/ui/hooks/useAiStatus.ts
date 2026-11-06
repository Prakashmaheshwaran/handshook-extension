import { useCallback } from 'react';
import type {
  AiProvider,
  AppError,
  OpenRouterKeyInfo,
  OpenRouterModelSummary,
} from '@/core/contracts';
import { sendRequest, type AiStatusPayload, type AiTestPayload } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

export interface AiController {
  status: AiStatusPayload | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  saveKey: (apiKey: string) => Promise<AppError | null>;
  clearKey: () => Promise<AppError | null>;
  test: (provider: AiProvider) => Promise<AiTestPayload | AppError>;
  loadModels: (
    refresh?: boolean,
  ) => Promise<{ models: OpenRouterModelSummary[]; fetchedAt: number } | AppError>;
  keyInfo: () => Promise<OpenRouterKeyInfo | AppError>;
  dismissMigrationNotice: () => Promise<AppError | null>;
}

export function useAiStatus(): AiController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.ai.status' }), []);
  const resource = usePolledResource(fetcher);
  const { mutate } = resource;

  const saveKey = useCallback(
    async (apiKey: string): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.ai.setKey', apiKey });
      if (!result.ok) return result.error;
      mutate((current) =>
        current
          ? {
              ...current,
              openRouterConfigured: true,
              openRouterPermission: 'granted',
              openRouterMessage: undefined,
            }
          : current,
      );
      return null;
    },
    [mutate],
  );

  const clearKey = useCallback(async (): Promise<AppError | null> => {
    const result = await sendRequest({ type: 'ui.ai.clearKey' });
    if (!result.ok) return result.error;
    mutate((current) =>
      current ? { ...current, openRouterConfigured: false, openRouterMessage: undefined } : current,
    );
    return null;
  }, [mutate]);

  const test = useCallback(async (provider: AiProvider): Promise<AiTestPayload | AppError> => {
    const result = await sendRequest({ type: 'ui.ai.test', provider });
    return result.ok ? result.value : result.error;
  }, []);

  const loadModels = useCallback(async (refresh = false) => {
    const result = await sendRequest({ type: 'ui.ai.openrouter.models', refresh });
    return result.ok ? result.value : result.error;
  }, []);

  const keyInfo = useCallback(async () => {
    const result = await sendRequest({ type: 'ui.ai.openrouter.keyInfo' });
    return result.ok ? result.value : result.error;
  }, []);

  const dismissMigrationNotice = useCallback(async () => {
    const result = await sendRequest({ type: 'ui.ai.dismissMigrationNotice' });
    if (!result.ok) return result.error;
    mutate((current) => (current ? { ...current, geminiReplacedNotice: false } : current));
    return null;
  }, [mutate]);

  return {
    status: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    saveKey,
    clearKey,
    test,
    loadModels,
    keyInfo,
    dismissMigrationNotice,
  };
}
