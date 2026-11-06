import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError, Result } from '@/core/contracts';

export interface PolledResourceOptions {
  /** 0 disables polling. */
  intervalMs?: number;
  enabled?: boolean;
}

export interface PolledResource<T> {
  data: T | null;
  /** True while the first load or a manual refresh is in flight. */
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<AppError | null>;
  setData: (value: T) => void;
  mutate: (updater: (current: T | null) => T | null) => void;
}

/**
 * Fetch-on-mount plus optional polling, with stale-response protection.
 * `fetcher` must be referentially stable (wrap it in useCallback). Polling is
 * silent so live buttons do not flicker every interval.
 */
export function usePolledResource<T>(
  fetcher: () => Promise<Result<T>>,
  options: PolledResourceOptions = {},
): PolledResource<T> {
  const { intervalMs = 0, enabled = true } = options;
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<AppError | null>(null);
  const mountedRef = useRef(true);
  const ticketRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (silent: boolean): Promise<AppError | null> => {
      const ticket = ++ticketRef.current;
      if (!silent) setLoading(true);
      const result = await fetcher();
      if (mountedRef.current && ticket === ticketRef.current) {
        if (!silent) setLoading(false);
        if (result.ok) {
          setDataState(result.value);
          setError(null);
          return null;
        }
        setError(result.error);
        return result.error;
      }
      return result.ok ? null : result.error;
    },
    [fetcher],
  );

  const refresh = useCallback((): Promise<AppError | null> => execute(false), [execute]);

  useEffect(() => {
    if (!enabled) return undefined;
    // Deferred one tick so the first fetch never sets state during the effect
    // body (React purity) while still rendering data immediately.
    const initial = setTimeout(() => {
      void execute(false);
    }, 0);
    const timer =
      intervalMs > 0
        ? setInterval(() => {
            void execute(true);
          }, intervalMs)
        : undefined;
    return () => {
      clearTimeout(initial);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [enabled, execute, intervalMs]);

  const setData = useCallback((value: T) => {
    ticketRef.current += 1;
    setDataState(value);
    setLoading(false);
    setError(null);
  }, []);

  const mutate = useCallback((updater: (current: T | null) => T | null) => {
    ticketRef.current += 1;
    setDataState((current) => updater(current));
    setLoading(false);
    setError(null);
  }, []);

  return { data, loading, error, refresh, setData, mutate };
}
