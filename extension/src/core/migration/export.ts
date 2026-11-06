/**
 * Storage-backed export helpers for the background router.
 *
 * Pure serialization lives in `serialize.ts`; this module only loads data from
 * the repositories and names the files.
 */

import type { Answer, Job, QueueItem, Settings } from '@/core/contracts';
import { listAnswers } from '@/core/storage/answers';
import { listJobs } from '@/core/storage/jobs';
import { loadAiKeys, loadSettings } from '@/core/storage/settings';
import { listQueue } from '@/core/storage/tracker';
import { todayKey } from '@/core/util/time';
import { buildApplicationsCsv, buildBackupJson } from './serialize';
import type { MigrationExportPayload } from './types';

export { buildApplicationsCsv, buildBackupJson } from './serialize';
export type { ApplicationsCsvInput } from './serialize';

async function loadAllQueue(): Promise<QueueItem[]> {
  return listQueue({ limit: Number.MAX_SAFE_INTEGER });
}

async function loadAllJobs(): Promise<Job[]> {
  return listJobs(Number.MAX_SAFE_INTEGER);
}

async function exportSecrets(): Promise<string[]> {
  const keys = await loadAiKeys();
  return typeof keys.openRouterApiKey === 'string' && keys.openRouterApiKey
    ? [keys.openRouterApiKey]
    : [];
}

export async function exportApplicationsCsv(): Promise<MigrationExportPayload> {
  const [items, jobs, secrets] = await Promise.all([
    loadAllQueue(),
    loadAllJobs(),
    exportSecrets(),
  ]);
  return {
    filename: `handshook-applications-${todayKey()}.csv`,
    text: buildApplicationsCsv({ items, jobs }, secrets),
    mimeType: 'text/csv',
  };
}

export async function exportBackupJson(): Promise<MigrationExportPayload> {
  const [settings, answers, items, jobs, secrets]: [
    Settings,
    Answer[],
    QueueItem[],
    Job[],
    string[],
  ] = await Promise.all([
    loadSettings(),
    listAnswers(),
    loadAllQueue(),
    loadAllJobs(),
    exportSecrets(),
  ]);
  return {
    filename: `handshook-backup-${todayKey()}.json`,
    text: buildBackupJson({ settings, answers, tracker: items, jobs }, secrets),
    mimeType: 'application/json',
  };
}
