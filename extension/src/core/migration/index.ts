/**
 * Legacy import/export (T33).
 *
 * Public surface used by the background router, the settings screen, and tests.
 */

export { parseLegacyFile, detectLegacyKind, previewPlan, summarizePlan } from './parse';
export { applyLegacyImport, isTerminalImportStatus } from './apply';
export {
  buildApplicationsCsv,
  buildBackupJson,
  exportApplicationsCsv,
  exportBackupJson,
} from './export';
export { isSecretKey, isCommentKey } from './secrets';
export { BACKUP_FORMAT, BACKUP_VERSION, MAX_IMPORT_BYTES } from './types';
export type {
  BackupInput,
  BackupMigrationPlan,
  ConfMigrationPlan,
  LegacyCategory,
  LegacyFileKind,
  LegacyFileKindInput,
  LegacySearchInput,
  MigrationExportPayload,
  MigrationImportSummary,
  MigrationPlan,
  MigrationPreview,
  MigrationPreviewCount,
  RateStatsMigrationPlan,
  TrackerMigrationEntry,
  TrackerMigrationPlan,
} from './types';
