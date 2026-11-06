import { useCallback } from 'react';
import type { AppError, Settings, SettingsPatch } from '@/core/contracts';
import { sendRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

export interface SettingsController {
  settings: Settings | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  save: (patch: SettingsPatch) => Promise<AppError | null>;
  setSettings: (next: Settings) => void;
}

export function useSettings(): SettingsController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.settings.get' }), []);
  const resource = usePolledResource(fetcher);
  const { setData } = resource;

  const save = useCallback(
    async (patch: SettingsPatch): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.settings.update', patch });
      if (!result.ok) return result.error;
      setData(result.value);
      return null;
    },
    [setData],
  );

  return {
    settings: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    save,
    setSettings: setData,
  };
}
