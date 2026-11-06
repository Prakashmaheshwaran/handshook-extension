import { useState } from 'react';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { downloadTextFile } from '@/ui/components/download';
import { ErrorState } from '@/ui/components/ErrorState';
import { IconArrowLeft, IconDownload, IconRefresh, IconTrash } from '@/ui/components/icons';
import { Section } from '@/ui/components/Section';
import { ReportProblem } from '@/ui/components/ReportProblem';
import { LoadingBlock } from '@/ui/components/Skeleton';
import { Stat } from '@/ui/components/Stat';
import { StaleDataNotice } from '@/ui/components/StaleDataNotice';
import { formatDateTime, formatWhen, pluralize } from '@/ui/components/ui-copy';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useDiagnostics } from '@/ui/hooks/useDiagnostics';

export function DiagnosticsScreen() {
  const app = useAppContext();
  const diagnostics = useDiagnostics();
  const [confirmClear, setConfirmClear] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const exportBundle = async (): Promise<void> => {
    setExporting(true);
    const { payload, error } = await diagnostics.exportBundle();
    setExporting(false);
    if (error || !payload) {
      app.notify('error', error?.message ?? 'Export failed.');
      return;
    }
    downloadTextFile(payload.filename, payload.json);
    app.notify('success', 'Diagnostics bundle downloaded.');
  };

  const clearDiagnostics = async (): Promise<void> => {
    setClearing(true);
    const error = await diagnostics.clear();
    setClearing(false);
    setConfirmClear(false);
    if (error) app.notify('error', error.message);
    else app.notify('success', 'Diagnostics cleared.');
  };

  const data = diagnostics.diagnostics;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconArrowLeft size={13} />}
          onClick={() => app.navigate('settings')}
        >
          Settings
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconRefresh size={13} />}
          loading={diagnostics.loading && data !== null}
          onClick={() => void diagnostics.refresh()}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="secondary"
          iconLeft={<IconDownload size={13} />}
          loading={exporting}
          onClick={() => void exportBundle()}
        >
          Export shareable diagnostics
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconTrash size={13} />}
          onClick={() => setConfirmClear(true)}
        >
          Clear
        </Button>
      </div>
      <p className="text-[10.5px] leading-snug text-muted">
        Status codes, settings flags, counters and selector keys only — personal text is removed.
      </p>

      {diagnostics.error && !data ? (
        <ErrorState
          error={diagnostics.error}
          title="Cannot load diagnostics"
          onRetry={() => void diagnostics.refresh()}
        />
      ) : null}
      {diagnostics.error && data ? (
        <StaleDataNotice
          error={diagnostics.error}
          context="Showing the last loaded diagnostics"
          onRetry={() => void diagnostics.refresh()}
        />
      ) : null}

      {!data && !diagnostics.error ? <LoadingBlock label="Loading diagnostics" /> : null}

      {data ? (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">v{data.version}</Badge>
              <Badge tone="neutral">Protocol {data.protocolVersion}</Badge>
              <Badge tone="info">{data.mode}</Badge>
              {app.bridgeMode === 'mock' ? <Badge tone="warn">Demo data</Badge> : null}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat
                label="Host"
                value={<span className="text-[12.5px] font-medium break-all">{data.host}</span>}
              />
              <Stat
                label="Generated"
                value={
                  <span className="text-[12.5px] font-medium">{formatWhen(data.generatedAt)}</span>
                }
                hint={formatDateTime(data.generatedAt)}
              />
            </div>
            <div className="mt-2 rounded-md bg-surface-2 px-2 py-1.5">
              <p className="text-[11px] text-muted">
                Storage: <span className="font-medium text-ink">{data.storage.name}</span>
              </p>
              <p className="mt-0.5 break-words text-[11px] text-muted">{data.storage.detail}</p>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Stat label="Events" value={data.counts.events} />
              <Stat label="Answers" value={data.counts.answers} />
              <Stat label="Documents" value={data.counts.documents} />
            </div>
          </Card>

          <Section
            id="selector-health"
            title="Selector health"
            description="Which strategy found the page elements on the last checks."
          >
            <Card padded={false}>
              {data.selectors.length === 0 ? (
                <p className="px-3 py-3 text-[11.5px] text-muted">
                  No selector checks recorded yet. They appear after the first scan.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.selectors.map((health, index) => (
                    <li
                      key={`${health.selector}-${health.at}-${index}`}
                      className="flex items-start gap-2 px-3 py-2"
                    >
                      <Badge tone={health.ok ? 'success' : 'danger'}>
                        {health.ok ? 'OK' : 'Failed'}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[11px] text-ink">{health.selector}</p>
                        <p className="truncate text-[10.5px] text-muted">
                          {health.page} · {health.strategy} · {formatWhen(health.at)}
                        </p>
                        {health.detail ? (
                          <p className="mt-0.5 break-words text-[10.5px] text-danger">
                            {health.detail}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section
            id="recent-errors"
            title="Recent errors"
            description="Newest first. Messages are redacted before they are stored."
          >
            <Card padded={false}>
              {data.recentErrors.length === 0 ? (
                <p className="px-3 py-3 text-[11.5px] text-muted">No errors recorded.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.recentErrors.map((event) => (
                    <li key={event.id} className="px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[10.5px] text-muted">
                          {event.type}
                        </span>
                        <span className="hs-numeric shrink-0 text-[10.5px] text-muted">
                          {formatWhen(event.at)}
                        </span>
                      </div>
                      <p className="mt-0.5 break-words text-[11.5px] leading-snug text-ink">
                        {event.message}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section
            id="report-problem"
            title="Report a problem"
            description="Tell us what went wrong so it can be tracked and fixed."
          >
            <Card>
              <ReportProblem
                context={{
                  version: data.version,
                  mode: data.mode,
                  errorCodes: data.recentErrors.map((event) => event.type),
                }}
              />
            </Card>
          </Section>

          <Card tone="muted">
            <p className="text-[11px] leading-snug text-muted">
              {data.queue.total} {pluralize(data.queue.total, 'job')} tracked ·{' '}
              {data.queue.todayCount} of {data.queue.dailyCap} applications today. Diagnostics never
              include your password, cookies, AI key, or resume contents.
            </p>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Clear diagnostics?"
        description="Removes stored events and selector-health records. Your queue and settings stay."
        confirmLabel="Clear diagnostics"
        tone="danger"
        loading={clearing}
        onConfirm={() => void clearDiagnostics()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
