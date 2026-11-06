/**
 * Autopilot gating (docs/CONTRACTS.md §14).
 *
 * Pure decision function: `allowed` is true only when every safety condition
 * holds. Every rejection carries a short, user-facing reason; at most five are
 * returned because the UI has room for a glance, not a wall of text.
 */

import type {
  ApplyType,
  AutopilotDecision,
  AutopilotInputs,
  DocumentType,
  RunMode,
} from '@/core/contracts';

export const MAX_AUTOPILOT_REASONS = 5;

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  resume: 'resume',
  cover_letter: 'cover letter',
  transcript: 'transcript',
  other: 'other document',
};

function modeReason(mode: RunMode): string {
  return mode === 'dry_run'
    ? 'Dry run never submits applications'
    : 'Review mode requires a manual submit';
}

function applyTypeReason(applyType: ApplyType): string | null {
  if (applyType === 'external') return 'This job applies on an external site';
  if (applyType === 'unknown') return 'Apply type could not be determined';
  return null;
}

function documentList(types: readonly DocumentType[]): string {
  return types.map((type) => DOCUMENT_LABELS[type]).join(', ');
}

function questionReason(count: number): string {
  return count === 1
    ? '1 screening question still needs an answer'
    : `${count} screening questions still need answers`;
}

function sensitiveReason(count: number): string {
  return count === 1
    ? '1 answer needs your approval for autopilot'
    : `${count} answers need your approval for autopilot`;
}

/** The legacy sensitive count includes all per-answer and global approval denials. */
export function evaluateAnswerGate(
  inputs: Pick<AutopilotInputs, 'unknownQuestionCount' | 'sensitiveUnapprovedCount'>,
): AutopilotDecision {
  const reasons: string[] = [];
  if (inputs.unknownQuestionCount > 0) reasons.push(questionReason(inputs.unknownQuestionCount));
  if (inputs.sensitiveUnapprovedCount > 0) {
    reasons.push(sensitiveReason(inputs.sensitiveUnapprovedCount));
  }
  return { allowed: reasons.length === 0, reasons };
}

export function evaluateAutopilot(inputs: AutopilotInputs): AutopilotDecision {
  const reasons: string[] = [];

  if (!inputs.sessionLoggedIn) {
    reasons.push('Not signed in to Handshake');
  }

  if (inputs.dailyCapReached) {
    reasons.push('Daily application cap reached');
  }

  if (inputs.consecutiveFailures >= inputs.maxConsecutiveFailures) {
    reasons.push(
      `Too many consecutive failures (${inputs.consecutiveFailures} of ${inputs.maxConsecutiveFailures})`,
    );
  }

  if (inputs.mode !== 'autopilot') {
    reasons.push(modeReason(inputs.mode));
  }

  const applyType = applyTypeReason(inputs.applyType);
  if (applyType) reasons.push(applyType);

  if (inputs.minFitScore > 0) {
    if (inputs.fitScore === undefined) {
      reasons.push('No fit score for this job');
    } else if (inputs.fitScore < inputs.minFitScore) {
      reasons.push(
        `Fit score ${inputs.fitScore.toFixed(2)} is below the minimum ${inputs.minFitScore.toFixed(2)}`,
      );
    }
  }

  if (inputs.missingDocumentTypes.length > 0) {
    reasons.push(`Missing required documents: ${documentList(inputs.missingDocumentTypes)}`);
  }

  reasons.push(...evaluateAnswerGate(inputs).reasons);

  return {
    allowed: reasons.length === 0,
    reasons: reasons.slice(0, MAX_AUTOPILOT_REASONS),
  };
}
