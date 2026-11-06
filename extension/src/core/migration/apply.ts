/**
 * Storage side of the legacy migration.
 *
 * Parsing already happened in `parse.ts`; this module merges plans into the
 * existing repositories. Rules that keep imports safe:
 *
 * - tracker entries are upserts keyed by `jobId`, so re-imports never duplicate;
 * - a terminal status already in the extension always wins (applied can never
 *   become retryable);
 * - older imported timestamps never overwrite newer extension state;
 * - `rate_stats` only ever raises today's counter.
 */

import {
  DEFAULT_SETTINGS,
  DB_STORES,
  MAX_ADDITIONAL_RESUMES,
  appError,
  err,
  isAllowedHandshakeHost,
  ok,
  type AdditionalResume,
  type AppError,
  type DocumentType,
  type Job,
  type JobStatus,
  type QueueItem,
  type Result,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { normalizeAnswerSafety } from '@/core/answers/answerDraft';
import { log } from '@/core/logging/logger';
import { redactText } from '@/core/logging/redact';
import { getDb, getMeta, setMeta } from '@/core/storage/db';
import { getJob, putJob } from '@/core/storage/jobs';
import { getQueueItem, isTerminalStatus, upsertQueueItem } from '@/core/storage/tracker';
import { loadSettings, markAiMigration, updateSettings } from '@/core/storage/settings';
import { simpleHash } from '@/core/util/hash';
import { isAllowedHandshakeUrl } from '@/core/util/urls';
import { now } from '@/core/util/time';
import type {
  BackupMigrationPlan,
  ConfMigrationPlan,
  MigrationImportSummary,
  MigrationPlan,
  RateStatsMigrationPlan,
  TrackerMigrationEntry,
  TrackerMigrationPlan,
} from './types';

interface QueueSeed {
  jobId: string;
  status: JobStatus;
  timestamp: number;
  addedAt?: number;
  priority?: number;
  attempts?: number;
  nextAttemptAt?: number;
  lastError?: AppError;
  pendingQuestionIds?: string[];
  missingDocumentTypes?: DocumentType[];
  submissionAttemptId?: string;
  runId?: string;
}

function emptySummary(
  kind: MigrationImportSummary['kind'],
  warnings: string[],
): MigrationImportSummary {
  return {
    kind,
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
}

/** Document IDs a restored settings block carries; used for the import summary. */
function configuredDocumentCount(documents: Settings['documents']): number {
  let count = documents.defaultResumeId ? 1 : 0;
  count += Math.min(documents.additionalResumes?.length ?? 0, MAX_ADDITIONAL_RESUMES);
  if (documents.coverLetterId) count += 1;
  if (documents.transcriptId) count += 1;
  if (documents.otherDocumentId) count += 1;
  return count;
}

/**
 * Merges one tracker-style row. Returns `false` when the existing record is
 * more authoritative (terminal, already identical, or newer).
 */
async function mergeQueueSeed(seed: QueueSeed): Promise<boolean> {
  const existing = await getQueueItem(seed.jobId);
  if (existing) {
    if (isTerminalStatus(existing.status)) return false;
    if (existing.status === seed.status && existing.updatedAt === seed.timestamp) return false;
    if (seed.timestamp < existing.updatedAt) return false;
  }

  const next: QueueItem = existing
    ? { ...existing }
    : {
        jobId: seed.jobId,
        status: seed.status,
        priority: seed.priority ?? 0,
        attempts: seed.attempts ?? 0,
        addedAt: seed.addedAt ?? seed.timestamp,
        updatedAt: seed.timestamp,
      };

  next.jobId = seed.jobId;
  next.status = seed.status;
  next.priority = seed.priority ?? next.priority;
  next.attempts = seed.attempts ?? next.attempts;
  next.addedAt = existing?.addedAt ?? seed.addedAt ?? seed.timestamp;
  next.updatedAt = seed.timestamp;

  if (seed.nextAttemptAt !== undefined) next.nextAttemptAt = seed.nextAttemptAt;
  else delete next.nextAttemptAt;
  if (seed.lastError !== undefined) next.lastError = seed.lastError;
  else delete next.lastError;
  if (seed.pendingQuestionIds !== undefined) next.pendingQuestionIds = seed.pendingQuestionIds;
  else delete next.pendingQuestionIds;
  if (seed.missingDocumentTypes !== undefined) {
    next.missingDocumentTypes = seed.missingDocumentTypes;
  } else {
    delete next.missingDocumentTypes;
  }
  if (seed.submissionAttemptId !== undefined) next.submissionAttemptId = seed.submissionAttemptId;
  else delete next.submissionAttemptId;
  if (seed.runId !== undefined) next.runId = seed.runId;
  else delete next.runId;

  await upsertQueueItem(next);
  return true;
}

async function ensureImportedJob(
  jobId: string,
  host: string,
  title: string,
  employer: string,
  timestamp: number,
  applyType: Job['applyType'],
): Promise<boolean> {
  const existing = await getJob(jobId);
  if (existing) return false;
  const job: Job = {
    id: jobId,
    host,
    title: title || `Job ${jobId}`,
    employer: employer || 'Unknown employer',
    url: `https://${host}/jobs/${jobId}`,
    description: '',
    applyType,
    requiredDocumentTypes: [],
    source: 'import',
    discoveredAt: timestamp,
  };
  await putJob(job);
  return true;
}

function trackerError(entry: TrackerMigrationEntry): AppError | undefined {
  if (entry.status === 'blocked') {
    return appError(
      'MISSING_DOCUMENT',
      redactText(entry.note ?? 'Imported from the Python tool as unsupported.'),
      { retryable: false },
    );
  }
  if (entry.status === 'failed') {
    return appError(
      'UNKNOWN',
      redactText(entry.note ?? 'Imported from the Python tool as failed.'),
      { retryable: true },
    );
  }
  return undefined;
}

async function applyConf(plan: ConfMigrationPlan): Promise<MigrationImportSummary> {
  const current = await loadSettings();
  const summary = emptySummary('conf', [...plan.warnings]);
  const currentDocuments = current.documents;
  const documentsPatch: NonNullable<SettingsPatch['documents']> = {};

  /* Document IDs ----------------------------------------------------------- */
  // Never replace a document the user already chose; only fill an empty slot.
  if (plan.defaultResumeId) {
    if (!currentDocuments.defaultResumeId) {
      documentsPatch.defaultResumeId = plan.defaultResumeId;
      if (plan.defaultResumeName) documentsPatch.defaultResumeName = plan.defaultResumeName;
      summary.documentsConfigured += 1;
    } else if (
      currentDocuments.defaultResumeId === plan.defaultResumeId &&
      !currentDocuments.defaultResumeName?.trim() &&
      plan.defaultResumeName
    ) {
      documentsPatch.defaultResumeName = plan.defaultResumeName;
      summary.documentsConfigured += 1;
    }
  }

  const targetDefaultId = documentsPatch.defaultResumeId ?? currentDocuments.defaultResumeId;
  // If the user already has a different default, the legacy preferred resume is
  // still a resume worth keeping, so it joins the additional list.
  const resumeCandidates: AdditionalResume[] = [];
  if (plan.defaultResumeId && plan.defaultResumeId !== targetDefaultId) {
    resumeCandidates.push({
      id: plan.defaultResumeId,
      name: plan.defaultResumeName ?? plan.defaultResumeId,
    });
  }
  resumeCandidates.push(...plan.additionalResumes);

  const currentAdditional = currentDocuments.additionalResumes ?? [];
  const mergedAdditional = currentAdditional.filter((entry) => entry.id !== targetDefaultId);
  let additionalChanged = mergedAdditional.length !== currentAdditional.length;
  for (const resume of resumeCandidates) {
    if (resume.id === targetDefaultId) continue;
    const existing = mergedAdditional.find((entry) => entry.id === resume.id);
    if (existing) {
      if (!existing.name.trim() && resume.name) {
        existing.name = resume.name;
        additionalChanged = true;
        summary.documentsConfigured += 1;
      }
      continue;
    }
    if (mergedAdditional.length >= MAX_ADDITIONAL_RESUMES) continue;
    mergedAdditional.push({ id: resume.id, name: resume.name });
    additionalChanged = true;
    summary.documentsConfigured += 1;
  }
  if (additionalChanged) documentsPatch.additionalResumes = mergedAdditional;

  const singleSlots = [
    { id: plan.coverLetterId, key: 'coverLetterId' },
    { id: plan.transcriptId, key: 'transcriptId' },
    { id: plan.otherDocumentId, key: 'otherDocumentId' },
  ] as const;
  for (const slot of singleSlots) {
    if (slot.id && !currentDocuments[slot.key]) {
      documentsPatch[slot.key] = slot.id;
      summary.documentsConfigured += 1;
    }
  }

  /* Settings -------------------------------------------------------------- */
  const patch: SettingsPatch = {};
  if (Object.keys(documentsPatch).length > 0) patch.documents = documentsPatch;

  const mergedSearches = [...current.search.savedSearches];
  const knownUrls = new Set(mergedSearches.map((search) => search.url.trim()));
  const addedIds: string[] = [];
  const stamp = now();
  for (const search of plan.searches) {
    const url = search.url.trim();
    if (!url || knownUrls.has(url)) continue;
    // M12: defense in depth — a parsed plan may have been tampered with before
    // it crossed the message boundary.
    if (!isAllowedHandshakeUrl(url)) continue;
    let id = `legacy-search-${simpleHash(url)}`;
    let suffix = 1;
    while (mergedSearches.some((entry) => entry.id === id)) {
      id = `legacy-search-${simpleHash(url)}-${suffix}`;
      suffix += 1;
    }
    mergedSearches.push({
      id,
      name: search.name,
      url,
      enabled: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    knownUrls.add(url);
    addedIds.push(id);
    summary.searchesAdded += 1;
  }

  const searchPatch: NonNullable<SettingsPatch['search']> = {};
  if (summary.searchesAdded > 0) searchPatch.savedSearches = mergedSearches;
  const activeStillExists = current.search.activeSearchId
    ? mergedSearches.some((entry) => entry.id === current.search.activeSearchId)
    : false;
  const nextActive = activeStillExists ? current.search.activeSearchId : addedIds[0];
  if (nextActive && nextActive !== current.search.activeSearchId) {
    searchPatch.activeSearchId = nextActive;
  }
  if (plan.includeKeywords !== undefined) searchPatch.includeKeywords = plan.includeKeywords;
  if (plan.excludeKeywords !== undefined) searchPatch.excludeKeywords = plan.excludeKeywords;
  if (Object.keys(searchPatch).length > 0) patch.search = searchPatch;

  if (Object.keys(plan.pacing).length > 0) patch.pacing = plan.pacing;

  if (Object.keys(patch).length > 0) {
    await updateSettings(patch);
    summary.settingsUpdated = true;
  }

  await log('info', 'migration.imported', 'Imported legacy conf.json', {
    data: {
      documents: summary.documentsConfigured,
      searches: summary.searchesAdded,
      keywords: (plan.includeKeywords?.length ?? 0) + (plan.excludeKeywords?.length ?? 0),
      pacingKeys: Object.keys(plan.pacing).length,
    },
  });
  return summary;
}

async function applyTracker(plan: TrackerMigrationPlan): Promise<MigrationImportSummary> {
  const summary = emptySummary('tracker', [...plan.warnings]);
  const settings = await loadSettings();
  const host = settings.host || DEFAULT_SETTINGS.host;

  for (const entry of plan.entries) {
    const created = await ensureImportedJob(
      entry.jobId,
      host,
      entry.title,
      entry.employer,
      entry.timestamp,
      entry.status === 'external' ? 'external' : 'unknown',
    );
    if (created) summary.jobsImported += 1;

    const lastError = trackerError(entry);
    const merged = await mergeQueueSeed({
      jobId: entry.jobId,
      status: entry.status,
      timestamp: entry.timestamp,
      attempts: entry.status === 'applied' || entry.status === 'external' ? 1 : 0,
      ...(entry.nextAttemptAt !== undefined ? { nextAttemptAt: entry.nextAttemptAt } : {}),
      ...(lastError ? { lastError } : {}),
    });
    if (merged) summary.trackerImported += 1;
    else summary.trackerKept += 1;
  }

  await log('info', 'migration.imported', 'Imported legacy job_tracker.json', {
    data: {
      imported: summary.trackerImported,
      kept: summary.trackerKept,
      total: plan.entries.length,
    },
  });
  return summary;
}

async function applyRateStats(plan: RateStatsMigrationPlan): Promise<MigrationImportSummary> {
  const summary = emptySummary('rate_stats', [...plan.warnings]);
  const key = `dailyCount:${plan.dateKey}`;
  const existing = (await getMeta<number>(key)) ?? 0;
  const next = Math.max(existing, plan.todayCount);
  if (next !== existing) await setMeta(key, next);
  summary.todayCount = next;

  if (plan.totalApplications !== undefined) {
    const existingTotal = (await getMeta<number>('legacyTotalApplications')) ?? 0;
    const total = Math.max(existingTotal, plan.totalApplications);
    if (total !== existingTotal) await setMeta('legacyTotalApplications', total);
    summary.totalApplications = total;
  }

  await log('info', 'migration.imported', 'Imported legacy rate statistics', {
    data: { date: plan.dateKey, todayCount: next },
  });
  return summary;
}

async function applyBackup(plan: BackupMigrationPlan): Promise<MigrationImportSummary> {
  const summary = emptySummary('backup', [...plan.warnings]);
  if (plan.geminiReplaced) await markAiMigration();

  if (plan.settings) {
    // M12: never restore a host or saved search that points off Handshake.
    const nativeSearches = plan.settings.search.savedSearches.filter((search) =>
      isAllowedHandshakeUrl(search.url),
    );
    if (nativeSearches.length !== plan.settings.search.savedSearches.length) {
      summary.warnings.push(
        'Ignored saved searches in the backup that were not HTTPS Handshake URLs.',
      );
    }
    const host = isAllowedHandshakeHost(plan.settings.host)
      ? plan.settings.host
      : DEFAULT_SETTINGS.host;
    const activeExists = nativeSearches.some(
      (search) => search.id === plan.settings?.search.activeSearchId,
    );
    await updateSettings({
      ...plan.settings,
      host,
      search: {
        ...plan.settings.search,
        savedSearches: nativeSearches,
        activeSearchId: activeExists ? plan.settings.search.activeSearchId : nativeSearches[0]?.id,
      },
    });
    summary.settingsUpdated = true;
  }
  const settings = await loadSettings();
  summary.documentsConfigured = plan.settings ? configuredDocumentCount(settings.documents) : 0;
  const host = settings.host || DEFAULT_SETTINGS.host;

  if (plan.answers.length > 0) {
    const db = await getDb();
    const tx = db.transaction(DB_STORES.answers, 'readwrite');
    // M9: re-derive sensitivity/category from the label on restore. A stored
    // `sensitive: false` must not survive into the answer bank.
    for (const answer of plan.answers) {
      await tx.store.put(normalizeAnswerSafety(answer));
    }
    await tx.done;
    summary.answersImported = plan.answers.length;
  }

  for (const job of plan.jobs) {
    if (!isAllowedHandshakeUrl(job.url)) continue;
    if (await getJob(job.id)) continue;
    await putJob(job);
    summary.jobsImported += 1;
  }

  for (const item of plan.tracker) {
    const hasJob = await getJob(item.jobId);
    if (!hasJob) {
      const created = await ensureImportedJob(
        item.jobId,
        host,
        '',
        '',
        item.addedAt,
        item.status === 'external' ? 'external' : 'unknown',
      );
      if (created) summary.jobsImported += 1;
    }
    const merged = await mergeQueueSeed({
      jobId: item.jobId,
      status: item.status,
      timestamp: item.updatedAt,
      addedAt: item.addedAt,
      priority: item.priority,
      attempts: item.attempts,
      ...(item.nextAttemptAt !== undefined ? { nextAttemptAt: item.nextAttemptAt } : {}),
      ...(item.lastError ? { lastError: item.lastError } : {}),
      ...(item.pendingQuestionIds ? { pendingQuestionIds: item.pendingQuestionIds } : {}),
      ...(item.missingDocumentTypes ? { missingDocumentTypes: item.missingDocumentTypes } : {}),
      ...(item.submissionAttemptId ? { submissionAttemptId: item.submissionAttemptId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    });
    if (merged) summary.trackerImported += 1;
    else summary.trackerKept += 1;
  }

  await log('info', 'migration.imported', 'Restored a Handshook backup', {
    data: {
      settings: summary.settingsUpdated,
      answers: summary.answersImported,
      documents: summary.documentsConfigured,
      jobs: summary.jobsImported,
      tracker: summary.trackerImported,
    },
  });
  return summary;
}

/**
 * Applies a parsed plan. Expected failures return `AppError`; programmer errors
 * (storage corruption, quota) are mapped to a retryable `UNKNOWN`.
 */
export async function applyLegacyImport(
  plan: MigrationPlan,
): Promise<Result<MigrationImportSummary>> {
  try {
    switch (plan.kind) {
      case 'conf':
        return ok(await applyConf(plan));
      case 'tracker':
        return ok(await applyTracker(plan));
      case 'rate_stats':
        return ok(await applyRateStats(plan));
      case 'backup':
        return ok(await applyBackup(plan));
      default: {
        const exhaustive: never = plan;
        void exhaustive;
        return err(appError('INVALID_INPUT', 'Unsupported import plan.'));
      }
    }
  } catch (cause) {
    return err(
      appError('UNKNOWN', 'The import could not be saved to local storage.', {
        retryable: true,
        cause,
      }),
    );
  }
}

/** Settings-only helper used by tests and the preview screen. */
export function isTerminalImportStatus(status: JobStatus): boolean {
  return isTerminalStatus(status);
}

/** Exported for the backup export; keeps the list of preserved settings fields explicit. */
export type MigrationSettings = Settings;
