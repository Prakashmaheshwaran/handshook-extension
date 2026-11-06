import type { ApplyType, DocumentType } from '@/core/contracts';
import { hasPositiveSubmissionEvidence } from '@/core/contracts/submitAuthorization';
import {
  getAccessibleName,
  isDisabledElement,
  isVisible,
  waitForDom,
  WaitTimeoutError,
  type WaitOptions,
} from '@/handshake/dom';
import { recordSelectorHealth } from '@/handshake/health';
import {
  describeJobActionArea,
  EXTERNAL_APPLY_COPY,
  INTERNAL_APPLY_COPY,
  isStatusRegion,
  jobActionCandidates,
  JOB_PAGE_HOOK,
  jobSelectors,
  QUICK_APPLY_COPY,
} from '@/handshake/selectors/job';
import { normalizeText } from '@/handshake/text';

const CONFIRMATION_PATTERNS = [
  /^applied on\b/i,
  /^withdraw application$/i,
  /you applied on/i,
  /application submitted/i,
  /application sent/i,
  /application received/i,
  /successfully applied/i,
  /you have applied/i,
];

const ERROR_PATTERNS = [
  /this field is required/i,
  /please (select|choose|enter|answer)/i,
  /required field/i,
  /fix the following/i,
  /something went wrong/i,
  /too many requests/i,
  /rate limit/i,
  /try again later/i,
  /(?:do )?not (?:have )?permission/i,
  /permission to apply/i,
  /forbidden/i,
  /not authorized/i,
  /access denied/i,
  /not allowed to apply/i,
];

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  resume: '(?:resume|cv)',
  cover_letter: 'cover\\s+letter',
  transcript: 'transcript',
  other: '(?:other|additional|supporting)\\s+document',
};

/** A site rejection describes the attachment, not whether the profile has a file. */
export function missingDocumentTypesInErrors(errors: readonly string[]): DocumentType[] {
  return (Object.entries(DOCUMENT_LABELS) as [DocumentType, string][])
    .filter(([, label]) => {
      const after = new RegExp(
        `\\b${label}\\b\\s*(?:(?:is|was)\\s+)?(?:missing|required|not\\s+(?:attached|selected|provided)|(?:cannot|can't)\\s+be\\s+blank)\\b`,
        'i',
      );
      const before = new RegExp(
        `\\b(?:missing|required|documents?\\s+must\\s+include|(?:please\\s+)?(?:attach|select|choose|upload))\\s+(?:(?:a|an|the|your|required)\\s+)*${label}\\b`,
        'i',
      );
      return errors.some((error) => after.test(error) || before.test(error));
    })
    .map(([type]) => type);
}

export interface ConfirmationOptions {
  /**
   * Text already on the page before the action. A confirmation that was present
   * before the click is not evidence that this action submitted anything.
   */
  baselineText?: string | null;
  /** All positive texts present before an action, including multiple toasts. */
  baselineTexts?: readonly string[];
}

/** Snapshot every pre-existing confirmation, not only the first visible toast. */
export function confirmationBaseline(doc: Document): string[] {
  return confirmationCandidates(doc).map((element) => normalizeText(element.textContent ?? ''));
}

function confirmationCandidates(doc: Document): HTMLElement[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="status"], [data-testid*="confirmation" i], [data-testid*="applied" i], .toast, .banner, .rosetta-banner, header, h2, button, [role="button"][aria-disabled="true"]',
    ),
  ).filter((element) => isVisible(element) && isStatusRegion(element));
}

export function detectConfirmation(
  doc: Document,
  options: ConfirmationOptions = {},
): { applied: boolean; text?: string } {
  const candidates = confirmationCandidates(doc);
  for (const element of candidates) {
    if (!isVisible(element) || !isStatusRegion(element)) continue;
    const text = normalizeText(element.textContent ?? '');
    if (!text || text.length > 300) continue;
    if (options.baselineText && text === options.baselineText) continue;
    if (options.baselineTexts?.includes(text)) continue;
    const appliedIndicator =
      text === 'applied' &&
      (element.matches('[role="status"], [data-testid*="applied" i]') ||
        isDisabledElement(element));
    if (
      (appliedIndicator || CONFIRMATION_PATTERNS.some((pattern) => pattern.test(text))) &&
      hasPositiveSubmissionEvidence({ jobId: '', outcome: 'applied', confirmationText: text })
    ) {
      return { applied: true, text };
    }
  }
  return { applied: false };
}

/** Status text only: descriptions cannot claim the user already applied. */
function statusText(doc: Document): string {
  const parts: string[] = [];
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[role="status"], [role="alert"], [data-testid*="status" i], [data-testid*="applied" i], [data-testid*="closed" i], [data-testid*="apply" i], header, .banner, .toast',
    ),
  )) {
    if (!isVisible(element) || !isStatusRegion(element)) continue;
    const text = normalizeText(element.textContent ?? '');
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

export function detectAlreadyApplied(doc: Document): boolean {
  return (
    /\byou applied on\b|\balready applied\b|\bapplied on\b/i.test(statusText(doc)) ||
    jobSelectors.alreadyApplied.some((strategy) => {
      if (
        !['text:applied-on-banner', 'text:withdraw-application', 'text:applied-button'].includes(
          strategy.name,
        )
      )
        return false;
      const element = strategy.find(doc);
      return element !== null && isVisible(element) && isStatusRegion(element);
    })
  );
}

export function detectValidationErrors(doc: Document): string[] {
  const errors = new Set<string>();
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[role="alert"], [aria-invalid="true"], .error, .error-message, [data-testid*="error" i], .toast, .banner, .rosetta-banner',
    ),
  )) {
    if (!isVisible(element)) continue;
    const text = normalizeText(element.textContent ?? '');
    if (
      text &&
      text.length < 300 &&
      (ERROR_PATTERNS.some((pattern) => pattern.test(text)) ||
        missingDocumentTypesInErrors([text]).length > 0)
    ) {
      errors.add(text);
    }
  }
  return [...errors];
}

export function isApplicationModalOpen(doc: Document): boolean {
  const dialogs = Array.from(
    doc.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]'),
  );
  return dialogs.some((dialog) => isVisible(dialog));
}

export function findSubmitButton(doc: ParentNode): HTMLElement | null {
  const buttons = Array.from(
    doc.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'),
  ).filter((button) => isVisible(button) && !isDisabledElement(button));
  const exact = buttons.find((button) =>
    /^submit application$/i.test(normalizeText(getAccessibleName(button))),
  );
  if (exact) return exact;
  return (
    buttons.find((button) =>
      /^(submit|apply|send application)$/i.test(normalizeText(getAccessibleName(button))),
    ) ?? null
  );
}

export interface ApplyButton {
  element: HTMLElement;
  type: ApplyType;
  label: string;
}

export function findApplyButton(doc: Document): ApplyButton | null {
  for (const element of jobActionCandidates(doc)) {
    const label = normalizeText(getAccessibleName(element) || element.textContent || '');
    if (!label || label.length > 80) continue;
    if (EXTERNAL_APPLY_COPY.test(label)) {
      return { element, type: 'external', label };
    }
    if (QUICK_APPLY_COPY.test(label)) {
      return { element, type: 'quick_apply', label };
    }
    if (INTERNAL_APPLY_COPY.test(label)) {
      return { element, type: 'handshake_form', label };
    }
  }
  return null;
}

export const JOB_PAGE_READY_TIMEOUT_MS = 15_000;

/** A separate reviewed channel inside SelectorHealth.detail; never arbitrary page text. */
export function recordJobActionOutline(doc: Document, selector = 'job.readiness'): void {
  recordSelectorHealth({
    at: Date.now(),
    page: 'job',
    selector,
    strategy: 'dom:action-area',
    ok: false,
    detail: JSON.stringify(describeJobActionArea(doc)),
  });
}

/**
 * A page shell/title alone is not readiness. Wait for the live detail root and
 * an actionable apply control or a final state. Login/challenges fail promptly
 * even when they replace the job root altogether. Probes do not spam health.
 */
export async function waitForJobPageReady(doc: Document, options: WaitOptions = {}): Promise<void> {
  try {
    await waitForDom(
      doc,
      () => {
        if (
          [...jobSelectors.login, ...jobSelectors.challenge].some((strategy) => {
            const element = strategy.find(doc);
            return element && isVisible(element);
          })
        )
          return true;

        const root = doc.querySelector(JOB_PAGE_HOOK);
        if (!root || !isVisible(root)) return false;
        if (findApplyButton(doc)) return true;
        return [
          ...jobSelectors.alreadyApplied,
          ...jobSelectors.closed,
          ...jobSelectors.notOpen,
        ].some((strategy) => {
          const element = strategy.find(root);
          return element && isVisible(element) && isStatusRegion(element);
        });
      },
      { timeoutMs: JOB_PAGE_READY_TIMEOUT_MS, intervalMs: 250, ...options },
    );
    recordSelectorHealth({
      at: Date.now(),
      page: 'job',
      selector: 'job.readiness',
      strategy: 'dom:action-area',
      ok: true,
    });
  } catch (error) {
    if (error instanceof WaitTimeoutError) recordJobActionOutline(doc);
    throw error;
  }
}
