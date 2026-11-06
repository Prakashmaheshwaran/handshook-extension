import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastLevel, ToastRecord } from '@/ui/components/Toast';
import { isBroadcast, subscribeToBroadcasts } from '@/ui/bridge';

const MAX_VISIBLE = 3;
const TTL_MS: Record<ToastLevel, number> = {
  info: 5_000,
  success: 4_000,
  warn: 7_000,
  error: 9_000,
};

export interface ToastController {
  toasts: ToastRecord[];
  notify: (level: ToastLevel, message: string) => void;
  dismiss: (id: string) => void;
}

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (level: ToastLevel, message: string) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, level, message }]);
      const timer = setTimeout(() => dismiss(id), TTL_MS[level]);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (isBroadcast(message) && message.type === 'toast')
          notify(message.level, message.message);
      }),
    [notify],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, notify, dismiss };
}
