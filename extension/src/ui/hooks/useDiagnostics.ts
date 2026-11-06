import { useCallback } from 'react';
import type { AppError } from '@/core/contracts';
import { sendRequest, type DiagnosticsPayload, type ExportPayload } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

export interface DiagnosticsController {
  diagnostics: DiagnosticsPayload | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  clear: () => Promise<AppError | null>;
  exportBundle: () => Promise<{ payload: ExportPayload | null; error: AppError | null }>;
}

export function useDiagnostics(): DiagnosticsController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.diagnostics.get' }), []);
  const resource = usePolledResource(fetcher, { intervalMs: 15_000 });
  const { mutate } = resource;

  const clear = useCallback(async (): Promise<AppError | null> => {
    const result = await sendRequest({ type: 'ui.diagnostics.clear' });
    if (!result.ok) return result.error;
    mutate((current) => (current ? { ...current, selectors: [], recentErrors: [] } : current));
    return null;
  }, [mutate]);

  const exportBundle = useCallback(async () => {
    const result = await sendRequest({ type: 'ui.diagnostics.export' });
    if (!result.ok) return { payload: null, error: result.error };
    return { payload: result.value, error: null };
  }, []);

  return {
    diagnostics: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    clear,
    exportBundle,
  };
}
