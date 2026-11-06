import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  mergeSettings,
  parseSettings,
  isRecord,
  type AiKeys,
  type EngineState,
  type OnboardingState,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { getTodayCount } from '@/core/storage/db';
import { now } from '@/core/util/time';
import {
  hasLegacyGeminiConfig,
  needsPacingUpgrade,
  upgradeStoredSettings,
} from './settings-upgrade';

interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

function getArea(): StorageArea | null {
  const scope = globalThis as unknown as {
    browser?: { storage?: { local?: StorageArea } };
    chrome?: { storage?: { local?: StorageArea } };
  };
  return scope.browser?.storage?.local ?? scope.chrome?.storage?.local ?? null;
}

function localFallbackKey(key: string): string {
  return `handshook.fallback.${key}`;
}

/** Content scripts must not read the key or mutate settings through Storage API. */
export async function restrictLocalStorageAccess(): Promise<void> {
  const area = getArea();
  // No extension storage exists in the standalone test/preview environment.
  if (!area) return;
  await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

async function readRaw<T>(key: string, fallback: T): Promise<T> {
  const area = getArea();
  if (area) {
    const values = await area.get(key);
    return (values[key] as T | undefined) ?? fallback;
  }
  try {
    const raw = globalThis.localStorage?.getItem(localFallbackKey(key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeRaw(key: string, value: unknown): Promise<void> {
  const area = getArea();
  if (area) {
    await area.set({ [key]: value });
    return;
  }
  globalThis.localStorage?.setItem(localFallbackKey(key), JSON.stringify(value));
}

export async function markAiMigration(): Promise<void> {
  const previous = await readRaw<unknown>(STORAGE_KEYS.aiMigration, null);
  if (isRecord(previous) && previous.geminiReplaced === true) return;
  await writeRaw(STORAGE_KEYS.aiMigration, { geminiReplaced: true, notified: false });
}

export async function hasAiMigrationNotice(): Promise<boolean> {
  const flag = await readRaw<unknown>(STORAGE_KEYS.aiMigration, null);
  return isRecord(flag) && flag.geminiReplaced === true && flag.notified === false;
}

export async function dismissAiMigrationNotice(): Promise<void> {
  if (await hasAiMigrationNotice()) {
    await writeRaw(STORAGE_KEYS.aiMigration, { geminiReplaced: true, notified: true });
  }
}

export async function loadSettings(): Promise<Settings> {
  await loadAiKeys();
  const raw = await readRaw<unknown>(STORAGE_KEYS.settings, null);
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  const parsed = parseSettings(upgradeStoredSettings(raw));
  if (
    hasLegacyGeminiConfig(raw) ||
    needsPacingUpgrade(raw) ||
    (isRecord(raw) && isRecord(raw.pacing) && raw.pacing.activeHours != null)
  ) {
    if (hasLegacyGeminiConfig(raw)) await markAiMigration();
    await writeRaw(
      STORAGE_KEYS.settings,
      parsed.ok ? parsed.value : structuredClone(DEFAULT_SETTINGS),
    );
  }
  return parsed.ok ? parsed.value : structuredClone(DEFAULT_SETTINGS);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const parsed = parseSettings({
    ...settings,
    pacing: { ...settings.pacing, activeHours: null },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  await writeRaw(STORAGE_KEYS.settings, parsed.value);
  return parsed.value;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings(current, patch);
  next.pacing.hardCap = Math.min(next.pacing.hardCap, 100);
  next.pacing.dailyCap = Math.min(next.pacing.dailyCap, next.pacing.hardCap);
  if (next.pacing.maxDelayMs < next.pacing.minDelayMs) {
    next.pacing.maxDelayMs = next.pacing.minDelayMs;
  }
  return saveSettings(next);
}

export async function loadEngineState(): Promise<EngineState> {
  const settings = await loadSettings();
  const fallback: EngineState = {
    version: 1,
    status: 'idle',
    mode: settings.mode,
    host: settings.host,
    todayCount: 0,
    dailyCap: settings.pacing.dailyCap,
    consecutiveFailures: 0,
    updatedAt: now(),
  };
  const raw = await readRaw<EngineState>(STORAGE_KEYS.engine, fallback);
  const todayCount = await getTodayCount();
  return {
    ...fallback,
    ...raw,
    // An update must release an obsolete overnight wait without starting applications.
    ...(raw.status === 'paused' && raw.pauseReason === 'active_hours'
      ? {
          pauseReason: 'user' as const,
          nextActionAt: undefined,
          message: 'Active hours were removed. Resume when ready.',
        }
      : {}),
    // Older versions parked a capped run in Paused. The cap now ends the run.
    ...(raw.status === 'paused' && raw.pauseReason === 'cap_reached'
      ? {
          status: 'idle' as const,
          pauseReason: undefined,
          pausedAt: undefined,
          nextActionAt: undefined,
          currentJobId: undefined,
          currentPhase: undefined,
          message: 'Daily cap reached. Run finished; start again after local midnight.',
        }
      : {}),
    todayCount,
    dailyCap: settings.pacing.dailyCap,
    updatedAt: raw.updatedAt ?? now(),
  };
}

export async function saveEngineState(state: EngineState): Promise<void> {
  await writeRaw(STORAGE_KEYS.engine, { ...state, updatedAt: now() });
}

const DEFAULT_ONBOARDING: OnboardingState = {
  version: 1,
  step: 'welcome',
  sessionStatus: 'unknown',
};

export async function loadOnboarding(): Promise<OnboardingState> {
  const raw = await readRaw<Partial<OnboardingState>>(STORAGE_KEYS.onboarding, {});
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ONBOARDING };
  // Previous shapes may lack the session/host fields added later.
  return { ...DEFAULT_ONBOARDING, ...raw, version: 1 };
}

export async function saveOnboarding(state: OnboardingState): Promise<void> {
  await writeRaw(STORAGE_KEYS.onboarding, state);
}

export async function loadAiKeys(): Promise<AiKeys> {
  await restrictLocalStorageAccess();
  const raw = await readRaw<unknown>(STORAGE_KEYS.aiKeys, {});
  if (!isRecord(raw)) return {};
  const apiKey = typeof raw.openRouterApiKey === 'string' ? raw.openRouterApiKey.trim() : '';
  const keys: AiKeys = apiKey ? { openRouterApiKey: apiKey } : {};
  if ('geminiApiKey' in raw) {
    await writeRaw(STORAGE_KEYS.aiKeys, keys);
    await markAiMigration();
  }
  return keys;
}

export async function saveAiKey(openRouterApiKey: string): Promise<void> {
  const apiKey = openRouterApiKey.trim();
  if (!apiKey || /\s/.test(apiKey))
    throw new Error('Enter an OpenRouter API key without whitespace.');
  // Fail closed: never persist a new key if storage cannot be isolated.
  await restrictLocalStorageAccess();
  const previous = await readRaw<unknown>(STORAGE_KEYS.aiKeys, {});
  if (isRecord(previous) && 'geminiApiKey' in previous) await markAiMigration();
  await writeRaw(STORAGE_KEYS.aiKeys, { openRouterApiKey: apiKey });
}

export async function clearAiKey(): Promise<void> {
  const area = getArea();
  if (area) {
    await area.remove(STORAGE_KEYS.aiKeys);
    return;
  }
  globalThis.localStorage?.removeItem(localFallbackKey(STORAGE_KEYS.aiKeys));
}
