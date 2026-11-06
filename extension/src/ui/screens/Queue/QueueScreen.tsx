import { useCallback, useMemo, useState } from 'react';
import type { AppError, JobStatus } from '@/core/contracts';
import { isExternalJob, safeExternalUrl } from '@/core/util/application-policy';
import { isImmutableStatus } from '@/core/orchestrator/queue';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { EmptyState } from '@/ui/components/EmptyState';
import { ErrorState } from '@/ui/components/ErrorState';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { Field } from '@/ui/components/Field';
import { IconQueue, IconRefresh, IconSearch } from '@/ui/components/icons';
import { Input } from '@/ui/components/Input';
import { JobDocumentChoices } from '@/ui/components/JobDocumentChoices';
import { Select } from '@/ui/components/Select';
import { Skeleton } from '@/ui/components/Skeleton';
import { StaleDataNotice } from '@/ui/components/StaleDataNotice';
import { JobStatusBadge } from '@/ui/components/StatusBadge';
import {
  APPLY_TYPE_COPY,
  formatPercent,
  friendlyErrorMessage,
  pluralize,
  queuePrimaryAction,
} from '@/ui/components/ui-copy';
import { sendRequest } from '@/ui/bridge';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useQueue } from '@/ui/hooks/useQueue';

type QueueFilter = 'all' | 'active' | 'review' | 'needs' | 'done' | 'external';

const ACTIVE_STATUSES: JobStatus[] = [
  'discovered',
  'queued',
  'opening',
  'filling',
  'submitting',
  'verifying',
  'waiting',
];

const DONE_STATUSES: JobStatus[] = [
  'applied',
  'would_apply',
  'already_applied',
  'skipped',
  'failed',
  'blocked',
  'filtered',
];

const FILTER_OPTIONS = [
  { value: 'all', label: 'All jobs' },
  { value: 'review', label: 'Ready to review' },
  { value: 'needs', label: 'Needs you' },
  { value: 'active', label: 'In progress' },
  { value: 'done', label: 'Finished / skipped' },
];

export function QueueScreen() {
  const app = useAppContext();
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [skipTarget, setSkipTarget] = useState<string | null>(null);
  const collectExternal = app.settings?.search.collectExternalJobs === true;
  const externalList = collectExternal && filter === 'external';
  const queue = useQueue(externalList);
  const { refresh: refreshQueue } = queue;
  const listItems = useMemo(
    () =>
      queue.items.filter(
        (item) => isExternalJob(queue.jobsById.get(item.jobId), item) === externalList,
      ),
    [queue.items, queue.jobsById, externalList],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return listItems.filter((item) => {
      if (filter === 'review' && item.status !== 'ready_for_review') return false;
      if (filter === 'needs' && item.status !== 'needs_input') return false;
      if (filter === 'active' && !ACTIVE_STATUSES.includes(item.status)) return false;
      if (filter === 'done' && !DONE_STATUSES.includes(item.status)) return false;
      if (!term) return true;
      const job = queue.jobsById.get(item.jobId);
      const haystack = `${job?.title ?? ''} ${job?.employer ?? ''} ${item.jobId}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [filter, listItems, queue.jobsById, search]);

  const runAction = useCallback(
    async (jobId: string, successMessage: string, action: () => Promise<AppError | null>) => {
      setBusyJobId(jobId);
      const error = await action();
      setBusyJobId(null);
      if (error) app.notify('error', friendlyErrorMessage(error));
      else app.notify('success', successMessage);
    },
    [app],
  );

  const refreshNow = useCallback(async () => {
    const error = await refreshQueue();
    if (error) app.notify('error', friendlyErrorMessage(error));
  }, [refreshQueue, app]);

  /**
   * A filled application is already waiting in the runner tab. Reviewing must
   * never put it back in the queue, so focus the tab (or send the user to
   * Needs you) instead of calling applyNow.
   */
  const reviewNow = useCallback(
    async (jobId: string) => {
      setBusyJobId(jobId);
      const result = await sendRequest({ type: 'ui.runner.focus' });
      setBusyJobId(null);
      if (!result.ok) {
        app.notify('error', friendlyErrorMessage(result.error));
        app.navigate('needs');
        return;
      }
      if (result.value.focused) {
        app.notify('info', 'Focused the Handshook runner tab.');
        return;
      }
      app.notify('info', 'No runner tab is open. Review this job from Needs you.');
      app.navigate('needs');
    },
    [app],
  );

  const skipJob = useCallback(
    async (jobId: string) => {
      setSkipTarget(null);
      await runAction(jobId, 'Job skipped.', () => queue.skip(jobId, 'Skipped from the queue'));
    },
    [queue, runAction],
  );

  const needsOnlyCount = listItems.filter((item) => item.status === 'needs_input').length;

  if (queue.error && queue.items.length === 0) {
    return <ErrorState error={queue.error} onRetry={() => void queue.refresh()} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="hs-numeric text-[11.5px] text-muted">
          Showing {visible.length} of {listItems.length}
          {needsOnlyCount > 0 ? ` · ${needsOnlyCount} need you` : ''}
        </p>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconRefresh size={13} />}
          loading={queue.loading && queue.items.length > 0}
          onClick={() => void refreshNow()}
        >
          Refresh
        </Button>
      </div>

      {queue.error && queue.items.length > 0 ? (
        <StaleDataNotice
          error={queue.error}
          context="Showing the last loaded queue"
          onRetry={() => void refreshNow()}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Filter queue" hideLabel>
          <Select
            compact
            value={filter === 'external' && !collectExternal ? 'all' : filter}
            onChange={(event) => setFilter(event.currentTarget.value as QueueFilter)}
            options={
              collectExternal
                ? [...FILTER_OPTIONS, { value: 'external', label: 'External links (beta)' }]
                : FILTER_OPTIONS
            }
          />
        </Field>
        <Field label="Search the queue" hideLabel>
          <div className="relative">
            <IconSearch
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <Input
              compact
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Title or employer"
              className="pl-7"
            />
          </div>
        </Field>
      </div>

      {externalList ? (
        <p className="text-[11.5px] text-muted">
          External links (beta) are for you to open manually. They are never automated or counted as
          applications.
        </p>
      ) : null}

      {queue.loading && queue.items.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2].map((key) => (
            <Card key={key}>
              <Skeleton lines={3} />
            </Card>
          ))}
        </div>
      ) : null}

      {!queue.loading && visible.length === 0 ? (
        <EmptyState
          icon={<IconQueue size={22} />}
          title={
            externalList
              ? 'No external links'
              : listItems.length === 0
                ? 'The queue is empty'
                : 'Nothing matches this filter'
          }
          description={
            queue.items.length === 0
              ? 'Start a run from the dashboard. Handshook scans your saved search and adds matching jobs here.'
              : 'Try a different status filter, or clear the search box.'
          }
          action={
            queue.items.length === 0 ? (
              <Button size="sm" variant="primary" onClick={() => app.navigate('dashboard')}>
                Go to dashboard
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            )
          }
        />
      ) : null}

      {visible.map((item) => {
        const job = queue.jobsById.get(item.jobId);
        if (externalList) {
          const employerUrl = safeExternalUrl(job?.externalUrl);
          return (
            <Card key={item.jobId}>
              <p className="break-words text-[13px] font-semibold text-ink">
                {job?.title ?? `Job ${item.jobId}`}
              </p>
              <p className="mt-0.5 break-words text-[11.5px] text-muted">
                {job?.employer ?? 'Unknown employer'}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {employerUrl ? (
                  <ExternalLink href={employerUrl}>Open on employer site</ExternalLink>
                ) : job ? (
                  <ExternalLink href={job.url}>Open posting to find employer link</ExternalLink>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busyJobId === item.jobId}
                  onClick={() =>
                    void runAction(item.jobId, 'External link dismissed.', () =>
                      queue.skip(item.jobId, 'Dismiss external link'),
                    )
                  }
                >
                  Dismiss
                </Button>
              </div>
            </Card>
          );
        }
        const need = queue.needs.find((entry) => entry.jobId === item.jobId);
        const busy = busyJobId === item.jobId;
        const immutable = isImmutableStatus(item.status);
        const retryable =
          item.status === 'failed' ||
          item.status === 'waiting' ||
          (item.status === 'blocked' && item.lastError?.code === 'UI_CHANGED');
        const primary = queuePrimaryAction(item.status);
        const missing = item.missingDocumentTypes ?? [];

        return (
          <Card key={item.jobId}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-[13px] font-semibold leading-snug text-ink">
                  {job?.title ?? `Job ${item.jobId}`}
                </p>
                <p className="mt-0.5 break-words text-[11.5px] leading-snug text-muted">
                  {job?.employer ?? 'Unknown employer'}
                  {job?.location ? ` · ${job.location}` : ''}
                  {job?.employmentType ? ` · ${job.employmentType}` : ''}
                </p>
              </div>
              <JobStatusBadge status={item.status} />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {job ? <Badge tone="neutral">{APPLY_TYPE_COPY[job.applyType]}</Badge> : null}
              {typeof job?.fitScore === 'number' ? (
                <Badge tone="info">Fit {formatPercent(job.fitScore)}</Badge>
              ) : null}
              {job?.remote ? <Badge tone="neutral">Remote</Badge> : null}
              {item.attempts > 0 ? (
                <Badge tone="neutral">
                  {item.attempts} {pluralize(item.attempts, 'try', 'tries')}
                </Badge>
              ) : null}
              {missing.length > 0 ? (
                <Badge tone="warn">
                  Missing {missing.map((type) => type.replace('_', ' ')).join(', ')}
                </Badge>
              ) : null}
            </div>

            {job?.fitReasons?.length ? (
              <ul className="mt-2 space-y-0.5 pl-4 text-[11px] leading-snug text-muted">
                {job.fitReasons.slice(0, 2).map((reason) => (
                  <li key={reason} className="list-disc">
                    {reason}
                  </li>
                ))}
              </ul>
            ) : null}

            {item.status === 'ready_for_review' && need?.message ? (
              <p className="mt-2 break-words rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] leading-snug text-muted">
                {need.message}
              </p>
            ) : null}
            {item.status === 'verifying' ? (
              <p className="mt-2 text-[11.5px] leading-snug text-muted">
                Submission not yet confirmed. Open the posting on Handshake to check its status
                before trying again.
              </p>
            ) : null}

            {item.skipReason ? (
              <p className="mt-2 break-words rounded-md bg-surface-2 px-2 py-1 text-[11px] leading-snug text-muted">
                Skipped. {item.skipReason}
              </p>
            ) : null}

            {item.lastError ? (
              <p
                className={[
                  'mt-2 break-words rounded-md px-2 py-1 text-[11px] leading-snug',
                  item.status === 'skipped'
                    ? 'bg-surface-2 text-muted'
                    : 'bg-danger-soft text-danger',
                ].join(' ')}
              >
                {item.status === 'skipped' ? 'Skipped. ' : ''}
                {friendlyErrorMessage(item.lastError)}
              </p>
            ) : null}

            {['discovered', 'queued', 'waiting', 'needs_input', 'failed'].includes(item.status) ? (
              <details className="mt-2 rounded-lg border border-line p-2.5">
                <summary className="cursor-pointer text-[12px] font-medium text-ink">
                  Documents for this job
                </summary>
                <div className="mt-2">
                  <JobDocumentChoices
                    jobId={item.jobId}
                    selection={item.documentSelection}
                    continueJob={item.status === 'needs_input'}
                    onSaved={refreshQueue}
                  />
                </div>
              </details>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {primary !== 'none' ? (
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  onClick={() => {
                    if (primary === 'answer') {
                      app.navigate('needs');
                      return;
                    }
                    if (primary === 'review') {
                      void reviewNow(item.jobId);
                      return;
                    }
                    void runAction(item.jobId, 'Queued to apply now.', () =>
                      queue.applyNow(item.jobId),
                    );
                  }}
                >
                  {primary === 'answer'
                    ? 'Answer'
                    : primary === 'review'
                      ? 'Review now'
                      : 'Apply now'}
                </Button>
              ) : null}
              {retryable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void runAction(item.jobId, 'Queued to retry.', () => queue.retry(item.jobId))
                  }
                >
                  Retry
                </Button>
              ) : null}
              {!immutable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setSkipTarget(item.jobId)}
                >
                  Skip
                </Button>
              ) : null}
              {job ? (
                <ExternalLink href={job.url} className="ml-1">
                  Open posting
                </ExternalLink>
              ) : null}
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={skipTarget !== null}
        title="Skip this job?"
        description={
          skipTarget
            ? `“${queue.jobsById.get(skipTarget)?.title ?? skipTarget}” will be marked skipped and removed from Needs you.`
            : undefined
        }
        confirmLabel="Skip job"
        tone="danger"
        onConfirm={() => {
          if (skipTarget) void skipJob(skipTarget);
        }}
        onCancel={() => setSkipTarget(null)}
      />
    </div>
  );
}
