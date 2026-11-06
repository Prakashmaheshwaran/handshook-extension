import { createContext, useContext } from 'react';
import type { AppError, EngineState, RunMode, Settings, SettingsPatch } from '@/core/contracts';
import type { BridgeMode } from '@/ui/bridge';
import type { ToastLevel } from '@/ui/components/Toast';
import type { EngineAction, EngineActionResult } from '@/ui/hooks/useEngineState';
import type { View } from '@/ui/router';

export interface AppContextValue {
  engine: EngineState | null;
  engineLoading: boolean;
  engineError: AppError | null;
  enginePending: EngineAction | null;
  refreshEngine: () => Promise<AppError | null>;
  // `null` is allowed for test doubles that only care about the error result.
  start: (mode?: RunMode) => Promise<EngineActionResult | null>;
  pause: () => Promise<EngineActionResult | null>;
  resume: () => Promise<EngineActionResult | null>;
  stop: () => Promise<EngineActionResult | null>;

  settings: Settings | null;
  settingsLoading: boolean;
  settingsError: AppError | null;
  refreshSettings: () => Promise<AppError | null>;
  saveSettings: (patch: SettingsPatch) => Promise<AppError | null>;
  applySettings: (next: Settings) => void;

  view: View;
  navigate: (view: View) => void;

  notify: (level: ToastLevel, message: string) => void;

  bridgeMode: BridgeMode | null;
  version: string;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useAppContext must be rendered inside <App>.');
  return value;
}
