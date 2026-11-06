/**
 * Types for the legacy Python → extension migration (T33).
 *
 * Parsing is pure and lives in `parse.ts`; storage writes live in `apply.ts`.
 * The UI only ever sends the raw file text plus a detected kind, so no parsed
 * plan has to cross the extension message boundary.
 */

import type {
  AdditionalResume,
  Answer,
  Job,
  JobStatus,
  LegacyFileKind,
  LegacyFileKindInput,
  QueueItem,
  Settings,
  SettingsPatch,
} from '@/core/contracts';

export type { LegacyFileKind, LegacyFileKindInput };

/** Backup format written by `buildBackupJson`; bumped only for breaking changes. */
export const BACKUP_FORMAT = 'handshook-backup';
export const BACKUP_VERSION = 1;

/** Refuse absurd file sizes before parsing (config files are a few KB). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type LegacyCategory =
  'applied' | 'external' | 'skipped' | 'unsupported' | 'failed' | 'waiting';

export interface LegacySearchInput {
  name: string;
  url: string;
}

export interface ConfMigrationPlan {
  kind: 'conf';
  /** The resume that becomes the default (the active profile's choice, else the first). */
  defaultResumeId?: string;
  defaultResumeName?: string;
  /** Up to MAX_ADDITIONAL_RESUMES other resumes from the legacy list. */
  additionalResumes: AdditionalResume[];
  coverLetterId?: string;
  transcriptId?: string;
  otherDocumentId?: string;
  searches: LegacySearchInput[];
  /** `undefined` means the key was absent; `[]` means it was explicitly empty. */
  includeKeywords?: string[];
  excludeKeywords?: string[];
  pacing: Partial<Settings['pacing']>;
  profileName?: string;
  ignoredKeys: string[];
  secretKeys: string[];
  warnings: string[];
}

export interface TrackerMigrationEntry {
  jobId: string;
  category: LegacyCategory;
  status: JobStatus;
  title: string;
  employer: string;
  /** Preserved from `applied_at`/`recorded_at`; falls back to import time. */
  timestamp: number;
  nextAttemptAt?: number;
  /** Python error/reason text, already truncated; never a secret. */
  note?: string;
}

export interface TrackerMigrationPlan {
  kind: 'tracker';
  entries: TrackerMigrationEntry[];
  ignoredCategories: string[];
  warnings: string[];
}

export interface RateStatsMigrationPlan {
  kind: 'rate_stats';
  /** Local-date key (`YYYY-MM-DD`) matched in `daily_counts`. */
  dateKey: string;
  todayCount: number;
  totalApplications?: number;
  warnings: string[];
}

export interface BackupMigrationPlan {
  kind: 'backup';
  settings?: Settings;
  geminiReplaced?: boolean;
  answers: Answer[];
  tracker: QueueItem[];
  jobs: Job[];
  warnings: string[];
}

export type MigrationPlan =
  ConfMigrationPlan | TrackerMigrationPlan | RateStatsMigrationPlan | BackupMigrationPlan;

export interface MigrationPreviewCount {
  label: string;
  value: number;
}

export interface MigrationPreview {
  kind: LegacyFileKind;
  title: string;
  note: string;
  counts: MigrationPreviewCount[];
  warnings: string[];
}

/** Result of applying a plan. Every field is a count unless noted. */
export interface MigrationImportSummary {
  kind: LegacyFileKind;
  settingsUpdated: boolean;
  /** Document IDs this import wrote into settings (default, extra resumes, cover, transcript, other). */
  documentsConfigured: number;
  searchesAdded: number;
  trackerImported: number;
  trackerKept: number;
  answersImported: number;
  jobsImported: number;
  /** Today's resulting count after a rate-stats import (0 otherwise). */
  todayCount: number;
  totalApplications?: number;
  warnings: string[];
}

export interface MigrationExportPayload {
  filename: string;
  text: string;
  mimeType: string;
}

export interface BackupInput {
  settings: Settings;
  answers: Answer[];
  tracker: QueueItem[];
  jobs: Job[];
  exportedAt?: number;
}

/** A partial settings patch built from conf.json; kept narrow for type safety. */
export type MigrationSettingsPatch = SettingsPatch;
