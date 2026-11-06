import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_SETTINGS,
  MAX_ADDITIONAL_RESUMES,
  SETTINGS_DEFAULTS_REVISION,
  additionalResumeSchema,
  isRecord,
  mergeSettings,
  type SettingsPatch,
} from '@/core/contracts';

const SETTINGS_GROUPS = ['search', 'pacing', 'documents', 'ai', 'safety', 'ui'] as const;

const OLD_PACING_DEFAULTS = {
  minDelayMs: 60_000,
  maxDelayMs: 120_000,
  jitterPercent: 10,
  sessionBatchSize: 10,
  sessionBreakMinMs: 300_000,
  sessionBreakMaxMs: 600_000,
  maxConsecutiveFailures: 3,
  maxAttemptsPerJob: 2,
  hardCap: 100,
};

/** A changed cap alone is not a request for custom timing. */
export function needsPacingUpgrade(raw: unknown): boolean {
  return isRecord(raw) && (!isRecord(raw.pacing) || !('speed' in raw.pacing));
}

/** Only legacy reads use these names; cloud credentials are never migrated. */
export function hasLegacyGeminiConfig(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return (
    'geminiApiKey' in raw ||
    (isRecord(raw.ai) && (raw.ai.provider === 'gemini' || 'geminiApiKey' in raw.ai))
  );
}

/** Shared by local settings and backup imports; fills new defaults without resetting valid choices. */
export function upgradeStoredSettings(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SETTINGS_GROUPS.includes(key as (typeof SETTINGS_GROUPS)[number])) {
      if (isRecord(value)) patch[key] = value;
      continue;
    }
    if (key in DEFAULT_SETTINGS) patch[key] = value;
  }
  if (isRecord(patch.ai)) {
    // On-device (Gemini Nano) matching was removed; its opt-in has no successor.
    const { geminiApiKey: discardedKey, nanoOptIn: discardedNano, ...ai } = patch.ai;
    void discardedKey;
    void discardedNano;
    patch.ai = {
      ...ai,
      provider:
        ai.provider === 'gemini'
          ? 'openrouter'
          : ai.provider === 'nano'
            ? 'auto'
            : (ai.provider ?? DEFAULT_SETTINGS.ai.provider),
    };
  }
  if (isRecord(patch.documents)) {
    // Scraped-inventory AI allow-lists are replaced by user-entered additional resumes.
    const { aiResumeIds: discardedAllowList, ...documents } = patch.documents;
    void discardedAllowList;
    // An invalid stored row must not fail the whole settings object and reset
    // every other preference to its default. Keep only usable rows, capped.
    if (documents.additionalResumes !== undefined) {
      if (Array.isArray(documents.additionalResumes)) {
        documents.additionalResumes = documents.additionalResumes
          .map((entry) => additionalResumeSchema.safeParse(entry))
          .filter((entry) => entry.success)
          .map((entry) => entry.data)
          .slice(0, MAX_ADDITIONAL_RESUMES);
      } else {
        delete documents.additionalResumes;
      }
    }
    patch.documents = documents;
  }
  if (needsPacingUpgrade(raw)) {
    const previous = isRecord(patch.pacing) ? patch.pacing : {};
    const customized = Object.entries(OLD_PACING_DEFAULTS).some(([key, value]) => {
      if (!(key in previous)) return false;
      const actual = previous[key];
      return actual !== value;
    });
    patch.pacing = {
      ...(customized ? OLD_PACING_DEFAULTS : {}),
      ...previous,
      speed: 4,
      useAdvanced: customized,
      // Only new installs receive 15. Old sparse settings also retain the old cap.
      dailyCap: previous.dailyCap ?? 25,
    };
  }
  // Retain the backup shape without restoring the retired time-of-day gate.
  patch.pacing = { ...(isRecord(patch.pacing) ? patch.pacing : {}), activeHours: null };
  // External-link collection is opt-in, including settings saved before this field existed.
  patch.search = { collectExternalJobs: false, ...(isRecord(patch.search) ? patch.search : {}) };
  patch.safety = { allowOneClickApply: false, ...(isRecord(patch.safety) ? patch.safety : {}) };
  if (needsAutomationDefaults(raw)) applyAutomationDefaults(patch);
  return mergeSettings(DEFAULT_SETTINGS, patch as SettingsPatch);
}

/** Settings saved before full automation became the product default. */
export function needsAutomationDefaults(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const revision = typeof raw.defaultsRevision === 'number' ? raw.defaultsRevision : 1;
  return revision < SETTINGS_DEFAULTS_REVISION;
}

/**
 * Revision 2, applied once: click-and-forget automation. Review becomes
 * Autopilot (an explicit Dry run stays a simulation), the review step and
 * per-answer approvals are switched off, one-click Apply and AI page assist are
 * switched on, and DeepSeek is preselected when no model was chosen. Every
 * switch remains an opt-out in Settings, and later saves keep the user's choice.
 */
function applyAutomationDefaults(patch: Record<string, unknown>): void {
  if (patch.mode === undefined || patch.mode === 'review') patch.mode = 'autopilot';
  patch.safety = {
    ...(isRecord(patch.safety) ? patch.safety : {}),
    reviewBeforeSubmit: false,
    allowOneClickApply: true,
    allowSensitiveAutoSubmit: true,
    allowEeoAutoFill: true,
    allowFreeTextAutoFill: true,
  };
  const ai = isRecord(patch.ai) ? patch.ai : {};
  const openRouter = isRecord(ai.openRouter) ? ai.openRouter : {};
  const fallbacks = Array.isArray(openRouter.fallbackModels) ? openRouter.fallbackModels : [];
  // A model also listed as a fallback would fail validation and reset all settings.
  const model =
    typeof openRouter.model === 'string' && openRouter.model.trim()
      ? openRouter.model
      : fallbacks.includes(DEFAULT_OPENROUTER_MODEL)
        ? null
        : DEFAULT_OPENROUTER_MODEL;
  patch.ai = {
    ...ai,
    enabled: true,
    pageAssist: true,
    answerAssist: true,
    answerWrite: true,
    openRouter: { ...openRouter, model },
  };
  patch.defaultsRevision = SETTINGS_DEFAULTS_REVISION;
}
