import { useCallback } from 'react';
import type { AppError, OnboardingState, Settings } from '@/core/contracts';
import { now } from '@/core/util/time';
import { sendRequest } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

export interface OnboardingController {
  onboarding: OnboardingState | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  update: (patch: Partial<OnboardingState>) => Promise<AppError | null>;
  complete: (settingsPatch?: {
    mode?: Settings['mode'];
    reviewBeforeSubmit?: boolean;
    allowOneClickApply?: boolean;
  }) => Promise<AppError | null>;
}

export function useOnboarding(): OnboardingController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.onboarding.get' }), []);
  const resource = usePolledResource(fetcher);
  const { setData, refresh } = resource;

  const update = useCallback(
    async (patch: Partial<OnboardingState>): Promise<AppError | null> => {
      const result = await sendRequest({ type: 'ui.onboarding.update', patch });
      if (!result.ok) return result.error;
      setData(result.value);
      return null;
    },
    [setData],
  );

  const complete = useCallback(
    async (settingsPatch?: {
      mode?: Settings['mode'];
      reviewBeforeSubmit?: boolean;
      allowOneClickApply?: boolean;
    }): Promise<AppError | null> => {
      if (settingsPatch?.mode) {
        const saved = await sendRequest({
          type: 'ui.settings.update',
          patch: {
            mode: settingsPatch.mode,
            onboardingComplete: true,
            safety: {
              ...(settingsPatch.reviewBeforeSubmit !== undefined
                ? { reviewBeforeSubmit: settingsPatch.reviewBeforeSubmit }
                : {}),
              ...(settingsPatch.allowOneClickApply !== undefined
                ? { allowOneClickApply: settingsPatch.allowOneClickApply }
                : {}),
            },
          },
        });
        if (!saved.ok) return saved.error;
      }
      const result = await sendRequest({
        type: 'ui.onboarding.update',
        patch: { step: 'done', completedAt: now() },
      });
      if (!result.ok) return result.error;
      setData(result.value);
      await refresh();
      return null;
    },
    [refresh, setData],
  );

  return {
    onboarding: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh,
    update,
    complete,
  };
}
