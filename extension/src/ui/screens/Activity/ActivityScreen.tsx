import { useEffect, useMemo, useState } from 'react';
import { isBroadcast, subscribeToBroadcasts } from '@/ui/bridge';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Checkbox } from '@/ui/components/Checkbox';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { downloadTextFile } from '@/ui/components/download';
import { EmptyState } from '@/ui/components/EmptyState';
import { ErrorState } from '@/ui/components/ErrorState';
import { Field } from '@/ui/components/Field';
import { IconActivity, IconDownload, IconRefresh, IconTrash } from '@/ui/components/icons';
import { Select } from '@/ui/components/Select';
import { LoadingBlock } from '@/ui/components/Skeleton';
import { StaleDataNotice } from '@/ui/components/StaleDataNotice';
import {
  EVENT_LEVEL_TONE,
  formatTime,
  friendlyErrorMessage,
  pluralize,
} from '@/ui/components/ui-copy';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useEvents } from '@/ui/hooks/useEvents';
import { useQueue } from '@/ui/hooks/useQueue';
import { isExternalJob, isInternalApplication } from '@/core/util/application-policy';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

export function ActivityScreen() {
  const app = useAppContext();
  const events = useEvents();
  const queue = useQueue();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [jobFilter, setJobFilter] = useState<string>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { refresh } = events;
  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        // A late external classification also removes earlier in-flight progress noise.
        if (isBroadcast(message) && message.type === 'queue.changed') void refresh();
      }),
    [refresh],
  );
  const activity = useMemo(
    () =>
      events.events.filter((event) => {
        if (event.type === 'job.external') return false;
        const job = event.jobId ? queue.jobsById.get(event.jobId) : undefined;
        if (
          isExternalJob(
            job,
            queue.items.find((item) => item.jobId === event.jobId),
          )
        )
          return false;
        return !(event.type === 'job.applied' && job && !isInternalApplication(job.applyType));
      }),
    [events.events, queue.items, queue.jobsById],
  );

  const jobOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const event of activity) {
      if (event.jobId) ids.add(event.jobId);
    }
    return [
      { value: 'all', label: 'All jobs' },
      ...Array.from(ids).map((id) => ({
        value: id,
        label: queue.jobsById.get(id)?.title ?? `Job ${id}`,
      })),
    ];
  }, [activity, queue.jobsById]);

  const visible = useMemo(
    () =>
      activity.filter((event) => {
        if (level !== 'all' && event.level !== level) return false;
        if (jobFilter !== 'all' && event.jobId !== jobFilter) return false;
        return true;
      }),
    [activity, jobFilter, level],
  );

  const exportLog = async (): Promise<void> => {
    setExporting(true);
    const { payload, error } = await events.exportBundle();
    setExporting(false);
    if (error || !payload) {
      app.notify('error', error ? friendlyErrorMessage(error) : 'Export failed.');
      return;
    }
    downloadTextFile(payload.filename, payload.json);
    app.notify('success', 'Diagnostics bundle downloaded.');
  };

  const refreshNow = async (): Promise<void> => {
    const error = await events.refresh();
    if (error) app.notify('error', friendlyErrorMessage(error));
  };

  const clearLog = async (): Promise<void> => {
    setClearing(true);
    const error = await events.clear();
    setClearing(false);
    setConfirmClear(false);
    if (error) app.notify('error', friendlyErrorMessage(error));
    else app.notify('success', 'Activity cleared.');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          iconLeft={<IconDownload size={13} />}
          loading={exporting}
          onClick={() => void exportLog()}
        >
          Export shareable diagnostics
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconTrash size={13} />}
          disabled={events.events.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconRefresh size={13} />}
          loading={events.loading && events.events.length > 0}
          onClick={() => void refreshNow()}
        >
          Refresh
        </Button>
      </div>
      <p className="text-[10.5px] leading-snug text-muted">
        Status codes, settings flags, counters and selector keys only — personal text is removed.
      </p>

      {events.error && events.events.length > 0 ? (
        <StaleDataNotice
          error={events.error}
          context="Showing the last loaded activity"
          onRetry={() => void refreshNow()}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Filter by level" hideLabel>
          <Select
            compact
            value={level}
            onChange={(event) => setLevel(event.currentTarget.value as LevelFilter)}
            options={[
              { value: 'all', label: 'All levels' },
              { value: 'info', label: 'Info' },
              { value: 'warn', label: 'Warnings' },
              { value: 'error', label: 'Errors' },
            ]}
          />
        </Field>
        <Field label="Filter by job" hideLabel>
          <Select
            compact
            value={jobFilter}
            onChange={(event) => setJobFilter(event.currentTarget.value)}
            options={jobOptions}
          />
        </Field>
      </div>

      <Checkbox
        label="Live updates"
        description="New events appear at the top. Turn this off while you read."
        checked={events.live}
        onChange={events.setLive}
      />

      {events.error && events.events.length === 0 ? (
        <ErrorState
          error={events.error}
          title="Cannot load activity"
          onRetry={() => void events.refresh()}
        />
      ) : null}

      {events.loading && events.events.length === 0 ? (
        <LoadingBlock label="Loading activity" />
      ) : null}

      {!events.loading && events.events.length === 0 ? (
        <EmptyState
          icon={<IconActivity size={22} />}
          title="No activity yet"
          description="Start a run and Handshook records each scan, discovery, application, and pause here."
          action={
            <Button size="sm" variant="primary" onClick={() => app.navigate('dashboard')}>
              Go to dashboard
            </Button>
          }
        />
      ) : null}

      {visible.length > 0 ? (
        <Card padded={false}>
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <p className="hs-numeric text-[11px] text-muted">
              {visible.length} {pluralize(visible.length, 'event')} · newest first
            </p>
            {!events.live ? (
              <Badge tone="warn">Live paused</Badge>
            ) : (
              <Badge tone="accent">Live</Badge>
            )}
          </div>
          <ul className="divide-y divide-line px-3">
            {visible.map((event) => {
              const job = event.jobId ? queue.jobsById.get(event.jobId) : undefined;
              return (
                <li key={event.id} className="flex gap-2 py-2">
                  <span className="hs-numeric w-10 shrink-0 pt-0.5 text-right text-[10.5px] text-muted">
                    {formatTime(event.at)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={EVENT_LEVEL_TONE[event.level]}>{event.level}</Badge>
                      <span className="min-w-0 truncate font-mono text-[10px] text-muted">
                        {event.type}
                      </span>
                    </div>
                    <p className="mt-0.5 break-words text-[12px] leading-snug text-ink">
                      {event.message}
                    </p>
                    {job || event.jobId ? (
                      <p className="mt-0.5 truncate text-[10.5px] text-muted">
                        {job ? `${job.title} · ${job.employer}` : `Job ${event.jobId}`}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {events.events.length > 0 && visible.length === 0 ? (
        <EmptyState
          title="No events match these filters"
          description="Switch the level or job filter back to “All” to see everything."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setLevel('all');
                setJobFilter('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Clear activity?"
        description={`This deletes ${events.events.length} local ${pluralize(events.events.length, 'event')}. Export first if you may need them for a bug report.`}
        confirmLabel="Clear activity"
        tone="danger"
        loading={clearing}
        onConfirm={() => void clearLog()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
