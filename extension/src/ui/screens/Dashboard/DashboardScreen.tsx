import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ErrorState } from '@/ui/components/ErrorState';
import { ExternalLink } from '@/ui/components/ExternalLink';
import {
  IconClock,
  IconNeeds,
  IconPause,
  IconPlay,
  IconRefresh,
  IconShield,
  IconStop,
} from '@/ui/components/icons';
import { Progress } from '@/ui/components/Progress';
import { Stat } from '@/ui/components/Stat';
import { LoadingBlock } from '@/ui/components/Skeleton';
import { EngineStatusBadge } from '@/ui/components/StatusBadge';
import {
  APPLY_TYPE_COPY,
  describeEngineAction,
  formatPercent,
  formatWhen,
  friendlyErrorMessage,
  PAUSE_REASON_COPY,
  pluralize,
} from '@/ui/components/ui-copy';
import { handshakeLinks } from '@/ui/components/links';
import { sendRequest } from '@/ui/bridge';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useQueue } from '@/ui/hooks/useQueue';
import { isExternalJob } from '@/core/util/application-policy';
import { useAiStatus } from '@/ui/hooks/useAiStatus';
import type { EngineActionResult } from '@/ui/hooks/useEngineState';
import { displayedRunMode } from './RunModeNotice';
import { SetupChecklist } from './SetupChecklist';
import { ReviewReadyCard } from './ReviewReadyCard';

function modeLabel(mode: 'review' | 'autopilot' | 'dry_run' | undefined): string {
  if (mode === 'autopilot') return 'Autopilot';
  if (mode === 'dry_run') return 'Dry run';
  return 'Review mode';
}

export function DashboardScreen() {
  const app = useAppContext();
  const queue = useQueue();
  const ai = useAiStatus();
  const [focusing, setFocusing] = useState(false);
  const { engine, settings, enginePending, notify } = app;
  const links = useMemo(() => handshakeLinks(settings?.host), [settings?.host]);

  const act = useCallback(
    async (
      action: 'start' | 'pause' | 'resume' | 'stop',
      run: () => Promise<EngineActionResult | null>,
    ) => {
      const result = await run();
      if (!result) {
        notify('warn', 'The background did not report the run state. Refresh and try again.');
        return;
      }
      if (result.error) {
        notify('error', friendlyErrorMessage(result.error));
        return;
      }
      const notice = describeEngineAction(result.state, action);
      notify(notice.level, notice.message);
    },
    [notify],
  );

  const focusRunner = useCallback(async () => {
    setFocusing(true);
    const result = await sendRequest({ type: 'ui.runner.focus' });
    setFocusing(false);
    if (!result.ok) {
      notify('error', result.error.message);
      return;
    }
    if (!result.value.focused) {
      notify('info', 'No Handshake tab is open yet. Start a run or open Handshake first.');
    }
  }, [notify]);

  if (engine === null && app.engineLoading) {
    return <LoadingBlock label="Reading engine state" />;
  }
  if (engine === null && app.engineError) {
    return (
      <ErrorState
        error={app.engineError}
        title="Cannot reach the engine"
        onRetry={() => void app.refreshEngine()}
      />
    );
  }

  const today = engine?.todayCount ?? 0;
  const cap = engine?.dailyCap ?? settings?.pacing.dailyCap ?? 0;
  const remaining = Math.max(0, cap - today);
  const capReached = cap > 0 && today >= cap;
  const counts = queue.summary?.counts ?? {};
  const needsCount = Math.max(queue.needs.length, counts.needs_input ?? 0);
  const internalItems = queue.items.filter(
    (item) => !isExternalJob(queue.jobsById.get(item.jobId), item),
  );
  const candidate = engine?.currentJobId ? queue.jobsById.get(engine.currentJobId) : undefined;
  const currentJob = isExternalJob(
    candidate,
    queue.items.find((item) => item.jobId === engine?.currentJobId),
  )
    ? undefined
    : candidate;
  const lastError = engine?.lastError;
  const nextWaiting = internalItems
    .filter((item) => item.status === 'waiting' && typeof item.nextAttemptAt === 'number')
    .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))[0];

  const running = engine?.status === 'running' || engine?.status === 'scanning';
  const paused =
    engine?.status === 'paused' || engine?.status === 'needs_user' || engine?.status === 'error';
  const startMode = settings?.mode ?? engine?.mode ?? 'review';
  const currentMode = displayedRunMode(settings, engine);
  const startLabel =
    startMode === 'autopilot'
      ? 'Start applying'
      : startMode === 'dry_run'
        ? 'Start dry run (no submissions)'
        : 'Start review run';
  const authRequired = engine?.pauseReason === 'auth_required';
  const uiChanged = engine?.pauseReason === 'ui_changed';
  const statusLine =
    engine?.status === 'paused' && engine.pauseReason === 'user' && !engine.lastError
      ? 'Paused by you. Resume when ready.'
      : (engine?.message ??
        (engine === null
          ? 'Waiting for the extension background.'
          : engine.status === 'running'
            ? 'Working through the queue. Stop is always available.'
            : engine.status === 'idle'
              ? 'Nothing is running. Nothing will run until you press Start.'
              : 'Paused. Check what it needs, then resume.'));

  let nextAction: ReactNode =
    currentMode === 'dry_run'
      ? 'Press Start to preview your saved search. Nothing will be submitted.'
      : currentMode === 'autopilot'
        ? 'Press Start to scan your saved search and apply for you.'
        : 'Press Start to scan your saved search and fill the first application for review.';
  if (needsCount > 0) {
    nextAction = `Review ${needsCount} pending ${pluralize(needsCount, 'request')} in Needs you.`;
  } else if (authRequired) {
    nextAction = 'Log in to Handshake, then press Resume.';
  } else if (capReached) {
    nextAction = 'Today’s cap is reached, so the run finished. Start again after local midnight.';
  } else if (engine?.status === 'running') {
    nextAction =
      engine.mode === 'dry_run'
        ? 'Dry run is previewing the queue. Nothing will be submitted.'
        : engine.mode === 'autopilot'
          ? 'Autopilot is running inside your caps. Pause or stop at any time.'
          : 'Handshook is filling forms. Each submit waits for your review.';
  } else if (engine?.status === 'paused' && engine.pauseReason) {
    nextAction = PAUSE_REASON_COPY[engine.pauseReason];
  }

  const warnings: {
    key: string;
    tone: 'warn' | 'danger';
    title: string;
    body: string;
    action?: ReactNode;
  }[] = [];
  if (ai.status?.geminiReplacedNotice) {
    warnings.push({
      key: 'ai-migration',
      tone: 'warn',
      title: 'Cloud matching setup changed',
      body: 'Add an OpenRouter key in AI settings to keep using cloud matching. Until then, Handshook uses on-device or basic matching.',
      action: (
        <Button size="sm" variant="secondary" onClick={() => app.navigate('settings')}>
          Set up OpenRouter
        </Button>
      ),
    });
  }
  if (ai.status?.openRouterMessage) {
    warnings.push({
      key: 'ai-status',
      tone: 'warn',
      title: 'AI matching status',
      body: ai.status.openRouterMessage,
    });
  }
  if (authRequired) {
    warnings.push({
      key: 'auth',
      tone: 'warn',
      title: 'Handshake session expired',
      body: 'Handshook uses your existing browser session. It never asks for a password and cannot log in for you.',
      action: <ExternalLink href={links.home}>Log in to Handshake</ExternalLink>,
    });
  }
  if (capReached) {
    warnings.push({
      key: 'cap',
      tone: 'warn',
      title: 'Daily cap reached',
      body: `${today} of ${cap} applications used today. You can raise the cap in Settings, but a slower pace is safer.`,
    });
  }
  if (uiChanged) {
    warnings.push({
      key: 'ui',
      tone: 'danger',
      title: 'Handshake’s page changed',
      body: 'A selector stopped matching, so the run paused instead of guessing. Diagnostics shows what failed.',
      action: (
        <Button size="sm" variant="secondary" onClick={() => app.navigate('diagnostics')}>
          Open diagnostics
        </Button>
      ),
    });
  }
  if (lastError && lastError.code !== 'AUTH_REQUIRED') {
    warnings.push({
      key: 'error',
      tone: 'danger',
      title: 'Last error',
      body: friendlyErrorMessage(lastError),
      action: (
        <Button size="sm" variant="secondary" onClick={() => app.navigate('activity')}>
          See activity
        </Button>
      ),
    });
  }

  return (
    <div className="space-y-3">
      <SetupChecklist />
      <ReviewReadyCard />
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {engine ? (
                <EngineStatusBadge status={engine.status} />
              ) : (
                <Badge tone="neutral">Connecting</Badge>
              )}
              <Badge tone={currentMode === 'autopilot' ? 'accent' : 'neutral'}>
                {modeLabel(currentMode)}
              </Badge>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{statusLine}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void app.refreshEngine()}
            iconLeft={<IconRefresh size={13} />}
            loading={app.engineLoading && engine !== null}
          >
            Refresh
          </Button>
        </div>

        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-muted">
            <span>Applications today</span>
            <span className="hs-numeric">
              {today} / {cap}
            </span>
          </div>
          <Progress
            className="mt-1"
            value={today}
            max={cap}
            tone={capReached ? 'danger' : 'accent'}
            label="Applications today versus the daily cap"
          />
          <p className="mt-1 text-[11px] text-muted">
            {remaining > 0
              ? `${remaining} left today. Pacing delays are deliberate.`
              : 'No applications left today. The cap resets at local midnight.'}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {!running && !paused ? (
            <Button
              variant="primary"
              size="sm"
              iconLeft={<IconPlay size={13} />}
              loading={enginePending === 'start'}
              disabled={app.bridgeMode === 'unavailable'}
              onClick={() => void act('start', () => app.start(startMode))}
            >
              {startLabel}
            </Button>
          ) : null}
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<IconPause size={13} />}
              loading={enginePending === 'pause'}
              onClick={() => void act('pause', () => app.pause())}
            >
              Pause
            </Button>
          ) : null}
          {paused ? (
            <Button
              variant="primary"
              size="sm"
              iconLeft={<IconPlay size={13} />}
              loading={enginePending === 'resume'}
              onClick={() => void act('resume', () => app.resume())}
            >
              Resume
            </Button>
          ) : null}
          {running || paused ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<IconStop size={12} />}
              loading={enginePending === 'stop'}
              onClick={() => void act('stop', () => app.stop())}
            >
              Stop
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<IconShield size={13} />}
            loading={focusing}
            onClick={() => void focusRunner()}
          >
            Show runner tab
          </Button>
        </div>
      </Card>

      <Card tone={needsCount > 0 ? 'accent' : 'muted'}>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-accent">
            {needsCount > 0 ? <IconNeeds size={15} /> : <IconClock size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted">
              Next action
            </p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-ink">{nextAction}</p>
            {nextWaiting?.nextAttemptAt ? (
              <p className="mt-1 text-[11px] text-muted">
                Next scheduled attempt {formatWhen(nextWaiting.nextAttemptAt)}.
              </p>
            ) : null}
            {needsCount > 0 ? (
              <Button
                size="sm"
                variant="primary"
                className="mt-2"
                onClick={() => app.navigate('needs')}
              >
                Open Needs you
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      {currentJob ? (
        <Card>
          <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted">
            {engine?.currentPhase ?? 'Current job'}
          </p>
          <p className="mt-0.5 break-words text-[13px] font-semibold text-ink">
            {currentJob.title}
          </p>
          <p className="mt-0.5 break-words text-[11.5px] text-muted">
            {currentJob.employer}
            {currentJob.location ? ` · ${currentJob.location}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{APPLY_TYPE_COPY[currentJob.applyType]}</Badge>
            {typeof currentJob.fitScore === 'number' ? (
              <Badge tone="info">Fit {formatPercent(currentJob.fitScore)}</Badge>
            ) : null}
            {currentJob.remote ? <Badge tone="neutral">Remote</Badge> : null}
          </div>
        </Card>
      ) : null}

      {warnings.slice(0, 3).map((warning) => (
        <Card key={warning.key} tone={warning.tone}>
          <p className="text-[12.5px] font-semibold text-ink">{warning.title}</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{warning.body}</p>
          {warning.action ? <div className="mt-2">{warning.action}</div> : null}
        </Card>
      ))}

      <Card>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Applied today" value={today} hint={`of ${cap} allowed`} />
          <Stat
            label="Ready to review"
            value={counts.ready_for_review ?? 0}
            hint="waiting for your OK"
          />
          <Stat
            label="Needs you"
            value={needsCount}
            tone={needsCount > 0 ? 'warn' : 'default'}
            hint={
              needsCount > 0
                ? queue.needs.some((need) => need.reason === 'review')
                  ? 'ready to review'
                  : 'questions or documents'
                : 'nothing pending'
            }
          />
          <Stat
            label="In queue"
            value={queue.summary?.total ?? internalItems.length}
            hint="all statuses"
          />
        </div>
      </Card>

      <Card tone="muted">
        <p className="text-[11.5px] leading-relaxed text-muted">
          {currentMode === 'dry_run'
            ? 'Dry run previews applications; nothing will be submitted.'
            : currentMode === 'autopilot'
              ? settings?.safety.reviewBeforeSubmit
                ? 'Handshook applies for you, but you turned on Review each application: it fills each application and stops for your approval. Manage this in Settings → Run mode and safety.'
                : 'Handshook applies for you and submits applications that meet every gate: fit score, known answers, documents, active session, and your caps. Anything else comes back to you.'
              : 'You chose to review every application. Handshook never clicks Submit for you; open each ready job on Handshake to submit it yourself.'}{' '}
          <ExternalLink href={links.home} className="align-baseline">
            Open Handshake
          </ExternalLink>
        </p>
      </Card>
    </div>
  );
}
