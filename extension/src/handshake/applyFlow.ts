import { humanDelay } from './human-delay';
import {
  appError,
  type ApplyOptions,
  type ApplyResult,
  type AppError,
  type Answer,
  type AnswerMatch,
  type DocumentType,
  type DocumentsUsed,
  type Job,
  type QuestionDescriptor,
} from '@/core/contracts';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { aiMayWrite, answerApprovalReason } from '@/core/answers/policy';
import { evaluateAnswerGate } from '@/core/orchestrator/guards';
import { ONE_CLICK_APPLY_REVIEW_REASON } from '@/core/documents/selection';
import {
  CancelledError,
  clickElement,
  getAccessibleName,
  isDisabledElement,
  isVisible,
  throwIfAborted,
  waitFor,
  WaitTimeoutError,
} from '@/handshake/dom';
import { extractQuestions, fillQuestions } from '@/handshake/questions';
import { matchAllAnswers, matchChosenAnswer, type MatchOptions } from '@/handshake/answerMatcher';
import {
  ANSWER_ASSIST_MAX_OPTIONS,
  ANSWER_ASSIST_MAX_QUESTIONS,
  ANSWER_ASSIST_OPTION_MAX,
  ANSWER_ASSIST_TEXT_MAX,
  type AnswerAssistQuestion,
} from '@/core/contracts/answerAssist';
import { assistLocate } from '@/handshake/page-assist';
import {
  formDeclaresNoDocuments,
  selectConfiguredDocuments,
  selectRequiredDocuments,
  verifyQuickApplyDocuments,
  verifySelectedDocuments,
} from '@/handshake/documents';
import { detectJobPageState } from '@/handshake/jobDetails';
import {
  detectAlreadyApplied,
  confirmationBaseline,
  detectConfirmation,
  detectValidationErrors,
  findApplyButton,
  findSubmitButton,
  isApplicationModalOpen,
  missingDocumentTypesInErrors,
  recordJobActionOutline,
  waitForJobPageReady,
} from '@/handshake/verification';

function visibleDialog(doc: Document): HTMLElement | null {
  const dialogs = Array.from(
    doc.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]'),
  );
  return dialogs.find((dialog) => isVisible(dialog)) ?? null;
}

function pageStateResult(
  state: NonNullable<ReturnType<typeof detectJobPageState>>,
): ApplyResult | null {
  switch (state) {
    case 'login':
      return {
        jobId: '',
        outcome: 'failed',
        error: appError('AUTH_REQUIRED', 'Sign in to Handshake to continue'),
      };
    case 'challenge':
      return {
        jobId: '',
        outcome: 'failed',
        error: appError('CHALLENGE', 'Complete the verification challenge in the Handshook tab'),
      };
    case 'applied':
      return { jobId: '', outcome: 'already_applied' };
    case 'closed':
      return { jobId: '', outcome: 'failed', error: appError('JOB_CLOSED', 'This job is closed') };
    case 'not_open':
      return {
        jobId: '',
        outcome: 'waiting',
        error: appError('NOT_OPEN', 'Applications are not open yet'),
      };
  }
}

/**
 * Classify a site error message. Rate limits and permission failures both stop
 * the run (the caller pauses) instead of being retried in a loop.
 */
function errorCodeFor(text: string): 'RATE_LIMITED' | 'FORBIDDEN' | 'UNKNOWN' {
  if (/too many requests|rate limit|try again later/i.test(text)) return 'RATE_LIMITED';
  if (
    /do not have permission|permission to apply|access denied|not allowed to apply|forbidden/i.test(
      text,
    )
  ) {
    return 'FORBIDDEN';
  }
  return 'UNKNOWN';
}

/**
 * Map a site error message to a typed failure. Rate limits are retryable;
 * permission failures are FORBIDDEN so the caller pauses instead of retrying.
 */
export function classifySubmitFailure(errors: readonly string[]): AppError {
  const text = errors.join(' ');
  const code = errorCodeFor(text);
  return appError(code, errors[0] ?? 'Application failed', {
    retryable: code === 'RATE_LIMITED',
  });
}

/**
 * Apply the caller's wait budget. `ApplyOptions.timeoutMs` is the whole apply
 * operation's budget; each internal wait is capped by it so a slow confirmation
 * can never outlive the content request that owns this job.
 */
function waitBudget(options: ApplyOptions, defaultMs: number): number {
  return Math.max(1_000, Math.min(defaultMs, options.timeoutMs));
}

/** The form's own question text and choices, or null when it cannot be described. */
function describeForAnswerAssist(question: QuestionDescriptor): AnswerAssistQuestion | null {
  const label = question.label.trim().slice(0, ANSWER_ASSIST_TEXT_MAX);
  if (!label || question.type === 'unknown') return null;
  const options = question.options ?? [];
  if (
    options.length > ANSWER_ASSIST_MAX_OPTIONS ||
    options.some((option) => option.value.length > ANSWER_ASSIST_OPTION_MAX)
  )
    return null;
  const section = question.section?.trim().slice(0, ANSWER_ASSIST_OPTION_MAX);
  return {
    id: question.id,
    label,
    type: question.type,
    required: question.required,
    ...(section ? { section } : {}),
    ...(options.length
      ? {
          options: options.map((option) => ({
            label: option.label.slice(0, ANSWER_ASSIST_OPTION_MAX),
            value: option.value,
          })),
        }
      : {}),
  };
}

/**
 * Questions whose wording matched no saved answer exactly are described to the
 * background (form text only), which says which saved answer each one asks
 * for. The extension then fills that saved value itself; every approval and
 * option check in `matchChosenAnswer` still runs, so AI never writes an answer.
 */
async function assistAnswerMatches(
  questions: readonly QuestionDescriptor[],
  matches: Map<string, AnswerMatch>,
  answers: readonly Answer[],
  matchOptions: MatchOptions,
  control: ApplyControl | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!control?.answerAssist || answers.length === 0 || signal?.aborted) return;
  const described = questions
    .filter((question) => {
      const match = matches.get(question.id);
      // An exact but unapproved match is a permission question, not a wording one.
      if (!match || match.source !== 'none' || (match.answerId && match.confidence >= 1))
        return false;
      return questions.filter((entry) => entry.id === question.id).length === 1;
    })
    .map(describeForAnswerAssist)
    .filter((question): question is AnswerAssistQuestion => question !== null)
    .slice(0, ANSWER_ASSIST_MAX_QUESTIONS);
  if (described.length === 0) return;
  const mapped = await control.answerAssist(described);
  if (!mapped || signal?.aborted) return;
  for (const entry of mapped) {
    if (!entry.answerId || entry.source === 'none') continue;
    const question = questions.find((candidate) => candidate.id === entry.questionId);
    const answer = answers.find((candidate) => candidate.id === entry.answerId);
    if (!question || !answer || !described.some((item) => item.id === question.id)) continue;
    const match = matchChosenAnswer(question, answer, entry.confidence, matchOptions);
    // A value that does not fit the choices keeps the original "needs you" reason.
    if (match.value !== undefined) matches.set(question.id, match);
  }
}

/**
 * After the answer bank (exact wording, then AI matching), questions with no
 * saved answer at all may be answered by AI from the job posting and the
 * user's non-sensitive saved facts. Sensitive, EEO and personal-fact questions
 * never qualify and keep waiting for the user. A question the bank knows but
 * cannot use (an opted-out answer, a value that does not fit) is not replaced.
 */
async function writeAnswerMatches(
  questions: readonly QuestionDescriptor[],
  matches: Map<string, AnswerMatch>,
  allowFreeText: boolean,
  control: ApplyControl | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!control?.answerWrite || signal?.aborted) return;
  const described = questions
    .filter((question) => {
      const match = matches.get(question.id);
      if (!match || match.source !== 'none' || match.answerId) return false;
      if (questions.filter((entry) => entry.id === question.id).length !== 1) return false;
      return aiMayWrite(question, allowFreeText);
    })
    .map(describeForAnswerAssist)
    .filter((question): question is AnswerAssistQuestion => question !== null)
    .slice(0, ANSWER_ASSIST_MAX_QUESTIONS);
  if (described.length === 0) return;
  const written = await control.answerWrite(described);
  if (!written || signal?.aborted) return;
  for (const entry of written) {
    const question = questions.find((candidate) => candidate.id === entry.questionId);
    if (!question || !described.some((item) => item.id === question.id)) continue;
    // A choice must be one of this form's own option values.
    if (question.options?.length && !question.options.some((o) => o.value === entry.value))
      continue;
    matches.set(question.id, {
      questionId: question.id,
      value: entry.value,
      confidence: entry.confidence,
      source: 'bank',
      reason: 'Written by AI',
    });
  }
}

/**
 * Dry run only: opens an application dialog that the Apply control declared,
 * reads its questions, and leaves it unsubmitted. Nothing is filled, chosen or
 * clicked inside the dialog; the next job's navigation discards it.
 */
async function readFormQuestions(
  doc: Document,
  apply: HTMLElement,
  options: ApplyOptions,
  signal?: AbortSignal,
): Promise<QuestionDescriptor[] | undefined> {
  await humanDelay(options.humanDelay, signal);
  if (!clickElement(apply)) return undefined;
  try {
    await waitFor(() => visibleDialog(doc), { timeoutMs: waitBudget(options, 10_000), signal });
  } catch (error) {
    if (error instanceof WaitTimeoutError) return undefined;
    throw error;
  }
  return extractQuestions(doc);
}

function matchesForQuestions(
  questions: QuestionDescriptor[],
  matches: ReadonlyMap<string, AnswerMatch>,
): QuestionDescriptor[] {
  return questions.map((question) => {
    const match = matches.get(question.id);
    return {
      ...question,
      confidence: match?.confidence ?? 0,
      suggestedAnswer: match?.value,
      answerSource: match?.source ?? 'none',
      helpText:
        match?.source === 'none'
          ? [question.helpText, match.reason].filter(Boolean).join(' ')
          : question.helpText,
    };
  });
}

function validationFailure(
  jobId: string,
  errors: string[],
  documentsUsed?: DocumentsUsed,
): ApplyResult {
  const error = classifySubmitFailure(errors);
  const missing = missingDocumentTypesInErrors(errors);
  if (error.code === 'UNKNOWN' && missing.length > 0) {
    return missingDocumentResult(
      jobId,
      missing,
      errors,
      Array.isArray(documentsUsed) ? documentsUsed : [],
    );
  }
  return {
    jobId,
    outcome: 'failed',
    error,
    ...(documentsUsed ? { documentsUsed } : {}),
  };
}

function missingDocumentResult(
  jobId: string,
  missing: DocumentType[],
  errors: string[] = [],
  documentsUsed: { type: DocumentType; id: string }[] = [],
): ApplyResult {
  return {
    jobId,
    outcome: 'needs_input',
    missingDocumentTypes: missing,
    documentsUsed,
    error: appError(
      'MISSING_DOCUMENT',
      errors.join('; ') || `Select or upload: ${missing.join(', ')}`,
      {
        details: { documentWarnings: errors },
      },
    ),
  };
}

/**
 * Review mode (or an opt-out of one-click Apply) must not click a control that
 * may submit immediately, so the user is asked to finish in the Handshook tab.
 */
function manualSubmitRequired(job: Job, detail?: string): ApplyResult {
  return {
    jobId: job.id,
    outcome: 'manual_submit_required',
    confirmationText: detail
      ? `${ONE_CLICK_APPLY_REVIEW_REASON}. ${detail}`
      : ONE_CLICK_APPLY_REVIEW_REASON,
  };
}

/**
 * Review-mode handoff detail. Autopilot no longer needs these guesses: it
 * clicks Apply and lets the dialog collect documents and answers. Only a
 * required document with no entered ID stops it (as a Needs You result).
 */
function oneClickBlockReason(doc: Document, job: Job, options: ApplyOptions): string | undefined {
  if (job.requiredDocumentTypes.some((type) => type !== 'resume'))
    return 'This job needs other documents. Review them on Handshake.';
  const attachments = [
    ['cover letter', options.documents.coverLetterId],
    ['transcript', options.documents.transcriptId],
    ['other document', options.documents.otherDocumentId],
  ];
  const attachment = attachments.find(([, id]) => Boolean(id));
  if (attachment)
    return `One-click Apply cannot attach your chosen ${attachment[0]}. Review the files on Handshake.`;
  if ((options.explicitAnswerIds?.length ?? 0) > 0 || extractQuestions(doc).length > 0)
    return 'This job has screening questions. Review the answers on Handshake.';
  return undefined;
}

/**
 * True when the action advertises an intermediate dialog (a review/confirmation
 * step) rather than submitting on the click. Only this shape may be clicked in
 * review mode: the click opens the form instead of submitting it.
 */
function declaresReviewStep(button: Element, doc: Document): boolean {
  // `aria-haspopup="true"` means "a menu/popup", not necessarily a dialog.
  // Only a dialog role (or a control that resolves to a dialog) proves that
  // the click opens a review step instead of submitting immediately.
  const popup = (button.getAttribute('aria-haspopup') ?? '').toLowerCase();
  if (popup === 'dialog') return true;

  const controls = button.getAttribute('aria-controls');
  if (!controls) return false;
  return controls
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .some(
      (target) =>
        target !== null &&
        (target.matches('[role="dialog"], [aria-modal="true"], dialog') ||
          target.querySelector('[role="dialog"], [aria-modal="true"]') !== null),
    );
}

type QuickApplySignal =
  | { kind: 'applied'; text?: string }
  | { kind: 'dialog'; dialog: HTMLElement }
  | { kind: 'errors'; errors: string[] };

export async function applyToJob(
  doc: Document,
  job: Job,
  options: ApplyOptions,
  signal?: AbortSignal,
  control?: ApplyControl,
): Promise<ApplyResult> {
  // H1: a pause/stop may arrive before any click. Never start or continue work
  // for a run the user already stopped.
  throwIfAborted(signal);
  const currentJob = () => control?.isCurrentJob?.() !== false;
  const pageChanged = (): ApplyResult => ({
    jobId: job.id,
    outcome: 'failed',
    error: appError('CANCELLED', 'The job page changed. Return to this job before retrying.'),
  });
  if (!currentJob()) return pageChanged();
  // A page that never settled on a recognised Apply control may still have one
  // the selectors miss. Page assist chooses a control only; the caller still
  // runs every click, document and submission check below.
  let assistedApply: HTMLElement | null = null;
  try {
    await waitForJobPageReady(doc, { timeoutMs: waitBudget(options, 15_000), signal });
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
    if (!currentJob()) return pageChanged();
    assistedApply = await assistLocate(doc, 'applyButton', {
      root: doc,
      scope: 'job',
      control,
      signal,
    });
    if (!assistedApply) {
      return {
        jobId: job.id,
        outcome: 'failed',
        error: appError('UI_CHANGED', 'Could not find an Apply button on the job page'),
      };
    }
  }
  throwIfAborted(signal);
  if (!currentJob()) return pageChanged();
  if (detectAlreadyApplied(doc)) {
    return { jobId: job.id, outcome: 'already_applied' };
  }

  const state = detectJobPageState(doc);
  if (state) {
    const result = pageStateResult(state);
    return result ? { ...result, jobId: job.id } : { jobId: job.id, outcome: 'failed' };
  }

  let applyButton = findApplyButton(doc);
  if (!applyButton && !assistedApply) {
    // The control existed for the readiness probe but is not one the selectors
    // can name. One last assisted lookup before declaring the page changed.
    assistedApply = await assistLocate(doc, 'applyButton', {
      root: doc,
      scope: 'job',
      control,
      signal,
    });
  }
  if (!applyButton && assistedApply) {
    applyButton = {
      element: assistedApply,
      type: 'handshake_form',
      label: getAccessibleName(assistedApply) || 'Apply',
    };
  }
  if (!applyButton) {
    recordJobActionOutline(doc, 'job.applyButton');
    return {
      jobId: job.id,
      outcome: 'failed',
      error: appError('UI_CHANGED', 'Could not find an Apply button on the job page'),
    };
  }
  if (applyButton.type === 'external') {
    return { jobId: job.id, outcome: 'external' };
  }

  // P1-12: a dry run never fills or submits. It may open the application form
  // only when the Apply control itself declares that it opens a dialog, to read
  // the form's questions for the Questions to answer list; a plain Apply may
  // submit on click, so it is never clicked in a dry run.
  if (options.mode === 'dry_run') {
    const questions =
      applyButton.type !== 'quick_apply' && declaresReviewStep(applyButton.element, doc)
        ? await readFormQuestions(doc, applyButton.element, options, signal)
        : undefined;
    return {
      jobId: job.id,
      outcome: 'would_apply',
      confirmationText:
        questions === undefined
          ? `Dry run: would apply to ${job.title} at ${job.employer}.`
          : `Dry run: would apply to ${job.title} at ${job.employer}; read ${questions.length} form question${questions.length === 1 ? '' : 's'}.`,
      ...(questions?.length ? { questions } : {}),
    };
  }

  const mustReview = options.mode !== 'autopilot' || options.reviewBeforeSubmit;
  let isQuickApply = applyButton.type === 'quick_apply';
  let isOneClick = !declaresReviewStep(applyButton.element, doc);
  let quickDocuments: DocumentsUsed = [];
  const authorizedToSubmit = async (): Promise<boolean> => {
    if (signal?.aborted || control?.needsReview() || !currentJob()) return false;
    try {
      const authorized = await control?.authorizeSubmit();
      // Revocation can arrive while the grant is in transit. Do not await
      // anything between this final local check and the submitting click.
      return authorized === true && !signal?.aborted && !control?.needsReview() && currentJob();
    } catch {
      return false;
    }
  };

  if (isOneClick) {
    // Consent accepts profile defaults, never an application with known missing
    // files. A required document with no entered ID always needs the user.
    const preflight = verifyQuickApplyDocuments(
      doc,
      job.requiredDocumentTypes,
      options.documents,
      options.documentsAvailable ?? [],
    );
    if (preflight.missing.length > 0)
      return missingDocumentResult(job.id, preflight.missing, preflight.errors);
    // Review mode, or an install that did not opt in to one-click Apply, keeps
    // the conservative handoff. Autopilot clicks and lets the dialog collect
    // documents and answers — the post-click branch verifies the outcome.
    if (mustReview || options.allowOneClickApply !== true) {
      // A declared alternative form keeps exact document selection available.
      const alternative = Array.from(
        doc.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
      ).find(
        (element) =>
          element !== applyButton?.element &&
          isVisible(element) &&
          !isDisabledElement(element) &&
          /^(apply|apply to (this )?job|review application)$/i.test(
            getAccessibleName(element).trim(),
          ) &&
          declaresReviewStep(element, doc),
      );
      if (alternative) {
        applyButton = {
          element: alternative,
          type: 'handshake_form',
          label: getAccessibleName(alternative),
        };
        isQuickApply = false;
        isOneClick = false;
      } else {
        return manualSubmitRequired(
          job,
          mustReview ? oneClickBlockReason(doc, job, options) : undefined,
        );
      }
    }
  }

  await humanDelay(options.humanDelay, signal);
  // H1: never click an action control after the caller aborted.
  throwIfAborted(signal);
  if (!currentJob()) return pageChanged();
  if (isOneClick) {
    if (!(await authorizedToSubmit()) || signal?.aborted || control?.needsReview())
      return manualSubmitRequired(
        job,
        'Automatic submission was not authorized for this attempt. Handshook did not click Apply.',
      );
    // Recheck synchronous preconditions after the asynchronous grant. Nothing
    // may await between authorization, this final check, and the click.
    if (options.allowOneClickApply !== true) return manualSubmitRequired(job);
    const currentFiles = verifyQuickApplyDocuments(
      doc,
      job.requiredDocumentTypes,
      options.documents,
      options.documentsAvailable ?? [],
    );
    if (currentFiles.missing.length > 0)
      return missingDocumentResult(job.id, currentFiles.missing, currentFiles.errors);
    if (detectAlreadyApplied(doc)) return { jobId: job.id, outcome: 'already_applied' };
    const currentState = detectJobPageState(doc);
    if (currentState) {
      const result = pageStateResult(currentState);
      if (result) return { ...result, jobId: job.id };
    }
    const currentAction = findApplyButton(doc);
    const actionChanged = currentAction
      ? currentAction.element !== applyButton.element || currentAction.type === 'external'
      : !(
          assistedApply?.isConnected &&
          isVisible(assistedApply) &&
          applyButton.element === assistedApply
        );
    if (actionChanged)
      return manualSubmitRequired(job, 'The application action changed. Check the job page.');
    quickDocuments = 'handshake_profile_defaults';
  }
  // M6: snapshot immediately before the click, including toasts arriving during
  // pacing/authorization. Existing evidence must never verify this submission.
  let baselineTexts = confirmationBaseline(doc);
  if (isOneClick) control?.beforeSubmit?.(baselineTexts);
  const confirmAfterAction = (): ReturnType<typeof detectConfirmation> =>
    currentJob() ? detectConfirmation(doc, { baselineTexts }) : { applied: false };
  if (!clickElement(applyButton.element)) {
    return {
      jobId: job.id,
      outcome: 'failed',
      error: appError('UI_CHANGED', 'Could not click the Apply button'),
    };
  }

  let modal: HTMLElement;
  if (isQuickApply || isOneClick) {
    // Quick Apply may submit immediately or open a review/confirmation step.
    // Wait for either outcome instead of assuming a single-click submit.
    let detected: QuickApplySignal;
    try {
      detected = await waitFor<QuickApplySignal>(
        () => {
          const confirmation = confirmAfterAction();
          if (confirmation.applied) return { kind: 'applied', text: confirmation.text };
          const dialog = visibleDialog(doc);
          if (dialog) return { kind: 'dialog', dialog };
          const validation = detectValidationErrors(doc);
          if (validation.length > 0) return { kind: 'errors', errors: validation };
          return null;
        },
        { timeoutMs: waitBudget(options, 20_000), signal },
      );
    } catch (error) {
      if (error instanceof CancelledError) {
        // The click may already have submitted. Never retry silently; report
        // an uncertain submission so the engine asks for human verification.
        return {
          jobId: job.id,
          outcome: 'verifying',
          documentsUsed: quickDocuments,
          error: appError(
            'CANCELLED',
            'Stopped while Apply was in progress. Check the job page before retrying.',
          ),
        };
      }
      if (!(error instanceof WaitTimeoutError)) throw error;
      if (mustReview) {
        return manualSubmitRequired(job, 'Quick Apply did not open a review step');
      }
      // L16: with no dialog and no confirmation there is no evidence of a
      // submission. `verifying` is honest whether or not the setting waits.
      return {
        jobId: job.id,
        outcome: 'verifying',
        documentsUsed: quickDocuments,
        error: appError(
          'UNKNOWN',
          options.verifySubmissions
            ? 'No confirmation appeared after Apply. Check the job page before retrying.'
            : 'Verification is disabled and Apply showed no confirmation. Check the job page before retrying.',
        ),
      };
    }

    if (detected.kind === 'applied') {
      return {
        jobId: job.id,
        outcome: 'applied',
        submittedAt: Date.now(),
        confirmationText: detected.text,
        documentsUsed: quickDocuments,
      };
    }
    if (detected.kind === 'errors') {
      return validationFailure(job.id, detected.errors, quickDocuments);
    }
    modal = detected.dialog;
  } else {
    try {
      modal = await waitFor(() => visibleDialog(doc), {
        timeoutMs: waitBudget(options, 15_000),
        signal,
      });
    } catch (error) {
      if (error instanceof WaitTimeoutError) {
        const confirmation = confirmAfterAction();
        if (confirmation.applied) {
          return {
            jobId: job.id,
            outcome: 'applied',
            submittedAt: Date.now(),
            confirmationText: confirmation.text,
          };
        }
        return {
          jobId: job.id,
          outcome: 'failed',
          error: appError('UI_CHANGED', 'Application form did not open'),
        };
      }
      throw error;
    }
  }

  // Let the newly opened form settle before interacting with its controls.
  await humanDelay(options.humanDelay, signal);
  const required = job.requiredDocumentTypes;
  const selected = await selectRequiredDocuments(
    modal.ownerDocument,
    required,
    options.documents,
    options.documentsAvailable ?? [],
    signal,
    options.humanDelay,
    control,
  );
  if (!selected.ok) {
    return missingDocumentResult(job.id, selected.missing, selected.errors, selected.used);
  }
  // M15: attach a configured cover letter/transcript/other document whenever
  // the form offers the field, even if the posting did not mark it required.
  const optional = await selectConfiguredDocuments(
    modal.ownerDocument,
    options.documents,
    options.documentsAvailable ?? [],
    required,
    signal,
    options.humanDelay,
    control,
  );
  const usedDocuments = [...selected.used, ...optional.used];
  const documentFields = { ...optional.fields, ...selected.fields };
  if (!optional.ok) {
    return missingDocumentResult(job.id, optional.missing, optional.errors, usedDocuments);
  }

  const questions = extractQuestions(modal.ownerDocument);
  const explicitAnswerIds = new Set(options.explicitAnswerIds ?? []);
  const matchOptions = {
    allowFreeText: options.allowFreeTextAutoFill,
    allowSensitive: options.allowSensitiveAutoSubmit,
    allowEeo: options.allowEeoAutoFill,
    explicitAnswerIds,
  };
  const matches = new Map(
    matchAllAnswers(questions, options.answers, matchOptions).map((match) => [
      match.questionId,
      match.source === 'bank' && match.confidence < 1
        ? {
            ...match,
            source: 'none' as const,
            reason:
              'The question wording differs from the approved answer. Confirm it for this job.',
          }
        : match,
    ]),
  );
  await assistAnswerMatches(questions, matches, options.answers, matchOptions, control, signal);
  throwIfAborted(signal);
  await writeAnswerMatches(questions, matches, options.allowFreeTextAutoFill, control, signal);
  throwIfAborted(signal);
  const annotated = matchesForQuestions(questions, matches);
  const answersById = new Map(options.answers.map((answer) => [answer.id, answer]));
  const unapproved = annotated.filter((question) => {
    const match = matches.get(question.id);
    const answer = match?.answerId ? answersById.get(match.answerId) : undefined;
    return answer && answerApprovalReason(answer, options, question) !== undefined;
  });
  // Bank answers without approval stay blank even in Review. Needs You presents
  // the mapped suggestion for the user to edit/confirm. Explicit job answers may
  // fill, but the same approval counts still prohibit automatic submission.
  const pending = annotated.filter(
    (question) =>
      question.answerSource === 'none' &&
      ((options.stopOnUnknownQuestion && question.required) || unapproved.includes(question)),
  );
  if (pending.length > 0) {
    return {
      jobId: job.id,
      outcome: 'needs_input',
      questions: pending,
      error: appError('UNKNOWN_QUESTION', 'Some questions need your answer or approval'),
    };
  }

  const fillResult = await fillQuestions(modal.ownerDocument, questions, matches, {
    signal,
    humanDelay: options.humanDelay,
  });
  if (options.stopOnUnknownQuestion && fillResult.unknown.some((question) => question.required)) {
    return {
      jobId: job.id,
      outcome: 'needs_input',
      questions: fillResult.unknown,
      error: appError('UNKNOWN_QUESTION', 'Some required questions could not be filled'),
    };
  }

  const answerGate = evaluateAnswerGate({
    unknownQuestionCount: fillResult.unknown.filter((question) => question.required).length,
    sensitiveUnapprovedCount: unapproved.length,
  });
  // Turning off the unknown-question pause chooses manual review, never an
  // automatic submit with missing required answers. Per-answer/global denials
  // also force review after an explicit Needs You answer has been filled.
  await humanDelay(options.humanDelay, signal);
  if (mustReview || !answerGate.allowed || signal?.aborted || control?.needsReview()) {
    return {
      jobId: job.id,
      outcome: 'ready_for_review',
      confirmationText: answerGate.allowed
        ? 'Application filled. Review and submit in the Handshook tab.'
        : `${answerGate.reasons.join('; ')}. Review and submit in the Handshook tab.`,
      documentsUsed: usedDocuments,
    };
  }

  // Locate the submit control (deterministic, then a last-resort assist) before
  // the final grant, so the grant stays the last async operation before the
  // submitting click. Every document/answer check still runs after it.
  const submitDialog = visibleDialog(doc) ?? modal;
  let submitCandidate = findSubmitButton(submitDialog);
  if (!submitCandidate) {
    submitCandidate = await assistLocate(doc, 'submitButton', {
      root: submitDialog,
      scope: 'dialog',
      control,
      signal,
    });
  }
  if (!submitCandidate) {
    return {
      jobId: job.id,
      outcome: 'failed',
      error: appError('UI_CHANGED', 'Could not find the Submit Application button'),
    };
  }

  throwIfAborted(signal);
  if (!currentJob()) return pageChanged();
  if (!(await authorizedToSubmit()) || signal?.aborted || control?.needsReview()) {
    return {
      jobId: job.id,
      outcome: 'ready_for_review',
      confirmationText: 'Application filled. Review and submit in the Handshook tab.',
      documentsUsed: usedDocuments,
    };
  }

  if (!currentJob()) return pageChanged();
  if (required.length === 0 && selected.used.length === 0 && !formDeclaresNoDocuments(doc))
    return missingDocumentResult(
      job.id,
      ['resume'],
      ['The document requirements changed. Review the current application before submitting.'],
    );
  const currentDocuments = verifySelectedDocuments(
    doc,
    usedDocuments,
    options.documentsAvailable ?? [],
    documentFields,
  );
  if (!currentDocuments.ok)
    return missingDocumentResult(job.id, currentDocuments.missing, currentDocuments.errors);
  // Conditional controls can appear while earlier answers are being filled;
  // a changed value can also invalidate the previous approved-answer snapshot.
  const currentQuestions = extractQuestions(doc);
  const changedQuestions = currentQuestions.filter((question) => {
    const previous = questions.find((entry) => entry.id === question.id);
    const match = matches.get(question.id);
    const hasValue =
      question.currentValue !== null &&
      question.currentValue !== undefined &&
      question.currentValue !== '';
    if (!previous || currentQuestions.filter((entry) => entry.id === question.id).length !== 1)
      return question.required || hasValue;
    if (!match || match.source === 'none') return question.required || hasValue;
    const canonical = (value: unknown) =>
      Array.isArray(value) ? JSON.stringify([...value].sort()) : String(value ?? '');
    return canonical(question.currentValue) !== canonical(match.value);
  });
  if (changedQuestions.length > 0) {
    return {
      jobId: job.id,
      outcome: 'needs_input',
      questions: changedQuestions,
      documentsUsed: usedDocuments,
      error: appError(
        'UNKNOWN_QUESTION',
        'The form changed. Review the current answers before submitting.',
      ),
    };
  }
  const currentState = detectJobPageState(doc);
  if (currentState) {
    const result = pageStateResult(currentState);
    if (result) return { ...result, jobId: job.id };
  }
  const currentModal = visibleDialog(doc);
  const submitButton = currentModal ? findSubmitButton(currentModal) : null;
  // A deterministic button always wins; otherwise the assisted element must
  // still belong to the dialog that is open now.
  const submit =
    submitButton ??
    (currentModal &&
    currentModal.contains(submitCandidate) &&
    isVisible(submitCandidate) &&
    !isDisabledElement(submitCandidate)
      ? submitCandidate
      : null);
  if (!submit) {
    return {
      jobId: job.id,
      outcome: 'failed',
      error: appError('UI_CHANGED', 'Could not find the Submit Application button'),
    };
  }
  // The authorization above is the final async operation before this click.
  baselineTexts = confirmationBaseline(doc);
  control?.beforeSubmit?.(baselineTexts);
  if (!clickElement(submit)) {
    return {
      jobId: job.id,
      outcome: 'failed',
      error: appError('UI_CHANGED', 'Could not click Submit Application'),
    };
  }

  // Disabling verification skips the extended wait, never the evidence check.
  if (!options.verifySubmissions) {
    const confirmation = confirmAfterAction();
    const validation = detectValidationErrors(doc);
    if (validation.length > 0) return validationFailure(job.id, validation, usedDocuments);
    return {
      jobId: job.id,
      outcome: confirmation.applied ? 'applied' : 'verifying',
      submittedAt: Date.now(),
      documentsUsed: usedDocuments,
      confirmationText: confirmation.text,
      ...(!confirmation.applied
        ? {
            error: appError(
              'UNKNOWN',
              'No submission confirmation. Check the job page or My Jobs.',
            ),
          }
        : {}),
    };
  }

  // A click can be swallowed while the dialog is still settling or an overlay
  // intercepts it; the form staying open means nothing was sent, so one bounded
  // retry is safe. A submitted form closes or navigates, so a retry only ever
  // happens when the first click did not register.
  let retried = false;
  const clickedAt = Date.now();
  const formStillOpen = (): boolean =>
    currentModal !== null && currentModal.isConnected && isVisible(currentModal);
  try {
    const result = await waitFor<
      { kind: 'applied'; text?: string } | { kind: 'errors'; errors: string[] }
    >(
      () => {
        // Handshake can close the form and show a short-lived rejection toast.
        // Read it on every poll, before the retry/timeout can lose the reason.
        const validation = detectValidationErrors(doc);
        if (validation.length > 0) return { kind: 'errors', errors: validation };
        const detected = confirmAfterAction();
        if (detected.applied) return { kind: 'applied', text: detected.text };
        if (!retried && Date.now() - clickedAt >= 3_000) {
          retried = true;
          if (formStillOpen() && isVisible(submit) && !isDisabledElement(submit)) {
            clickElement(submit);
          }
        }
        return null;
      },
      { timeoutMs: waitBudget(options, 25_000), signal },
    );
    if (result.kind === 'errors') return validationFailure(job.id, result.errors, usedDocuments);
    return {
      jobId: job.id,
      outcome: 'applied',
      submittedAt: Date.now(),
      confirmationText: result.text,
      documentsUsed: usedDocuments,
    };
  } catch (error) {
    if (error instanceof CancelledError) {
      // The submit click already happened. A cancelled wait is not proof that
      // nothing was sent, so ask for verification instead of retrying.
      return {
        jobId: job.id,
        outcome: 'verifying',
        error: appError(
          'CANCELLED',
          'Stopped after clicking Submit. Check the job page before retrying.',
        ),
        documentsUsed: usedDocuments,
      };
    }
    if (!(error instanceof WaitTimeoutError)) throw error;
    const validation = detectValidationErrors(doc);
    if (validation.length > 0) {
      return validationFailure(job.id, validation, usedDocuments);
    }
    if (!isApplicationModalOpen(doc)) {
      return {
        jobId: job.id,
        outcome: 'verifying',
        error: appError('UNKNOWN', 'Submit was clicked but no confirmation was detected'),
        documentsUsed: usedDocuments,
      };
    }
    return {
      jobId: job.id,
      outcome: 'verifying',
      error: appError('UNKNOWN', 'Submit has no confirmed outcome. Check the job page or My Jobs.'),
      documentsUsed: usedDocuments,
    };
  }
}
