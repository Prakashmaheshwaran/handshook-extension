/**
 * Pure serializers for exports. Kept free of storage imports so the side panel
 * can build the demo exports without pulling IndexedDB adapters into the UI
 * bundle.
 */

import {
  answerSchema,
  jobSchema,
  parseSettings,
  type Answer,
  type Job,
  type QueueItem,
} from '@/core/contracts';
import { legacyQueueItemSchema } from './schemas';
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupInput } from './types';
import { redactSecretsData, redactSecretsText } from '@/core/logging/redact';

const CSV_HEADER = [
  'job_id',
  'status',
  'title',
  'employer',
  'url',
  'host',
  'applied_at',
  'attempts',
] as const;

/** Application outcomes that belong in an "applications" export. */
const APPLICATION_STATUSES: ReadonlySet<QueueItem['status']> = new Set([
  'applied',
  'already_applied',
  'external',
]);

function csvCell(value: string, secrets: readonly string[]): string {
  const safe = redactSecretsText(value, secrets);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function isoOrEmpty(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '';
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '';
  }
}

export interface ApplicationsCsvInput {
  items: QueueItem[];
  jobs: Job[];
}

/**
 * Newest first. `applied_at` is the tracker's `updatedAt`, which the extension
 * sets when a submission is confirmed (imported entries preserve their legacy
 * timestamp instead).
 */
export function buildApplicationsCsv(
  input: ApplicationsCsvInput,
  secrets: readonly string[] = [],
): string {
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  const rows = input.items
    .filter((item) => APPLICATION_STATUSES.has(item.status))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.jobId.localeCompare(b.jobId));

  const lines = [CSV_HEADER.join(',')];
  for (const item of rows) {
    const job = jobsById.get(item.jobId);
    const host = job?.host ?? '';
    const url = job?.url ?? (host ? `https://${host}/jobs/${item.jobId}` : '');
    lines.push(
      [
        item.jobId,
        item.status,
        job?.title ?? '',
        job?.employer ?? '',
        url,
        host,
        isoOrEmpty(item.updatedAt),
        String(item.attempts),
      ]
        .map((value) => csvCell(value, secrets))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function safeAnswer(answer: Answer): Answer | null {
  const parsed = answerSchema.safeParse(answer);
  return parsed.success ? (parsed.data as Answer) : null;
}

function safeQueueItem(item: QueueItem): QueueItem | null {
  const parsed = legacyQueueItemSchema.safeParse(item);
  return parsed.success ? (parsed.data as QueueItem) : null;
}

function safeJob(job: Job): Job | null {
  const parsed = jobSchema.safeParse(job);
  return parsed.success ? (parsed.data as Job) : null;
}

/**
 * Produces the JSON backup. The shape is validated by `parseBackup`, so this
 * output can be fed straight back into the import screen. Allowlist fields only
 * — credentials are never exported, including ones pasted into free text.
 */
export function buildBackupJson(input: BackupInput, secrets: readonly string[] = []): string {
  const settings = parseSettings(input.settings);
  if (!settings.ok) {
    throw new Error('Refusing to export invalid settings.');
  }

  const backup = {
    privacyNotice:
      'Private backup: contains your searches, answers, document IDs and names, and application history. API keys and authentication data are excluded. Do not attach this file to bug reports.',
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.exportedAt ?? Date.now(),
    settings: settings.value,
    answers: input.answers.map(safeAnswer).filter((entry): entry is Answer => entry !== null),
    tracker: input.tracker.map(safeQueueItem).filter((entry): entry is QueueItem => entry !== null),
    jobs: input.jobs.map(safeJob).filter((entry): entry is Job => entry !== null),
  };
  return JSON.stringify(redactSecretsData(backup, secrets), null, 2);
}
