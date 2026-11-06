import { useMemo, useState } from 'react';
import type { AnswerValue, QuestionDescriptor } from '@/core/contracts';
import type { NeedsRequest } from '@/ui/bridge';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Checkbox } from '@/ui/components/Checkbox';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { EmptyState } from '@/ui/components/EmptyState';
import { ErrorState } from '@/ui/components/ErrorState';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { Field } from '@/ui/components/Field';
import { IconDocument, IconNeeds, IconRefresh, IconStop } from '@/ui/components/icons';
import { Input } from '@/ui/components/Input';
import { JobDocumentChoices } from '@/ui/components/JobDocumentChoices';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { Select } from '@/ui/components/Select';
import { LoadingBlock } from '@/ui/components/Skeleton';
import { StaleDataNotice } from '@/ui/components/StaleDataNotice';
import { Textarea } from '@/ui/components/Textarea';
import {
  describeEngineAction,
  DOCUMENT_TYPE_COPY,
  friendlyErrorMessage,
  looksSensitive,
  pluralize,
  truncate,
} from '@/ui/components/ui-copy';
import { handshakeLinks } from '@/ui/components/links';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useNeeds } from '@/ui/hooks/useNeeds';
import { sendRequest } from '@/ui/bridge';

const REASON_COPY: Record<NeedsRequest['reason'], string> = {
  questions: 'Needs answers',
  documents: 'Check documents',
  auth: 'Session expired',
  challenge: 'Verification needed',
  ui_changed: 'Page changed',
  review: 'Ready to review',
};

function isEmptyValue(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function initialValue(question: QuestionDescriptor): AnswerValue {
  if (question.type === 'checkbox') {
    const existing = question.currentValue ?? question.suggestedAnswer;
    if (Array.isArray(existing)) return existing;
    if (typeof existing === 'boolean') return existing;
    return [];
  }
  const existing = question.currentValue ?? question.suggestedAnswer;
  if (existing === undefined || existing === null) return '';
  if (Array.isArray(existing)) return '';
  return existing;
}

interface QuestionInputProps {
  question: QuestionDescriptor;
  value: AnswerValue | undefined;
  error?: string;
  onChange: (value: AnswerValue) => void;
}

function QuestionInput({ question, value, error, onChange }: QuestionInputProps) {
  const options = question.options ?? [];
  const sensitive = looksSensitive(question.label);
  const hint =
    question.helpText ??
    (question.answerSource === 'bank'
      ? 'Prefilled from your answer bank — check it before saving.'
      : undefined);

  if (question.type === 'radio' && options.length > 0) {
    return (
      <div>
        <RadioGroup
          legend={question.label}
          name={`q-${question.id}`}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          options={options}
          hint={hint}
          error={error}
        />
      </div>
    );
  }

  if (question.type === 'select' || question.type === 'combobox') {
    return (
      <div>
        <Field label={question.label} hint={hint} error={error} required={question.required}>
          <Select
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="Choose an answer"
            options={options.map((option) => ({ value: option.value, label: option.label }))}
          />
        </Field>
        {sensitive ? (
          <Badge tone="warn" className="mt-1">
            Sensitive
          </Badge>
        ) : null}
      </div>
    );
  }

  if (question.type === 'checkbox') {
    if (options.length > 0) {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset aria-describedby={error ? `q-${question.id}-error` : undefined}>
          <legend className="mb-1 text-[12.5px] font-medium text-ink">
            {question.label}
            {question.required ? <span className="ml-0.5 text-danger">*</span> : null}
          </legend>
          <div className="space-y-1.5">
            {options.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                checked={selected.includes(option.value)}
                onChange={(checked) =>
                  onChange(
                    checked
                      ? [...selected, option.value]
                      : selected.filter((entry) => entry !== option.value),
                  )
                }
              />
            ))}
          </div>
          {hint ? <p className="mt-1 text-[11.5px] text-muted">{hint}</p> : null}
          {error ? (
            <p
              id={`q-${question.id}-error`}
              role="alert"
              className="mt-1 text-[11.5px] font-medium text-danger"
            >
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    }
    return (
      <Checkbox
        label={question.label}
        description={hint}
        checked={value === true}
        onChange={onChange}
        error={error}
      />
    );
  }

  if (question.type === 'textarea') {
    return (
      <Field label={question.label} hint={hint} error={error} required={question.required}>
        <Textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="Type your answer"
        />
      </Field>
    );
  }

  if (question.type === 'date') {
    return (
      <Field label={question.label} hint={hint} error={error} required={question.required}>
        <Input
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </Field>
    );
  }

  return (
    <Field
      label={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{question.label}</span>
          {sensitive ? <Badge tone="warn">Sensitive</Badge> : null}
        </span>
      }
      hint={hint}
      error={error}
      required={question.required}
    >
      <Input
        type={question.type === 'number' ? 'number' : 'text'}
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={question.type === 'unknown' ? 'Type your answer' : undefined}
      />
    </Field>
  );
}

export function NeedsYouScreen() {
  const app = useAppContext();
  const needs = useNeeds();
  const { refresh } = needs;
  const links = useMemo(() => handshakeLinks(app.settings?.host), [app.settings?.host]);
  const [edits, setEdits] = useState<Record<string, Record<string, AnswerValue>>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingJobId, setSavingJobId] = useState<string | null>(null);
  const [skipTarget, setSkipTarget] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

  /**
   * Values come from the user's edits, then the job's current/suggested answer.
   * Deriving this avoids copying server state into an effect.
   */
  const valueFor = (need: NeedsRequest, question: QuestionDescriptor): AnswerValue => {
    const entry = edits[need.jobId];
    if (entry && question.id in entry) {
      return entry[question.id] ?? '';
    }
    return initialValue(question);
  };

  const stopRun = async (): Promise<void> => {
    setStopping(true);
    const result = await app.stop();
    setStopping(false);
    if (!result) {
      app.notify('warn', 'The background did not report the run state. Refresh and try again.');
      return;
    }
    if (result.error) {
      app.notify('error', friendlyErrorMessage(result.error));
      return;
    }
    const notice = describeEngineAction(result.state, 'stop');
    app.notify(notice.level, notice.message);
  };

  const refreshNow = async (): Promise<void> => {
    const error = await refresh();
    if (error) app.notify('error', friendlyErrorMessage(error));
  };

  const focusRunner = async (jobId: string): Promise<void> => {
    setResolvingJobId(jobId);
    const result = await sendRequest({ type: 'ui.runner.focus' });
    setResolvingJobId(null);
    if (!result.ok) app.notify('error', friendlyErrorMessage(result.error));
    else if (!result.value.focused) {
      app.notify('warn', 'The runner tab is closed. Open the posting below to review it manually.');
    }
  };

  const resumeRun = async (jobId: string): Promise<void> => {
    setResolvingJobId(jobId);
    const result = await app.resume();
    setResolvingJobId(null);
    if (!result) app.notify('warn', 'The background did not respond. Refresh and try again.');
    else if (result.error) app.notify('error', friendlyErrorMessage(result.error));
    else {
      const notice = describeEngineAction(result.state, 'resume');
      app.notify(notice.level, notice.message);
      await refresh();
    }
  };

  const setAnswer = (jobId: string, questionId: string, value: AnswerValue): void => {
    setEdits((current) => ({
      ...current,
      [jobId]: { ...(current[jobId] ?? {}), [questionId]: value },
    }));
    setErrors((current) => {
      if (!(jobId in current)) return current;
      const next = { ...current };
      delete next[jobId];
      return next;
    });
  };

  const saveNeed = async (need: NeedsRequest): Promise<void> => {
    const values = Object.fromEntries(
      need.questions.map((question) => [question.id, valueFor(need, question)]),
    ) as Record<string, AnswerValue>;
    const missing = need.questions.find(
      (question) => question.required && isEmptyValue(values[question.id]),
    );
    if (missing) {
      setErrors((current) => ({
        ...current,
        [need.jobId]: `Answer “${truncate(missing.label, 60)}” before continuing.`,
      }));
      return;
    }

    setSavingJobId(need.jobId);
    for (const question of need.questions) {
      const value = values[question.id] ?? null;
      if (!question.required && isEmptyValue(value)) continue;
      const error = await needs.answer(
        need.jobId,
        question.id,
        value,
        remember[need.jobId] ?? false,
      );
      if (error) {
        setSavingJobId(null);
        setErrors((current) => ({ ...current, [need.jobId]: friendlyErrorMessage(error) }));
        app.notify('error', friendlyErrorMessage(error));
        return;
      }
    }
    setSavingJobId(null);
    app.notify('success', `Saved answers for ${need.jobTitle}.`);
  };

  const skipJob = async (jobId: string): Promise<void> => {
    setSkipTarget(null);
    const error = await needs.skip(jobId, 'Skipped from Needs you');
    if (error) app.notify('error', friendlyErrorMessage(error));
    else app.notify('success', 'Job skipped.');
  };

  /**
   * A `ui_changed` need belongs to a blocked row. Skipping is refused for final
   * statuses, so the only recovery is the same explicit retry the Queue offers.
   */
  const retryJob = async (jobId: string): Promise<void> => {
    setRetryingJobId(jobId);
    const result = await sendRequest({ type: 'ui.queue.retry', jobId });
    setRetryingJobId(null);
    if (!result.ok) app.notify('error', friendlyErrorMessage(result.error));
    else {
      app.notify('success', 'Queued to retry.');
      await refresh();
    }
  };

  const totalQuestions = useMemo(
    () => needs.needs.reduce((sum, need) => sum + need.questions.length, 0),
    [needs.needs],
  );

  if (needs.error && needs.needs.length === 0) {
    return (
      <ErrorState
        error={needs.error}
        title="Cannot load pending requests"
        onRetry={() => void needs.refresh()}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-muted">
          {needs.needs.length === 0
            ? 'Nothing pending.'
            : `${needs.needs.length} ${pluralize(needs.needs.length, 'job')} · ${totalQuestions} ${pluralize(totalQuestions, 'question')}`}
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<IconRefresh size={13} />}
            loading={needs.loading && needs.needs.length > 0}
            onClick={() => void refreshNow()}
          >
            Refresh
          </Button>
          {app.engine?.status === 'running' || app.engine?.status === 'needs_user' ? (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<IconStop size={12} />}
              loading={stopping}
              onClick={() => void stopRun()}
            >
              Stop run
            </Button>
          ) : null}
        </div>
      </div>

      {needs.error && needs.needs.length > 0 ? (
        <StaleDataNotice
          error={needs.error}
          context="Showing the last loaded requests"
          onRetry={() => void refreshNow()}
        />
      ) : null}

      {needs.loading && needs.needs.length === 0 ? (
        <LoadingBlock label="Loading pending requests" />
      ) : null}

      {!needs.loading && needs.needs.length === 0 ? (
        <EmptyState
          icon={<IconNeeds size={22} />}
          title="You’re all caught up"
          description="When a job needs an answer, a document, or your attention, it lands here. Sensitive answers need your explicit permission."
          action={
            <Button size="sm" variant="primary" onClick={() => app.navigate('queue')}>
              Go to queue
            </Button>
          }
        />
      ) : null}

      {needs.needs.map((need) => {
        const saving = savingJobId === need.jobId;
        const error = errors[need.jobId];
        const hasQuestions = need.questions.length > 0;
        const isReview = need.reason === 'review';
        const reasonLabel =
          !hasQuestions && need.missingDocumentTypes.length > 0
            ? 'Check documents'
            : REASON_COPY[need.reason];

        return (
          <Card key={need.jobId}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-[13px] font-semibold leading-snug text-ink">
                  {need.jobTitle}
                </p>
                <p className="mt-0.5 break-words text-[11.5px] text-muted">{need.employer}</p>
              </div>
              <Badge tone={isReview ? 'info' : need.reason === 'questions' ? 'warn' : 'danger'}>
                {reasonLabel}
              </Badge>
            </div>

            {isReview ? (
              <p className="mt-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[11.5px] leading-snug text-muted">
                {need.message ??
                  'The application is filled and waiting in the Handshook tab. Review the answers, then submit it there. Handshook will detect the confirmation and mark it applied.'}
              </p>
            ) : null}

            {isReview ? (
              <p className="mt-1 text-[11.5px] leading-snug text-muted">
                If you already submitted, or the tab was reloaded or closed, check My Jobs on
                Handshake first. If confirmation cannot be recovered, skip this job here to
                continue. Skipping does not withdraw an application or allow an automatic retry.
              </p>
            ) : null}

            {!isReview && !hasQuestions && need.missingDocumentTypes.length === 0 ? (
              <p className="mt-2 text-[11.5px] leading-snug text-muted">
                {need.message ??
                  (need.reason === 'auth'
                    ? 'Sign in to Handshake, then return here and resume the run.'
                    : need.reason === 'challenge'
                      ? 'Complete the verification in the runner tab, then resume the run.'
                      : need.reason === 'ui_changed'
                        ? 'Handshake changed its page. Retry here or from Queue; nothing is submitted.'
                        : 'Open the posting to check what needs your attention. You can also skip this job.')}
              </p>
            ) : null}

            {need.missingDocumentTypes.length > 0 ? (
              <div className="mt-2 rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2">
                <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-warn">
                  <IconDocument size={13} />
                  Check{' '}
                  {need.missingDocumentTypes
                    .map((type) => DOCUMENT_TYPE_COPY[type].toLowerCase())
                    .join(', ')}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-warn/90">
                  {need.message ??
                    'Paste the document’s link or ID below, or add it on Handshake first.'}
                </p>
                <ExternalLink href={links.documents} className="mt-1">
                  Open my Handshake documents
                </ExternalLink>
              </div>
            ) : null}

            {!isReview && (need.reason === 'documents' || need.missingDocumentTypes.length > 0) ? (
              <div className="mt-3">
                <JobDocumentChoices
                  jobId={need.jobId}
                  selection={need.documentSelection}
                  continueJob
                  onSaved={refresh}
                />
              </div>
            ) : null}

            {need.questions.length > 0 ? (
              <div className="mt-3 space-y-3">
                {need.questions.map((question) => (
                  <QuestionInput
                    key={question.id}
                    question={question}
                    value={valueFor(need, question)}
                    error={undefined}
                    onChange={(value) => setAnswer(need.jobId, question.id, value)}
                  />
                ))}
              </div>
            ) : null}

            {hasQuestions ? (
              <div className="mt-3 border-t border-line pt-2">
                <Checkbox
                  label="Remember these answers for next time"
                  description="Saved locally. Sensitive answers still need your opt-in before autopilot can submit them."
                  checked={remember[need.jobId] ?? false}
                  onChange={(checked) =>
                    setRemember((current) => ({ ...current, [need.jobId]: checked }))
                  }
                />
              </div>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="mt-2 break-words rounded-md bg-danger-soft px-2 py-1 text-[11.5px] font-medium text-danger"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-1.5">
              {isReview ? (
                <Button
                  size="sm"
                  variant="primary"
                  loading={resolvingJobId === need.jobId}
                  onClick={() => void focusRunner(need.jobId)}
                >
                  Open review tab
                </Button>
              ) : hasQuestions ? (
                <Button
                  size="sm"
                  variant="primary"
                  loading={saving}
                  onClick={() => void saveNeed(need)}
                >
                  {need.missingDocumentTypes.length > 0 ? 'Save answers' : 'Save & continue'}
                </Button>
              ) : need.reason === 'auth' || need.reason === 'challenge' ? (
                <>
                  {need.reason === 'auth' ? (
                    <ExternalLink href={links.home}>Sign in to Handshake</ExternalLink>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={resolvingJobId === need.jobId}
                      onClick={() => void focusRunner(need.jobId)}
                    >
                      Open runner tab
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    loading={resolvingJobId === need.jobId}
                    onClick={() => void resumeRun(need.jobId)}
                  >
                    Resume run
                  </Button>
                </>
              ) : need.reason === 'ui_changed' ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={retryingJobId === need.jobId}
                    onClick={() => void retryJob(need.jobId)}
                  >
                    Retry job
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => app.navigate('diagnostics')}>
                    Open diagnostics
                  </Button>
                </>
              ) : null}
              {need.reason === 'ui_changed' ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setSkipTarget(need.jobId)}
                >
                  Skip job
                </Button>
              )}
              <ExternalLink href={`${links.origin}/jobs/${encodeURIComponent(need.jobId)}`}>
                Open posting
              </ExternalLink>
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={skipTarget !== null}
        title="Skip this job?"
        description="The job is removed from Needs you and marked skipped. You can still find the posting in Handshake."
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
