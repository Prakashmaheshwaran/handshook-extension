import { useCallback, useMemo, useState } from 'react';
import type { Answer, AnswerValue, OnboardingState, RunMode, Settings } from '@/core/contracts';
import { now } from '@/core/util/time';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Progress } from '@/ui/components/Progress';
import { isHandshakeJobSearchUrl } from '@/ui/components/ui-copy';
import { sendRequest } from '@/ui/bridge';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useAnswers } from '@/ui/hooks/useAnswers';
import { useOnboarding } from '@/ui/hooks/useOnboarding';
import { AnswersStep } from './AnswersStep';
import { DocumentsStep } from './DocumentsStep';
import { ModeStep } from './ModeStep';
import { SearchStep } from './SearchStep';
import { SessionStep, type SessionUiStatus } from './SessionStep';
import { WelcomeStep } from './WelcomeStep';
import { defaultAnswers } from './defaults';

const STEPS = ['welcome', 'session', 'documents', 'answers', 'search', 'mode'] as const;

const STEP_INDEX: Record<OnboardingState['step'], number> = {
  welcome: 0,
  session: 1,
  documents: 2,
  answers: 3,
  search: 4,
  mode: 5,
  done: 5,
};

/** One settled read of the loaded runner page plus one reload can take ~30 s. */
const SESSION_CHECK_TIMEOUT_MS = 60_000;

interface SessionCheckView {
  status: 'unknown' | 'logged_in' | 'logged_out';
  checkedAt: number;
}

function emptyValue(value: AnswerValue): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export interface OnboardingScreenProps {
  settings: Settings;
  onDone: () => void;
  initialStep?: OnboardingState['step'];
  onCancel?: () => void;
}

export function OnboardingScreen({
  settings,
  onDone,
  initialStep,
  onCancel,
}: OnboardingScreenProps) {
  const app = useAppContext();
  const notify = app.notify;
  const onboarding = useOnboarding();
  const savedAnswers = useAnswers();

  const onboardingState = onboarding.onboarding;

  // Navigation and edits are local overrides; the persisted state is the
  // fallback, so resuming setup works without copying server state in effects.
  const [stepOverride, setStepOverride] = useState<number | null>(
    initialStep ? STEP_INDEX[initialStep] : null,
  );
  const [sessionCheck, setSessionCheck] = useState<SessionCheckView | null>(null);
  const [checking, setChecking] = useState(false);
  const [documentsDraft, setDocumentsDraft] = useState<Settings['documents']>(settings.documents);
  const [documentsValid, setDocumentsValid] = useState(true);
  const [answerEdits, setAnswerEdits] = useState<Record<string, Partial<Answer>>>({});
  const [searchNameEdit, setSearchNameEdit] = useState<string | null>(null);
  const [searchUrlEdit, setSearchUrlEdit] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<RunMode | null>(null);
  const [reviewBeforeSubmitOverride, setReviewBeforeSubmitOverride] = useState<boolean | null>(
    null,
  );
  const [allowOneClickApplyOverride, setAllowOneClickApplyOverride] = useState<boolean | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const index = stepOverride ?? (onboardingState ? STEP_INDEX[onboardingState.step] : 0);
  const step = STEPS[index] ?? 'welcome';
  const persistedSessionStatus = onboardingState?.sessionStatus;
  // A finished check outranks the saved status: `unknown` from a check is
  // "couldn't verify", which is a different state from "never checked".
  const sessionStatus: SessionUiStatus = sessionCheck
    ? sessionCheck.status === 'unknown'
      ? 'not_verified'
      : sessionCheck.status
    : persistedSessionStatus === 'logged_in' || persistedSessionStatus === 'logged_out'
      ? persistedSessionStatus
      : 'unchecked';

  const activeSearch =
    settings.search.savedSearches.find((search) => search.id === settings.search.activeSearchId) ??
    settings.search.savedSearches[0];
  const searchName = searchNameEdit ?? activeSearch?.name ?? '';
  const searchUrl = searchUrlEdit ?? activeSearch?.url ?? '';
  const mode: RunMode = modeOverride ?? settings.mode;
  // Full automation is the product default: the wizard starts on Autopilot and
  // the review step is offered as an opt-out. Whatever is shown is saved explicitly.
  const reviewBeforeSubmit = reviewBeforeSubmitOverride ?? settings.safety.reviewBeforeSubmit;
  const allowOneClickApply = allowOneClickApplyOverride ?? settings.safety.allowOneClickApply;

  const answers = useMemo(() => {
    return defaultAnswers().map((answer) => {
      const saved = savedAnswers.answers.find((entry) => entry.id === answer.id);
      const edit = answerEdits[answer.id];
      return {
        ...answer,
        ...saved,
        ...(edit ?? {}),
      };
    });
  }, [answerEdits, savedAnswers.answers]);

  const setAnswer = (answerId: string, patch: Partial<Answer>): void => {
    setAnswerEdits((current) => ({
      ...current,
      [answerId]: { ...(current[answerId] ?? {}), ...patch },
    }));
  };

  const checkSession = useCallback(async (): Promise<void> => {
    setChecking(true);
    const result = await sendRequest(
      { type: 'ui.session.check' },
      { timeoutMs: SESSION_CHECK_TIMEOUT_MS },
    );
    setChecking(false);
    if (!result.ok) {
      // A check that could not run says nothing about the session. Report it
      // as "couldn't verify" instead of leaving the pre-check label in place.
      setSessionCheck({ status: 'unknown', checkedAt: now() });
      notify('error', result.error.message);
      return;
    }
    // Older workers may omit `checkedAt`; fall back to the moment the UI saw it.
    const checkedAt = Number.isFinite(result.value.checkedAt) ? result.value.checkedAt : now();
    setSessionCheck({ status: result.value.status, checkedAt });
    await onboarding.update({ sessionStatus: result.value.status, host: result.value.host });
  }, [notify, onboarding]);

  const advance = (next: OnboardingState['step']): void => {
    setError(null);
    void onboarding.update({ step: next });
  };

  const goTo = (next: number): void => {
    setError(null);
    setStepOverride(next);
  };

  const finishSetup = async (): Promise<void> => {
    setSaving(true);
    const completeError = await onboarding.complete({
      mode,
      reviewBeforeSubmit,
      allowOneClickApply,
    });
    if (completeError) {
      setSaving(false);
      setError(completeError.message);
      return;
    }
    const refreshError = await app.refreshSettings();
    setSaving(false);
    if (refreshError) {
      setError(refreshError.message);
      return;
    }
    notify('success', 'Setup complete. Nothing runs until you press Start.');
    onDone();
  };

  const next = async (): Promise<void> => {
    setError(null);

    if (step === 'welcome') {
      advance('session');
      goTo(1);
      return;
    }

    if (step === 'session') {
      advance('documents');
      goTo(2);
      return;
    }

    setSaving(true);

    if (step === 'documents') {
      if (!documentsValid) {
        setSaving(false);
        setError('Fix the highlighted document link or ID before continuing.');
        return;
      }
      const saveError = await app.saveSettings({ documents: documentsDraft });
      if (saveError) {
        setSaving(false);
        setError(saveError.message);
        return;
      }
      advance('answers');
      setSaving(false);
      goTo(3);
      return;
    }

    if (step === 'answers') {
      for (const answer of answers) {
        if (emptyValue(answer.value)) continue;
        const saveError = await savedAnswers.save({ ...answer, updatedAt: now() });
        if (saveError) {
          setSaving(false);
          setError(saveError.message);
          return;
        }
      }
      advance('search');
      await onboarding.update({ answersConfigured: true });
      setSaving(false);
      goTo(4);
      return;
    }

    if (step === 'search') {
      const name = searchName.trim();
      const url = searchUrl.trim();
      if (!name) {
        setSaving(false);
        setError('Give the saved search a name.');
        return;
      }
      if (!isHandshakeJobSearchUrl(url)) {
        setSaving(false);
        setError(
          'Paste a Handshake job search URL, for example https://app.joinhandshake.com/job-search. Links to a single job are not accepted.',
        );
        return;
      }
      const existing = activeSearch;
      const timestamp = now();
      const savedSearch = {
        id: existing?.id ?? crypto.randomUUID(),
        name,
        url,
        enabled: true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const others = settings.search.savedSearches.filter((search) => search.id !== savedSearch.id);
      const saveError = await app.saveSettings({
        search: { savedSearches: [...others, savedSearch], activeSearchId: savedSearch.id },
      });
      if (saveError) {
        setSaving(false);
        setError(saveError.message);
        return;
      }
      advance('mode');
      await onboarding.update({ searchConfigured: true });
      setSaving(false);
      goTo(5);
      return;
    }

    await finishSetup();
  };

  const back = (): void => {
    const nextIndex = Math.max(0, index - 1);
    const nextStep = STEPS[nextIndex] ?? 'welcome';
    setError(null);
    setStepOverride(nextIndex);
    // Persist the step so closing and reopening resumes here, not later.
    void onboarding.update({ step: nextStep });
  };

  const filledAnswers = answers.filter((answer) => !emptyValue(answer.value)).length;
  const sensitiveAutoCount = answers.filter(
    (answer) => answer.sensitive && answer.autoSubmitAllowed,
  ).length;
  const documentsChosen = [
    documentsDraft.defaultResumeId,
    documentsDraft.coverLetterId,
    documentsDraft.transcriptId,
    documentsDraft.otherDocumentId,
  ].filter(Boolean).length;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[520px] flex-col px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">
          Handshook setup
        </p>
        <p className="hs-numeric text-[11px] text-muted">
          Step {index + 1} of {STEPS.length}
        </p>
      </div>
      <Progress
        className="mt-1.5"
        value={index + 1}
        max={STEPS.length}
        label={`Setup step ${index + 1} of ${STEPS.length}`}
      />
      {onCancel ? (
        <div className="mt-2">
          <p className="text-[11.5px] leading-snug text-muted">
            Your saved choices are prefilled. Queue and history are kept; each Continue saves that
            step.
          </p>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Exit setup
          </Button>
        </div>
      ) : null}

      <div className="mt-4 flex-1">
        {step === 'welcome' ? <WelcomeStep /> : null}
        {step === 'session' ? (
          <SessionStep
            status={sessionStatus}
            host={settings.host}
            checking={checking}
            checkedAt={sessionCheck?.checkedAt}
            onCheck={() => void checkSession()}
          />
        ) : null}
        {step === 'documents' ? (
          <DocumentsStep
            host={settings.host}
            aiEnabled={settings.ai.enabled}
            value={documentsDraft}
            onChange={(patch) => setDocumentsDraft((current) => ({ ...current, ...patch }))}
            onValidityChange={setDocumentsValid}
          />
        ) : null}
        {step === 'answers' ? <AnswersStep answers={answers} onChange={setAnswer} /> : null}
        {step === 'search' ? (
          <SearchStep
            host={settings.host}
            name={searchName}
            url={searchUrl}
            onName={setSearchNameEdit}
            onUrl={setSearchUrlEdit}
            error={null}
          />
        ) : null}
        {step === 'mode' ? (
          <ModeStep
            mode={mode}
            onMode={setModeOverride}
            documentsChosen={documentsChosen}
            answersFilled={filledAnswers}
            searchReady={isHandshakeJobSearchUrl(searchUrl.trim())}
            sensitiveAutoCount={sensitiveAutoCount}
            reviewBeforeSubmit={reviewBeforeSubmit}
            onReviewBeforeSubmit={setReviewBeforeSubmitOverride}
            allowOneClickApply={allowOneClickApply}
            onAllowOneClickApply={setAllowOneClickApplyOverride}
          />
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md bg-danger-soft px-2 py-1.5 text-[11.5px] font-medium leading-snug text-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-3 mt-4 flex items-center gap-2 border-t border-line bg-bg/95 px-3 py-2 backdrop-blur">
        {index > 0 ? (
          <Button variant="ghost" size="md" onClick={back} disabled={saving}>
            Back
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="md"
          block
          loading={saving}
          disabled={checking || (step === 'documents' && !documentsValid)}
          loadingLabel="Saving setup"
          onClick={() => void next()}
        >
          {index === STEPS.length - 1 ? 'Finish setup' : 'Continue'}
        </Button>
      </div>

      <p className="mt-1 text-center text-[10px] text-muted">
        <Badge tone="neutral">Local-only</Badge>{' '}
        <span className="align-middle">No account, no password, no telemetry.</span>
      </p>
    </div>
  );
}
