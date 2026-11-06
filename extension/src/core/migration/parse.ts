/**
 * Pure parsers for the legacy Python files and for Handshook's own backup.
 *
 * Everything here is validation and mapping only — no storage, no browser
 * APIs. The background re-runs the same parser before writing, so the UI can
 * show a preview without trusting any parsed payload sent over messages.
 */

import { hasLegacyGeminiConfig, upgradeStoredSettings } from '@/core/storage/settings-upgrade';
import {
  DEFAULT_SETTINGS,
  DOCUMENT_NAME_MAX_LENGTH,
  MAX_ADDITIONAL_RESUMES,
  appError,
  err,
  isRecord,
  jobSchema,
  ok,
  parseAnswer,
  parseSettings,
  type AdditionalResume,
  type DocumentRecord,
  type Job,
  type JobStatus,
  type LegacyFileKind,
  type LegacyFileKindInput,
  type QueueItem,
  type Result,
  type Settings,
} from '@/core/contracts';
import { parseHandshakeDocumentId } from '@/core/documents/selection';
import { isAllowedHandshakeUrl } from '@/core/util/urls';
import { clamp, now, todayKey } from '@/core/util/time';
import { isCommentKey, isSecretKey } from './secrets';
import {
  legacyDocumentSchema,
  legacyJsonObjectSchema,
  legacyProfileSchema,
  legacyQueueItemSchema,
  legacyRateLimitSchema,
  legacyRateStatsSchema,
  legacyResumeSchema,
  legacyTrackerInfoSchema,
} from './schemas';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_IMPORT_BYTES,
  type BackupMigrationPlan,
  type ConfMigrationPlan,
  type LegacyCategory,
  type LegacySearchInput,
  type MigrationImportSummary,
  type MigrationPlan,
  type MigrationPreview,
  type RateStatsMigrationPlan,
  type TrackerMigrationEntry,
  type TrackerMigrationPlan,
} from './types';

/* -------------------------------------------------------------------------- */
/* Small coercion helpers                                                     */
/* -------------------------------------------------------------------------- */

const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);
const MAX_SEARCHES = 100;
const MAX_RESUMES = 100;
const MAX_KEYWORDS = 300;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Legacy files may carry bare IDs or document links; accept exactly what the UI accepts. */
function asDocumentId(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return parseHandshakeDocumentId(text) ?? undefined;
}

/** A configured document field: an unusable value is dropped and reported, never guessed. */
function documentId(value: unknown, label: string, warnings: string[]): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const id = parseHandshakeDocumentId(text);
  if (!id) {
    warnings.push(
      `Ignored the ${label} because it is not a valid document ID or Handshake document link.`,
    );
  }
  return id ?? undefined;
}

/** Legacy tracker keys must be numeric job IDs; anything else is junk. */
function asJobId(value: unknown): string | undefined {
  const text = asString(value);
  if (!text || !/^\d{1,20}$/.test(text)) return undefined;
  return text;
}

function asTimestamp(value: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Python writes ISO strings, but accept epoch seconds or milliseconds too.
    ms = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '') ms = Date.parse(trimmed);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < MIN_PLAUSIBLE_MS || ms > MAX_PLAUSIBLE_MS) return undefined;
  return Math.trunc(ms);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function parseStringList(value: unknown, label: string, warnings: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${label} is not a list, so it was ignored.`);
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (!text) continue;
    const trimmed = truncate(text, 120);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= MAX_KEYWORDS) {
      warnings.push(`${label} was capped at ${MAX_KEYWORDS} entries.`);
      break;
    }
  }
  return result;
}

/**
 * Normalize top-level key casing. `conf.json.template` uses uppercase keys, but
 * hand-edited files often use lowercase; exact uppercase wins when both exist.
 */
function normalizeTopLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const entries = Object.entries(raw);
  for (const [key, value] of entries) {
    if (key !== key.toUpperCase()) continue;
    values[key.toUpperCase()] = value;
  }
  for (const [key, value] of entries) {
    const upper = key.toUpperCase();
    if (upper in values) continue;
    values[upper] = value;
  }
  return values;
}

function listKeys(keys: readonly string[], limit = 8): string {
  if (keys.length <= limit) return keys.join(', ');
  return `${keys.slice(0, limit).join(', ')}, …`;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

const TRACKER_SECTIONS = [
  'APPLIED',
  'EXTERNAL',
  'SKIPPED',
  'UNSUPPORTED',
  'FAILED',
  'WAITING',
] as const;

const CONF_SECTIONS = [
  'RESUMES',
  'URL_LIST',
  'COOKIES',
  'PROFILES',
  'SKIP_KEYWORDS',
  'JOB_KEYWORDS',
  'RATE_LIMIT_CONFIG',
  'COVER_LETTER_ID',
  'TRANSCRIPT_ID',
  'CV_ID',
] as const;

export function detectLegacyKind(raw: unknown): LegacyFileKind | null {
  if (!isRecord(raw)) return null;
  if (raw.format === BACKUP_FORMAT) return 'backup';
  const keys = new Set(Object.keys(raw).map((key) => key.toUpperCase()));
  if (keys.has('DAILY_COUNTS')) return 'rate_stats';
  if (TRACKER_SECTIONS.some((key) => keys.has(key))) return 'tracker';
  if (CONF_SECTIONS.some((key) => keys.has(key))) return 'conf';
  return null;
}

function kindLabel(kind: LegacyFileKind): string {
  if (kind === 'conf') return 'conf.json';
  if (kind === 'tracker') return 'job_tracker.json';
  if (kind === 'rate_stats') return 'rate_stats_*.json';
  return 'a Handshook backup';
}

/* -------------------------------------------------------------------------- */
/* conf.json                                                                  */
/* -------------------------------------------------------------------------- */

const CONF_ALLOWED_KEYS = new Set([
  'RESUMES',
  'COVER_LETTER_ID',
  'CV_ID',
  'COVER',
  'TRANSCRIPT_ID',
  'TRANSCRIPT',
  'OTHER',
  'URL_LIST',
  'SKIP_KEYWORDS',
  'JOB_KEYWORDS',
  'RATE_LIMIT_CONFIG',
  'PROFILES',
  'DATE',
  'URL',
]);

function searchName(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const query =
      parsed.searchParams.get('query') ??
      parsed.searchParams.get('q') ??
      parsed.searchParams.get('keywords') ??
      parsed.searchParams.get('search');
    if (query) return truncate(`Search: ${query}`, 80);
    return truncate(`${parsed.hostname} search ${index + 1}`, 80);
  } catch {
    return `Legacy search ${index + 1}`;
  }
}

function parsePacing(value: unknown, warnings: string[]): Partial<Settings['pacing']> {
  const pacing: Partial<Settings['pacing']> = {};
  if (value === undefined || value === null) return pacing;
  const parsedConfig = legacyRateLimitSchema.safeParse(value);
  if (!parsedConfig.success) {
    warnings.push('RATE_LIMIT_CONFIG is not an object, so pacing was left unchanged.');
    return pacing;
  }
  const config = parsedConfig.data;

  let clamped = false;

  const minSeconds = asNumber(config.min_delay_seconds);
  if (minSeconds !== undefined) {
    const rawMs = Math.round(minSeconds * 1000);
    const minMs = clampInt(rawMs, 30_000, 600_000);
    clamped ||= minMs !== rawMs;
    pacing.minDelayMs = minMs;
  }

  const maxSeconds = asNumber(config.max_delay_seconds);
  if (maxSeconds !== undefined) {
    const rawMs = Math.round(maxSeconds * 1000);
    const maxMs = clampInt(rawMs, 30_000, 600_000);
    const minMs = pacing.minDelayMs ?? DEFAULT_SETTINGS.pacing.minDelayMs;
    clamped ||= maxMs !== rawMs;
    pacing.maxDelayMs = Math.max(minMs, maxMs);
  }

  const daily = asNumber(config.daily_limit);
  if (daily !== undefined) {
    const cap = clampInt(daily, 1, 100);
    clamped ||= cap !== Math.round(daily);
    pacing.dailyCap = cap;
    pacing.hardCap = 100;
  }

  const batch = asNumber(config.session_batch_size);
  if (batch !== undefined) {
    const size = clampInt(batch, 1, 100);
    clamped ||= size !== Math.round(batch);
    pacing.sessionBatchSize = size;
  }

  const breakMin = asNumber(config.session_break_min);
  if (breakMin !== undefined) {
    const rawMs = Math.round(breakMin * 1000);
    const minMs = clampInt(rawMs, 0, 3_600_000);
    clamped ||= minMs !== rawMs;
    pacing.sessionBreakMinMs = minMs;
  }

  const breakMax = asNumber(config.session_break_max);
  if (breakMax !== undefined) {
    const rawMs = Math.round(breakMax * 1000);
    const maxMs = clampInt(rawMs, 0, 3_600_000);
    const minMs = pacing.sessionBreakMinMs ?? DEFAULT_SETTINGS.pacing.sessionBreakMinMs;
    clamped ||= maxMs !== rawMs;
    pacing.sessionBreakMaxMs = Math.max(minMs, maxMs);
  }

  const jitter = asNumber(config.jitter_percent);
  if (jitter !== undefined) {
    const percent = clampInt(jitter, 0, 50);
    clamped ||= percent !== Math.round(jitter);
    pacing.jitterPercent = percent;
  }

  if (clamped) {
    warnings.push(
      'Pacing values were clamped to the extension limits (30–600 s delays, daily cap 1–100, jitter 0–50%).',
    );
  }
  if (config.enabled === false) {
    warnings.push(
      'Rate limiting was disabled in the Python config. The extension always keeps its pacing limits on.',
    );
  }
  if (config.active_hours !== undefined) {
    warnings.push(
      'Only delay, daily cap, batch size, break, and jitter settings are imported. Active hours stay at the extension default.',
    );
  }

  if (Object.keys(pacing).some((key) => key !== 'dailyCap' && key !== 'hardCap')) {
    pacing.useAdvanced = true;
  }
  return pacing;
}

function parseConf(raw: Record<string, unknown>): ConfMigrationPlan {
  const values = normalizeTopLevel(raw);
  const warnings: string[] = [];

  const allKeys = Object.keys(raw);
  const ignoredKeys = allKeys.filter(
    (key) => !isCommentKey(key) && !CONF_ALLOWED_KEYS.has(key.toUpperCase()),
  );
  const secretKeys = allKeys.filter((key) => isSecretKey(key));

  if (secretKeys.length > 0) {
    warnings.push(
      `Ignored secret-looking fields (${listKeys(secretKeys)}). Their values were never read.`,
    );
  }
  if (secretKeys.some((key) => /cookie/i.test(key))) {
    warnings.push(
      'Cookies were not imported. The extension uses your browser session instead of stored cookies.',
    );
  }
  const otherIgnored = ignoredKeys.filter((key) => !isSecretKey(key));
  if (otherIgnored.length > 0) {
    warnings.push(
      `Ignored fields that are not part of the extension config: ${listKeys(otherIgnored)}.`,
    );
  }
  if (values.DATE !== undefined) {
    warnings.push(
      'The legacy DATE field was not imported; timestamps are kept from each job record.',
    );
  }

  /* RESUMES ---------------------------------------------------------------- */
  const resumes: AdditionalResume[] = [];
  const seenResumeIds = new Set<string>();
  let skippedResumes = 0;
  const rawResumes = values.RESUMES;
  if (rawResumes !== undefined && rawResumes !== null) {
    if (!Array.isArray(rawResumes)) {
      warnings.push('RESUMES is not a list, so no resumes were imported.');
    } else {
      for (const entry of rawResumes) {
        const parsedEntry = legacyResumeSchema.safeParse(entry);
        if (!parsedEntry.success) {
          skippedResumes += 1;
          continue;
        }
        const id = asDocumentId(parsedEntry.data.id);
        if (!id || seenResumeIds.has(id)) {
          skippedResumes += 1;
          continue;
        }
        seenResumeIds.add(id);
        resumes.push({
          id,
          name: truncate(
            asString(parsedEntry.data.title) ?? `Resume ${id}`,
            DOCUMENT_NAME_MAX_LENGTH,
          ),
        });
        if (resumes.length >= MAX_RESUMES) break;
      }
      if (skippedResumes > 0) {
        warnings.push(
          `Skipped ${skippedResumes} resume ${skippedResumes === 1 ? 'entry' : 'entries'} without a usable ID.`,
        );
      }
    }
  }

  /* PROFILES --------------------------------------------------------------- */
  let profileName: string | undefined;
  let preferredResumeId: string | undefined;
  let profileCoverId: string | undefined;
  let profileTranscriptId: string | undefined;
  let profileOtherId: string | undefined;
  let profileUrl: string | undefined;
  let profileInclude: string[] | undefined;
  let profileExclude: string[] | undefined;

  const rawProfiles = values.PROFILES;
  if (rawProfiles !== undefined && rawProfiles !== null) {
    if (!Array.isArray(rawProfiles)) {
      warnings.push('PROFILES is not a list, so only the top-level settings were imported.');
    } else {
      const profiles: Record<string, unknown>[] = [];
      let invalidProfiles = 0;
      for (const entry of rawProfiles) {
        const parsedProfile = legacyProfileSchema.safeParse(entry);
        if (parsedProfile.success) profiles.push(parsedProfile.data);
        else invalidProfiles += 1;
      }
      if (invalidProfiles > 0) {
        warnings.push(`Skipped ${invalidProfiles} invalid profile entries.`);
      }
      const active =
        profiles.find((profile) => profile.enabled !== false && profile.active !== false) ??
        profiles[0];
      if (!active) {
        warnings.push('PROFILES did not contain a usable profile.');
      } else {
        profileName = asString(active.name);
        preferredResumeId = documentId(
          active.resume ?? active.resume_id,
          'profile resume ID',
          warnings,
        );
        profileCoverId = documentId(
          active.cover ?? active.cover_letter_id ?? active.coverLetterId,
          'profile cover-letter ID',
          warnings,
        );
        profileTranscriptId = documentId(
          active.transcript ?? active.transcript_id ?? active.transcriptId,
          'profile transcript ID',
          warnings,
        );
        profileOtherId = documentId(
          active.other ?? active.other_document_id,
          'profile other-document ID',
          warnings,
        );
        profileUrl = asString(active.url);
        profileInclude = parseStringList(active.job_keywords, 'The profile job keywords', warnings);
        profileExclude = parseStringList(
          active.skip_keywords,
          'The profile skip keywords',
          warnings,
        );
        if (profiles.length > 1) {
          warnings.push(
            `Only the first active profile${profileName ? ` (“${truncate(profileName, 60)}”)` : ''} was imported. Multi-profile support is not available in this version.`,
          );
        }
        if (isRecord(active.cookies)) {
          warnings.push('Per-profile cookies were ignored.');
        }
      }
    }
  }

  /* DOCUMENT IDS ----------------------------------------------------------- */
  const coverLetterId =
    profileCoverId ??
    documentId(values.COVER_LETTER_ID, 'COVER_LETTER_ID', warnings) ??
    documentId(values.CV_ID, 'CV_ID', warnings) ??
    documentId(values.COVER, 'COVER', warnings);
  const transcriptId =
    profileTranscriptId ??
    documentId(values.TRANSCRIPT_ID, 'TRANSCRIPT_ID', warnings) ??
    documentId(values.TRANSCRIPT, 'TRANSCRIPT', warnings);
  const otherDocumentId = profileOtherId ?? documentId(values.OTHER, 'OTHER', warnings);

  /* RESUME CHOICES --------------------------------------------------------- */
  const defaultResumeId = preferredResumeId ?? resumes[0]?.id;
  const defaultResumeName = defaultResumeId
    ? (resumes.find((resume) => resume.id === defaultResumeId)?.name ??
      truncate(`Resume ${defaultResumeId}`, DOCUMENT_NAME_MAX_LENGTH))
    : undefined;
  const remainingResumes = resumes.filter((resume) => resume.id !== defaultResumeId);
  const additionalResumes = remainingResumes.slice(0, MAX_ADDITIONAL_RESUMES);
  const resumesOverLimit = remainingResumes.length - additionalResumes.length;
  if (resumesOverLimit > 0) {
    warnings.push(
      `${resumesOverLimit} resume${resumesOverLimit === 1 ? '' : 's'} beyond the ${MAX_ADDITIONAL_RESUMES} additional-resume limit ${resumesOverLimit === 1 ? 'was' : 'were'} not imported.`,
    );
  }

  /* SEARCHES --------------------------------------------------------------- */
  const searches: LegacySearchInput[] = [];
  const seenUrls = new Set<string>();
  const addSearch = (candidate: unknown, name?: string): void => {
    const url = asString(candidate);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      warnings.push('Ignored a saved search URL that is not http(s).');
      return;
    }
    if (!isAllowedHandshakeUrl(url)) {
      // M12: imported searches must never point the runner outside Handshake.
      warnings.push('Ignored a saved search URL that is not an HTTPS Handshake URL.');
      return;
    }
    if (seenUrls.has(url)) return;
    if (searches.length >= MAX_SEARCHES) {
      warnings.push(`Saved searches were capped at ${MAX_SEARCHES}.`);
      return;
    }
    seenUrls.add(url);
    searches.push({ name: name ?? searchName(url, searches.length), url: truncate(url, 2000) });
  };

  addSearch(profileUrl, profileName ? `${truncate(profileName, 60)} search` : undefined);

  const rawUrls = values.URL_LIST;
  if (rawUrls !== undefined && rawUrls !== null) {
    if (!Array.isArray(rawUrls)) {
      warnings.push('URL_LIST is not a list, so no saved searches were imported from it.');
    } else {
      for (const entry of rawUrls) {
        if (typeof entry === 'string') {
          addSearch(entry);
        } else if (isRecord(entry)) {
          addSearch(entry.url ?? entry.URL);
        } else {
          warnings.push('Ignored a URL_LIST entry that was not a URL.');
        }
      }
    }
  }
  if (searches.length === 0) addSearch(values.URL);

  /* KEYWORDS --------------------------------------------------------------- */
  const edgeInclude = parseStringList(values.JOB_KEYWORDS, 'JOB_KEYWORDS', warnings);
  const edgeExclude = parseStringList(values.SKIP_KEYWORDS, 'SKIP_KEYWORDS', warnings);
  const includeKeywords = profileInclude ?? edgeInclude;
  const excludeKeywords = profileExclude ?? edgeExclude;

  /* PACING ----------------------------------------------------------------- */
  const pacing = parsePacing(values.RATE_LIMIT_CONFIG, warnings);

  return {
    kind: 'conf',
    ...(defaultResumeId ? { defaultResumeId } : {}),
    ...(defaultResumeName ? { defaultResumeName } : {}),
    additionalResumes,
    ...(coverLetterId ? { coverLetterId } : {}),
    ...(transcriptId ? { transcriptId } : {}),
    ...(otherDocumentId ? { otherDocumentId } : {}),
    searches,
    ...(includeKeywords !== undefined ? { includeKeywords } : {}),
    ...(excludeKeywords !== undefined ? { excludeKeywords } : {}),
    pacing,
    ...(profileName ? { profileName } : {}),
    ignoredKeys,
    secretKeys,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* job_tracker.json                                                           */
/* -------------------------------------------------------------------------- */

const CATEGORY_PRIORITY: Record<LegacyCategory, number> = {
  applied: 6,
  external: 5,
  unsupported: 4,
  skipped: 3,
  waiting: 2,
  failed: 1,
};

const STATUS_BY_CATEGORY: Record<LegacyCategory, JobStatus> = {
  applied: 'applied',
  external: 'external',
  skipped: 'skipped',
  unsupported: 'blocked',
  failed: 'failed',
  waiting: 'waiting',
};

const LEGACY_CATEGORIES: readonly LegacyCategory[] = [
  'applied',
  'external',
  'skipped',
  'unsupported',
  'failed',
  'waiting',
];

function parseTracker(raw: Record<string, unknown>): TrackerMigrationPlan {
  const values = normalizeTopLevel(raw);
  const warnings: string[] = [];
  const entriesById = new Map<string, TrackerMigrationEntry>();
  let skippedIds = 0;
  let malformedInfo = 0;
  let missingTimestamps = 0;
  let crossCategoryDuplicates = 0;

  const knownUpperCase = new Set(LEGACY_CATEGORIES.map((category) => category.toUpperCase()));
  const ignoredCategories = Object.keys(raw).filter(
    (key) =>
      !isCommentKey(key) &&
      key.toUpperCase() !== 'METADATA' &&
      !knownUpperCase.has(key.toUpperCase()),
  );
  if (ignoredCategories.length > 0) {
    warnings.push(`Ignored unknown tracker sections: ${listKeys(ignoredCategories)}.`);
  }

  for (const category of LEGACY_CATEGORIES) {
    const section = values[category.toUpperCase()];
    if (section === undefined) continue;
    if (!isRecord(section)) {
      warnings.push(`The “${category}” section is not an object, so it was ignored.`);
      continue;
    }
    for (const [rawJobId, rawInfo] of Object.entries(section)) {
      const jobId = asJobId(rawJobId);
      if (!jobId) {
        skippedIds += 1;
        continue;
      }
      const parsedInfo = legacyTrackerInfoSchema.safeParse(rawInfo);
      if (!parsedInfo.success) malformedInfo += 1;
      const info = parsedInfo.success ? parsedInfo.data : {};
      const parsedTimestamp =
        category === 'applied'
          ? (asTimestamp(info.applied_at) ?? asTimestamp(info.recorded_at))
          : asTimestamp(info.recorded_at);
      if (parsedTimestamp === undefined) missingTimestamps += 1;
      const timestamp = parsedTimestamp ?? now();

      const noteSource =
        category === 'failed'
          ? info.error
          : category === 'unsupported' || category === 'skipped'
            ? info.reason
            : undefined;
      const note = asString(noteSource);

      const candidate: TrackerMigrationEntry = {
        jobId,
        category,
        status: STATUS_BY_CATEGORY[category],
        title: truncate(asString(info.name) ?? '', 200),
        employer: truncate(asString(info.employer) ?? '', 200),
        timestamp,
        ...(category === 'waiting' ? { nextAttemptAt: asTimestamp(info.open_date) } : {}),
        ...(note ? { note: truncate(note, 300) } : {}),
      };

      const existing = entriesById.get(jobId);
      if (!existing) {
        entriesById.set(jobId, candidate);
      } else if (CATEGORY_PRIORITY[category] > CATEGORY_PRIORITY[existing.category]) {
        crossCategoryDuplicates += 1;
        entriesById.set(jobId, candidate);
      } else {
        crossCategoryDuplicates += 1;
      }
    }
  }

  if (entriesById.size === 0) {
    warnings.push('No tracker entries with numeric job IDs were found.');
  }
  if (skippedIds > 0) {
    warnings.push(
      `Skipped ${skippedIds} tracker ${skippedIds === 1 ? 'entry' : 'entries'} with a non-numeric job ID.`,
    );
  }
  if (malformedInfo > 0) {
    warnings.push(
      `${malformedInfo} tracker ${malformedInfo === 1 ? 'entry was' : 'entries were'} not an object; ${
        malformedInfo === 1 ? 'it was' : 'they were'
      } imported without extra details.`,
    );
  }
  if (missingTimestamps > 0) {
    warnings.push(
      `${missingTimestamps} tracker ${missingTimestamps === 1 ? 'entry has' : 'entries have'} no usable timestamp; the import time was used.`,
    );
  }
  if (crossCategoryDuplicates > 0) {
    warnings.push(
      `${crossCategoryDuplicates} job IDs appeared in more than one category; the higher-priority status won.`,
    );
  }
  const unsupportedCount = [...entriesById.values()].filter(
    (entry) => entry.category === 'unsupported',
  ).length;
  if (unsupportedCount > 0) {
    warnings.push(
      `${unsupportedCount} unsupported ${unsupportedCount === 1 ? 'job was' : 'jobs were'} imported as blocked (final status).`,
    );
  }

  return {
    kind: 'tracker',
    entries: [...entriesById.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)),
    ignoredCategories,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* rate_stats_*.json                                                          */
/* -------------------------------------------------------------------------- */

function parseRateStats(raw: Record<string, unknown>): Result<RateStatsMigrationPlan> {
  const values = normalizeTopLevel(raw);
  const parsed = legacyRateStatsSchema.safeParse({
    daily_counts: values.DAILY_COUNTS,
    ...(values.TOTAL_APPLICATIONS !== undefined
      ? { total_applications: values.TOTAL_APPLICATIONS }
      : {}),
  });
  if (!parsed.success) {
    return err(
      appError(
        'INVALID_INPUT',
        'That file does not have a valid daily_counts object, so it is not a rate_stats file.',
      ),
    );
  }
  const dailyCounts = parsed.data.daily_counts;

  const dateKey = todayKey();
  const rawToday = dailyCounts[dateKey];
  const parsedToday = asNumber(rawToday);
  const todayCount = parsedToday === undefined ? 0 : clampInt(parsedToday, 0, 10_000);
  const totalApplications = asNumber(parsed.data.total_applications);

  const warnings: string[] = [];
  if (parsedToday === undefined) {
    warnings.push(
      `No application count was found for today (${dateKey}); nothing will be imported. Older history is not imported either.`,
    );
  } else {
    warnings.push(
      `Only today's application count (${dateKey}) is imported. Older history stays in the Python tool.`,
    );
    if (todayCount !== Math.round(parsedToday)) {
      warnings.push('The count was clamped to a sane range.');
    }
  }

  return ok({
    kind: 'rate_stats',
    dateKey,
    todayCount,
    ...(totalApplications !== undefined
      ? { totalApplications: clampInt(totalApplications, 0, 1_000_000) }
      : {}),
    warnings,
  });
}

/* -------------------------------------------------------------------------- */
/* Handshook backup                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A backup must never silently turn on autopilot or an unsafe auto-submit flag.
 * Restore everything else, reset the dangerous switches to product defaults,
 * and tell the user exactly what changed in the preview.
 */
function safeBackupSettings(settings: Settings, warnings: string[]): Settings {
  const safety = { ...settings.safety };
  const changes: string[] = [];
  let mode = settings.mode;
  if (mode !== 'review') {
    mode = 'review';
    changes.push('run mode reset to Review');
  }
  if (safety.allowSensitiveAutoSubmit) {
    safety.allowSensitiveAutoSubmit = false;
    changes.push('sensitive-answer auto-submit turned off');
  }
  if (safety.allowEeoAutoFill) {
    safety.allowEeoAutoFill = false;
    changes.push('EEO auto-fill turned off');
  }
  if (safety.allowFreeTextAutoFill) {
    safety.allowFreeTextAutoFill = false;
    changes.push('free-text auto-fill turned off');
  }
  if (!safety.reviewBeforeSubmit) {
    safety.reviewBeforeSubmit = true;
    changes.push('review-before-submit turned on');
  }
  if (!safety.stopOnUnknownQuestion) {
    safety.stopOnUnknownQuestion = true;
    changes.push('stop-on-unknown-question turned on');
  }
  if (changes.length > 0) {
    warnings.push(
      `Backup safety settings were reset to safe defaults (${changes.join('; ')}). Re-enable them explicitly in Settings.`,
    );
  }
  return { ...settings, mode, safety };
}

/**
 * Older backups stored a scraped document inventory and an AI allow-list.
 * The inventory is no longer restored (settings now carry IDs and names), but
 * its titles still fill missing name labels, and the allow-list is converted to
 * additional resumes before the storage upgrade drops `aiResumeIds`.
 */
function prepareLegacyBackupSettings(
  raw: unknown,
  documents: readonly DocumentRecord[],
  warnings: string[],
): unknown {
  if (!isRecord(raw) || !isRecord(raw.documents)) return raw;
  const legacyDocuments = { ...raw.documents };
  const names = new Map(
    documents
      .filter((document) => document.title.trim() !== '')
      .map((document) => [document.id, truncate(document.title, DOCUMENT_NAME_MAX_LENGTH)]),
  );
  const defaultResumeId = asDocumentId(legacyDocuments.defaultResumeId);

  const rawAllowList = legacyDocuments.aiResumeIds;
  if (
    Array.isArray(rawAllowList) &&
    (legacyDocuments.additionalResumes === undefined || legacyDocuments.additionalResumes === null)
  ) {
    const converted: AdditionalResume[] = [];
    let invalid = 0;
    let overLimit = 0;
    for (const entry of rawAllowList) {
      const id = asDocumentId(entry);
      if (!id) {
        invalid += 1;
        continue;
      }
      if (id === defaultResumeId || converted.some((resume) => resume.id === id)) continue;
      if (converted.length >= MAX_ADDITIONAL_RESUMES) {
        overLimit += 1;
        continue;
      }
      converted.push({
        id,
        name: names.get(id) ?? truncate(`Resume ${id}`, DOCUMENT_NAME_MAX_LENGTH),
      });
    }
    if (invalid > 0) {
      warnings.push(
        `Ignored ${invalid} saved AI resume ID${invalid === 1 ? '' : 's'} in the backup that ${invalid === 1 ? 'was' : 'were'} not valid.`,
      );
    }
    if (overLimit > 0) {
      warnings.push(
        `${overLimit} saved AI resume${overLimit === 1 ? '' : 's'} beyond the ${MAX_ADDITIONAL_RESUMES} additional-resume limit ${overLimit === 1 ? 'was' : 'were'} not imported.`,
      );
    }
    legacyDocuments.additionalResumes = converted;
  } else if (rawAllowList !== undefined && !Array.isArray(rawAllowList)) {
    warnings.push('The backup AI resume list was ignored because it is not a list.');
  }

  const fillName = (idKey: string, nameKey: string): void => {
    const id = asDocumentId(legacyDocuments[idKey]);
    const currentName = legacyDocuments[nameKey];
    if (!id || (typeof currentName === 'string' && currentName.trim() !== '')) return;
    const name = names.get(id);
    if (name) legacyDocuments[nameKey] = name;
  };
  fillName('defaultResumeId', 'defaultResumeName');
  fillName('coverLetterId', 'coverLetterName');
  fillName('transcriptId', 'transcriptName');
  fillName('otherDocumentId', 'otherDocumentName');

  if (Array.isArray(legacyDocuments.additionalResumes)) {
    legacyDocuments.additionalResumes = legacyDocuments.additionalResumes.map((entry) => {
      if (!isRecord(entry)) return entry;
      const id = asDocumentId(entry.id);
      if (!id || (typeof entry.name === 'string' && entry.name.trim() !== '')) return entry;
      return {
        ...entry,
        id,
        name: names.get(id) ?? truncate(`Resume ${id}`, DOCUMENT_NAME_MAX_LENGTH),
      };
    });
  }

  return { ...raw, documents: legacyDocuments };
}

function parseBackup(raw: Record<string, unknown>): Result<BackupMigrationPlan> {
  if (raw.format !== BACKUP_FORMAT) {
    return err(
      appError(
        'INVALID_INPUT',
        'That JSON object is not a Handshook backup. Choose the file type explicitly if it is a Python file.',
      ),
    );
  }
  if (raw.version !== BACKUP_VERSION) {
    return err(
      appError(
        'INVALID_INPUT',
        `This backup version is not supported (expected ${BACKUP_VERSION}).`,
      ),
    );
  }

  const warnings: string[] = [];

  // Older backups include a scraped inventory. It is only used to name documents
  // now; settings carry the IDs and names that actually restore.
  const legacyDocuments: DocumentRecord[] = [];
  const rawDocuments = raw.documents;
  if (rawDocuments !== undefined) {
    if (!Array.isArray(rawDocuments)) {
      warnings.push('The backup documents section is not a list and was ignored.');
    } else {
      let skipped = 0;
      for (const entry of rawDocuments) {
        const parsed = legacyDocumentSchema.safeParse(entry);
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        const id = asDocumentId(parsed.data.id);
        if (!id) {
          skipped += 1;
          continue;
        }
        const index = legacyDocuments.findIndex((item) => item.id === id);
        if (index >= 0) legacyDocuments.splice(index, 1);
        legacyDocuments.push({ ...parsed.data, id });
      }
      if (skipped > 0) warnings.push(`Skipped ${skipped} invalid documents.`);
    }
  }

  let settings: Settings | undefined;
  if (raw.settings !== undefined) {
    const prepared = prepareLegacyBackupSettings(raw.settings, legacyDocuments, warnings);
    const parsedSettings = parseSettings(upgradeStoredSettings(prepared));
    if (parsedSettings.ok) {
      settings = safeBackupSettings(parsedSettings.value, warnings);
    } else {
      warnings.push('The backup settings were invalid and were not restored.');
    }
  }

  const answers: BackupMigrationPlan['answers'] = [];
  const rawAnswers = raw.answers;
  if (rawAnswers !== undefined) {
    if (!Array.isArray(rawAnswers)) {
      warnings.push('The backup answers section is not a list and was ignored.');
    } else {
      let skipped = 0;
      for (const entry of rawAnswers) {
        const parsed = parseAnswer(entry);
        if (!parsed.ok) {
          skipped += 1;
          continue;
        }
        const existingIndex = answers.findIndex((item) => item.id === parsed.value.id);
        if (existingIndex >= 0) answers.splice(existingIndex, 1);
        answers.push(parsed.value);
      }
      if (skipped > 0) warnings.push(`Skipped ${skipped} invalid answers.`);
    }
  }

  const tracker: QueueItem[] = [];
  const rawTracker = raw.tracker;
  if (rawTracker !== undefined) {
    if (!Array.isArray(rawTracker)) {
      warnings.push('The backup tracker section is not a list and was ignored.');
    } else {
      let skipped = 0;
      for (const entry of rawTracker) {
        const parsed = legacyQueueItemSchema.safeParse(entry);
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        const index = tracker.findIndex((item) => item.jobId === parsed.data.jobId);
        if (index >= 0) tracker.splice(index, 1);
        tracker.push(parsed.data);
      }
      if (skipped > 0) warnings.push(`Skipped ${skipped} invalid tracker entries.`);
    }
  }

  const jobs: Job[] = [];
  const rawJobs = raw.jobs;
  if (rawJobs !== undefined) {
    if (!Array.isArray(rawJobs)) {
      warnings.push('The backup jobs section is not a list and was ignored.');
    } else {
      let skipped = 0;
      let offHandshake = 0;
      for (const entry of rawJobs) {
        const parsed = jobSchema.safeParse(entry);
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        if (!isAllowedHandshakeUrl(String(parsed.data.url))) {
          // M12: a backup must not add a job that navigates the runner offsite.
          offHandshake += 1;
          continue;
        }
        const index = jobs.findIndex((item) => item.id === parsed.data.id);
        if (index >= 0) jobs.splice(index, 1);
        jobs.push(parsed.data as Job);
      }
      if (skipped > 0) warnings.push(`Skipped ${skipped} invalid jobs.`);
      if (offHandshake > 0) {
        warnings.push(
          `Skipped ${offHandshake} job${offHandshake === 1 ? '' : 's'} whose URL was not an HTTPS Handshake URL.`,
        );
      }
    }
  }

  if (['aiKeys', 'keys', 'secrets', 'cookies'].some((key) => raw[key] !== undefined)) {
    warnings.push('API keys, cookies, and secrets are never restored from a backup.');
  }

  if (!settings && answers.length === 0 && tracker.length === 0 && jobs.length === 0) {
    warnings.push('The backup did not contain any usable data.');
  }

  return ok({
    kind: 'backup',
    ...(hasLegacyGeminiConfig(raw.settings) ||
    hasLegacyGeminiConfig(raw.aiKeys) ||
    hasLegacyGeminiConfig(raw.keys)
      ? { geminiReplaced: true }
      : {}),
    ...(settings ? { settings } : {}),
    answers,
    tracker,
    jobs,
    warnings,
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function parseLegacyFile(
  kindInput: LegacyFileKindInput,
  content: string,
): Result<MigrationPlan> {
  if (typeof content !== 'string' || content.trim() === '') {
    return err(appError('INVALID_INPUT', 'That file is empty. Choose a Handshook JSON file.'));
  }
  if (content.length > MAX_IMPORT_BYTES) {
    return err(
      appError(
        'INVALID_INPUT',
        `That file is larger than ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
      ),
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return err(
      appError(
        'INVALID_INPUT',
        'That file is not valid JSON. Choose conf.json, job_tracker.json, rate_stats_*.json, or a Handshook backup.',
      ),
    );
  }
  const parsedObject = legacyJsonObjectSchema.safeParse(raw);
  if (!parsedObject.success) {
    return err(appError('INVALID_INPUT', 'That JSON file does not contain an object.'));
  }
  const rawObject = parsedObject.data;

  const detected = detectLegacyKind(rawObject);
  const kind = kindInput === 'auto' ? detected : kindInput;
  if (!kind) {
    return err(
      appError(
        'INVALID_INPUT',
        'Could not tell which Handshook file this is. Choose the file type explicitly.',
      ),
    );
  }
  if (kindInput !== 'auto' && detected && detected !== kindInput) {
    return err(
      appError(
        'INVALID_INPUT',
        `That file looks like ${kindLabel(detected)}, not ${kindLabel(kindInput)}.`,
      ),
    );
  }

  switch (kind) {
    case 'conf':
      return ok(parseConf(rawObject));
    case 'tracker':
      return ok(parseTracker(rawObject));
    case 'rate_stats':
      return parseRateStats(rawObject);
    case 'backup':
      return parseBackup(rawObject);
    default: {
      const exhaustive: never = kind;
      void exhaustive;
      return err(appError('INVALID_INPUT', 'Unsupported file type.'));
    }
  }
}

/** How many document IDs a settings block carries (the default plus saved extras). */
function countConfiguredDocumentIds(documents: Settings['documents'] | undefined): number {
  if (!documents) return 0;
  let count = documents.defaultResumeId ? 1 : 0;
  count += Math.min(documents.additionalResumes?.length ?? 0, MAX_ADDITIONAL_RESUMES);
  if (documents.coverLetterId) count += 1;
  if (documents.transcriptId) count += 1;
  if (documents.otherDocumentId) count += 1;
  return count;
}

/** Human-readable counts for the pre-import preview. Pure. */
export function previewPlan(plan: MigrationPlan): MigrationPreview {
  switch (plan.kind) {
    case 'conf':
      return {
        kind: 'conf',
        title: plan.profileName ? `conf.json — “${truncate(plan.profileName, 60)}”` : 'conf.json',
        note: 'Imports document IDs and names, saved searches, keywords, pacing, and the first active profile. Cookies and secrets are skipped.',
        counts: [
          {
            label: 'Resumes',
            value: plan.additionalResumes.length + (plan.defaultResumeId ? 1 : 0),
          },
          { label: 'Saved searches', value: plan.searches.length },
          { label: 'Include keywords', value: plan.includeKeywords?.length ?? 0 },
          { label: 'Exclude keywords', value: plan.excludeKeywords?.length ?? 0 },
          { label: 'Pacing settings', value: Object.keys(plan.pacing).length },
          { label: 'Cover letter ID', value: plan.coverLetterId ? 1 : 0 },
          { label: 'Transcript ID', value: plan.transcriptId ? 1 : 0 },
          { label: 'Profiles', value: plan.profileName ? 1 : 0 },
        ],
        warnings: plan.warnings,
      };
    case 'tracker': {
      const counts = new Map<string, number>();
      for (const entry of plan.entries) {
        counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
      }
      return {
        kind: 'tracker',
        title: 'job_tracker.json',
        note: 'Imports job statuses and keeps their timestamps. Applied, external, and blocked jobs stay final and are never made retryable.',
        counts: [
          { label: 'Total jobs', value: plan.entries.length },
          ...[...counts.entries()].map(([status, value]) => ({
            label: `Status: ${status}`,
            value,
          })),
        ],
        warnings: plan.warnings,
      };
    }
    case 'rate_stats':
      return {
        kind: 'rate_stats',
        title: `rate_stats — ${plan.dateKey}`,
        note: "Adds today's application count so the extension does not over-apply on the first day. Older history is not imported.",
        counts: [
          { label: "Today's applications", value: plan.todayCount },
          ...(plan.totalApplications !== undefined
            ? [{ label: 'All-time applications', value: plan.totalApplications }]
            : []),
        ],
        warnings: plan.warnings,
      };
    case 'backup':
      return {
        kind: 'backup',
        title: 'Handshook backup',
        note: 'Restores settings, reusable answers, jobs, and tracker entries. Document IDs and names come from settings; API keys are never part of a backup.',
        counts: [
          { label: 'Settings', value: plan.settings ? 1 : 0 },
          { label: 'Answers', value: plan.answers.length },
          {
            label: 'Document IDs',
            value: countConfiguredDocumentIds(plan.settings?.documents),
          },
          { label: 'Tracker entries', value: plan.tracker.length },
          { label: 'Jobs', value: plan.jobs.length },
        ],
        warnings: plan.warnings,
      };
    default: {
      const exhaustive: never = plan;
      void exhaustive;
      return { kind: 'backup', title: 'Unknown', note: '', counts: [], warnings: [] };
    }
  }
}

/**
 * A summary built from a parsed plan without touching storage. Used by the
 * demo bridge; the real import returns the counts it actually wrote.
 */
export function summarizePlan(
  plan: MigrationPlan,
  extraWarnings: string[] = [],
): MigrationImportSummary {
  const warnings = [...previewPlan(plan).warnings, ...extraWarnings];
  const base: MigrationImportSummary = {
    kind: plan.kind,
    settingsUpdated: false,
    documentsConfigured: 0,
    searchesAdded: 0,
    trackerImported: 0,
    trackerKept: 0,
    answersImported: 0,
    jobsImported: 0,
    todayCount: 0,
    warnings,
  };
  switch (plan.kind) {
    case 'conf':
      return {
        ...base,
        settingsUpdated: true,
        documentsConfigured:
          (plan.defaultResumeId ? 1 : 0) +
          plan.additionalResumes.length +
          (plan.coverLetterId ? 1 : 0) +
          (plan.transcriptId ? 1 : 0) +
          (plan.otherDocumentId ? 1 : 0),
        searchesAdded: plan.searches.length,
      };
    case 'tracker':
      return { ...base, trackerImported: plan.entries.length };
    case 'rate_stats':
      return {
        ...base,
        todayCount: plan.todayCount,
        ...(plan.totalApplications !== undefined
          ? { totalApplications: plan.totalApplications }
          : {}),
      };
    case 'backup':
      return {
        ...base,
        settingsUpdated: Boolean(plan.settings),
        documentsConfigured: countConfiguredDocumentIds(plan.settings?.documents),
        trackerImported: plan.tracker.length,
        answersImported: plan.answers.length,
        jobsImported: plan.jobs.length,
      };
    default: {
      const exhaustive: never = plan;
      void exhaustive;
      return base;
    }
  }
}
