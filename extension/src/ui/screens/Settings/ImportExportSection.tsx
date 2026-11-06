import { useId, useState } from 'react';
import { appError, type AppError, type LegacyFileKindInput } from '@/core/contracts';
import { parseLegacyFile, previewPlan } from '@/core/migration/parse';
import {
  MAX_IMPORT_BYTES,
  type MigrationImportSummary,
  type MigrationPlan,
  type MigrationPreview,
} from '@/core/migration/types';
import { sendRequest } from '@/ui/bridge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { downloadTextFile } from '@/ui/components/download';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { Section } from '@/ui/components/Section';
import { Select, type SelectOption } from '@/ui/components/Select';
import { useAppContext } from '@/ui/hooks/useAppContext';

type Busy = 'importing' | 'csv' | 'json' | null;

const KIND_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'conf', label: 'conf.json (settings)' },
  { value: 'tracker', label: 'job_tracker.json (history)' },
  { value: 'rate_stats', label: "rate_stats_*.json (today's count)" },
  { value: 'backup', label: 'Handshook backup (JSON)' },
];

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summaryLines(summary: MigrationImportSummary): string[] {
  const lines: string[] = [];
  if (summary.settingsUpdated) lines.push('Settings updated');
  if (summary.documentsConfigured > 0) {
    lines.push(
      countLabel(summary.documentsConfigured, 'document ID configured', 'document IDs configured'),
    );
  }
  if (summary.searchesAdded > 0)
    lines.push(countLabel(summary.searchesAdded, 'saved search', 'saved searches'));
  if (summary.answersImported > 0) lines.push(countLabel(summary.answersImported, 'answer'));
  if (summary.jobsImported > 0) lines.push(countLabel(summary.jobsImported, 'job'));
  if (summary.trackerImported > 0 || summary.trackerKept > 0) {
    lines.push(
      `${countLabel(summary.trackerImported, 'tracker entry', 'tracker entries')} imported, ${summary.trackerKept} kept as-is`,
    );
  }
  if (summary.kind === 'rate_stats') {
    lines.push(`Today's count is now ${summary.todayCount}`);
  }
  if (lines.length === 0) lines.push('Nothing needed to change');
  return lines;
}

export function ImportExportSection() {
  const app = useAppContext();
  const selectId = useId();
  const fileId = useId();

  const [kind, setKind] = useState<LegacyFileKindInput>('auto');
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [summary, setSummary] = useState<MigrationImportSummary | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);

  const parseAndPreview = (nextKind: LegacyFileKindInput, text: string): void => {
    const parsed = parseLegacyFile(nextKind, text);
    if (!parsed.ok) {
      setError(parsed.error);
      setPlan(null);
      setPreview(null);
      return;
    }
    setError(null);
    setPlan(parsed.value);
    setPreview(previewPlan(parsed.value));
  };

  const clearFile = (): void => {
    setFileName(null);
    setContent(null);
    setPlan(null);
    setPreview(null);
    setSummary(null);
    setError(null);
    setFileInputKey((current) => current + 1);
  };

  const onFileChange = async (file: File | null): Promise<void> => {
    setSummary(null);
    setError(null);
    setPlan(null);
    setPreview(null);
    setContent(null);
    setFileName(null);
    if (!file) return;

    if (file.size > MAX_IMPORT_BYTES) {
      setError(
        appError(
          'INVALID_INPUT',
          `That file is larger than ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
        ),
      );
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      setError(appError('UNKNOWN', 'That file could not be read. Try again.'));
      return;
    }
    setFileName(file.name);
    setContent(text);
    parseAndPreview(kind, text);
  };

  const onKindChange = (next: LegacyFileKindInput): void => {
    setKind(next);
    setSummary(null);
    setConfirmOpen(false);
    if (content) parseAndPreview(next, content);
  };

  const doImport = async (): Promise<void> => {
    if (!plan || !content) return;
    setBusy('importing');
    setError(null);
    const result = await sendRequest({ type: 'ui.migration.import', kind, content });
    setBusy(null);
    if (!result.ok) {
      setConfirmOpen(false);
      setError(result.error);
      app.notify('error', result.error.message);
      return;
    }
    setConfirmOpen(false);
    setSummary(result.value);
    setFileName(null);
    setContent(null);
    setPlan(null);
    setPreview(null);
    setFileInputKey((current) => current + 1);
    app.notify('success', 'Import finished.');
    await app.refreshSettings();
  };

  const doExport = async (format: 'csv' | 'json'): Promise<void> => {
    setBusy(format === 'csv' ? 'csv' : 'json');
    setError(null);
    const result = await sendRequest({ type: 'ui.migration.export', format });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      app.notify('error', result.error.message);
      return;
    }
    downloadTextFile(result.value.filename, result.value.text, result.value.mimeType);
    app.notify(
      'success',
      format === 'csv' ? 'Applications CSV downloaded.' : 'JSON backup downloaded.',
    );
  };

  const canImport = Boolean(plan && content) && busy === null;

  return (
    <Section
      id="import-export"
      title="Import & export"
      description="Bring history from the Python tool, or move your Handshook data between browsers."
    >
      <div className="space-y-2.5">
        <Card tone="muted" padded={false} className="space-y-1.5 p-3">
          <p className="text-[11.5px] leading-snug text-ink">
            <span className="font-semibold">Imported:</span> document IDs and names, saved searches,
            keywords, pacing limits, job history, and today&apos;s application count. Pacing values
            are clamped to the extension&apos;s safe limits.
          </p>
          <p className="text-[11.5px] leading-snug text-muted">
            <span className="font-semibold text-ink">Never imported:</span> cookies, passwords, API
            keys, browser profile settings, or anything from <code>.env</code>. The extension uses
            your browser session instead of stored credentials.
          </p>
        </Card>

        <Field
          id={fileId}
          label="Legacy or backup file"
          hint="JSON only. The file is read locally in your browser and never uploaded."
        >
          <Input
            key={fileInputKey}
            id={fileId}
            type="file"
            accept=".json,application/json"
            disabled={busy !== null}
            onChange={(event) => void onFileChange(event.currentTarget.files?.[0] ?? null)}
          />
        </Field>

        <Field
          id={selectId}
          label="File type"
          hint="Auto-detect recognizes conf.json, job_tracker.json, rate_stats_*.json, and Handshook backups."
        >
          <Select
            id={selectId}
            value={kind}
            disabled={busy !== null}
            onChange={(event) => onKindChange(event.currentTarget.value as LegacyFileKindInput)}
            options={KIND_OPTIONS}
          />
        </Field>

        {fileName ? <p className="break-all text-[11px] text-muted">Selected: {fileName}</p> : null}

        {error ? (
          <p role="alert" className="break-words text-[11.5px] font-medium text-danger">
            {error.message}
          </p>
        ) : null}

        {preview ? (
          <Card tone="info" padded={false} className="p-3">
            <div aria-live="polite">
              <p className="text-[12px] font-semibold text-ink">Preview: {preview.title}</p>
              <p className="mt-1 text-[11.5px] leading-snug text-muted">{preview.note}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                {preview.counts.map((count) => (
                  <div key={count.label} className="flex items-baseline justify-between gap-2">
                    <dt className="min-w-0 truncate text-muted">{count.label}</dt>
                    <dd className="font-semibold tabular-nums text-ink">{count.value}</dd>
                  </div>
                ))}
              </dl>
              {preview.warnings.length > 0 ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-muted">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="primary"
                loading={busy === 'importing'}
                disabled={!canImport && busy !== 'importing'}
                onClick={() => setConfirmOpen(true)}
              >
                Import this file
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={clearFile}>
                Clear
              </Button>
            </div>
          </Card>
        ) : null}

        {summary ? (
          <Card tone="muted" padded={false} className="p-3">
            <div role="status" aria-live="polite">
              <p className="text-[12px] font-semibold text-ink">Import finished</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] leading-snug text-muted">
                {summaryLines(summary).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {summary.warnings.length > 0 ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-muted">
                  {summary.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>
        ) : null}

        <div className="space-y-1.5 rounded-panel border border-line bg-surface p-3">
          <p className="text-[12px] font-semibold text-ink">Export</p>
          <p className="text-[11.5px] leading-snug text-muted">
            The CSV lists applied, already-applied, and external jobs. The JSON backup restores
            settings — including document IDs and names — reusable answers, and job history.
            Credentials are excluded. Do not attach private backups to bug reports.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'csv'}
              disabled={busy !== null && busy !== 'csv'}
              onClick={() => void doExport('csv')}
            >
              Export applications CSV
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'json'}
              disabled={busy !== null && busy !== 'json'}
              onClick={() => void doExport('json')}
            >
              Export private backup (JSON)
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Import this file?"
        description={
          preview
            ? `${preview.title}. Existing final statuses are kept, and importing the same file again will not duplicate anything.`
            : undefined
        }
        confirmLabel="Import"
        loading={busy === 'importing'}
        onConfirm={() => void doImport()}
        onCancel={() => setConfirmOpen(false)}
      >
        {preview ? (
          <ul className="max-h-40 space-y-0.5 overflow-auto text-[11.5px] text-muted">
            {preview.counts
              .filter((count) => count.value > 0)
              .map((count) => (
                <li key={count.label} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">{count.label}</span>
                  <span className="font-semibold tabular-nums text-ink">{count.value}</span>
                </li>
              ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </Section>
  );
}
