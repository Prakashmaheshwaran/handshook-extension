import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, JobEvent } from '@/core/contracts';
import { isBroadcast, sendRequest, subscribeToBroadcasts, type ExportPayload } from '@/ui/bridge';
import { usePolledResource } from './usePolledResource';

const MAX_EVENTS = 500;

export interface EventsController {
  events: JobEvent[];
  loading: boolean;
  error: AppError | null;
  live: boolean;
  setLive: (live: boolean) => void;
  refresh: () => Promise<AppError | null>;
  clear: () => Promise<AppError | null>;
  exportBundle: () => Promise<{ payload: ExportPayload | null; error: AppError | null }>;
}

export function useEvents(): EventsController {
  const fetcher = useCallback(() => sendRequest({ type: 'ui.events.list', limit: 200 }), []);
  const resource = usePolledResource(fetcher, { intervalMs: 10_000 });
  const { mutate, setData } = resource;
  const [live, setLiveState] = useState(true);
  const liveRef = useRef(true);

  const setLive = useCallback((next: boolean) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (!isBroadcast(message) || message.type !== 'event.appended') return;
        if (!liveRef.current) return;
        mutate((current) =>
          [
            message.event,
            ...(current ?? []).filter((event) => event.id !== message.event.id),
          ].slice(0, MAX_EVENTS),
        );
      }),
    [mutate],
  );

  const clear = useCallback(async (): Promise<AppError | null> => {
    const result = await sendRequest({ type: 'ui.diagnostics.clear' });
    if (!result.ok) return result.error;
    setData([]);
    return null;
  }, [setData]);

  const exportBundle = useCallback(async () => {
    const result = await sendRequest({ type: 'ui.diagnostics.export' });
    if (!result.ok) return { payload: null, error: result.error };
    return { payload: result.value, error: null };
  }, []);

  const events = useMemo(
    () => [...(resource.data ?? [])].sort((a, b) => b.at - a.at),
    [resource.data],
  );

  return {
    events,
    loading: resource.loading,
    error: resource.error,
    live,
    setLive,
    refresh: resource.refresh,
    clear,
    exportBundle,
  };
}
