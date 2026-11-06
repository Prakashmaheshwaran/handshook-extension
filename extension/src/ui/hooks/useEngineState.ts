import { useCallback, useEffect, useState } from 'react';
import type { AppError, EngineState, RunMode } from '@/core/contracts';
import { isBroadcast, sendRequest, subscribeToBroadcasts } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

export type EngineAction = 'start' | 'pause' | 'resume' | 'stop';

/**
 * The action result keeps the returned EngineState so callers can report what
 * actually happened (a start can legitimately come back paused or needs_user).
 */
export interface EngineActionResult {
  error: AppError | null;
  state: EngineState | null;
}

export interface EngineController {
  state: EngineState | null;
  loading: boolean;
  error: AppError | null;
  pending: EngineAction | null;
  refresh: () => Promise<AppError | null>;
  start: (mode?: RunMode) => Promise<EngineActionResult>;
  pause: () => Promise<EngineActionResult>;
  resume: () => Promise<EngineActionResult>;
  stop: () => Promise<EngineActionResult>;
}

export function useEngineState(): EngineController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.engine.getState' }), []);
  const resource = usePolledResource(fetcher, { intervalMs: 5_000 });
  const { setData, refresh } = resource;
  const [pending, setPending] = useState<EngineAction | null>(null);

  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (isBroadcast(message) && message.type === 'state.changed') {
          setData(message.state);
        }
      }),
    [setData],
  );

  const start = useCallback(
    async (mode?: RunMode): Promise<EngineActionResult> => {
      setPending('start');
      try {
        const result = await sendRequest({ type: 'ui.engine.start', mode });
        if (!result.ok) return { error: result.error, state: null };
        setData(result.value);
        return { error: null, state: result.value };
      } finally {
        setPending(null);
      }
    },
    [setData],
  );

  const pause = useCallback(async (): Promise<EngineActionResult> => {
    setPending('pause');
    try {
      const result = await sendRequest({ type: 'ui.engine.pause' });
      if (!result.ok) return { error: result.error, state: null };
      setData(result.value);
      return { error: null, state: result.value };
    } finally {
      setPending(null);
    }
  }, [setData]);

  const resume = useCallback(async (): Promise<EngineActionResult> => {
    setPending('resume');
    try {
      const result = await sendRequest({ type: 'ui.engine.resume' });
      if (!result.ok) return { error: result.error, state: null };
      setData(result.value);
      return { error: null, state: result.value };
    } finally {
      setPending(null);
    }
  }, [setData]);

  const stop = useCallback(async (): Promise<EngineActionResult> => {
    setPending('stop');
    try {
      const result = await sendRequest({ type: 'ui.engine.stop' });
      if (!result.ok) return { error: result.error, state: null };
      setData(result.value);
      return { error: null, state: result.value };
    } finally {
      setPending(null);
    }
  }, [setData]);

  return {
    state: resource.data,
    loading: resource.loading,
    error: resource.error,
    pending,
    refresh,
    start,
    pause,
    resume,
    stop,
  };
}
