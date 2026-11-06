import { useEffect, useState } from 'react';
import {
  getBridgeMode,
  isExtensionRuntime,
  sendRequest,
  subscribeToBroadcasts,
  type BridgeMode,
} from '@/ui/bridge';

export interface BridgeHandle {
  mode: BridgeMode | null;
  isRuntime: boolean;
  send: typeof sendRequest;
  subscribe: typeof subscribeToBroadcasts;
}

/** Resolves once whether the panel talks to a real background or the demo store. */
export function useBridge(): BridgeHandle {
  const [mode, setMode] = useState<BridgeMode | null>(null);

  useEffect(() => {
    let alive = true;
    const reconnect = () => {
      void getBridgeMode().then((next) => {
        if (alive) setMode(next);
      });
    };
    reconnect();
    const timer = setInterval(reconnect, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return {
    mode,
    isRuntime: isExtensionRuntime(),
    send: sendRequest,
    subscribe: subscribeToBroadcasts,
  };
}
