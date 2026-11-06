import { describe, expect, it } from 'vitest';
import type { AutopilotInputs } from '@/core/contracts';
import { MAX_AUTOPILOT_REASONS, evaluateAutopilot } from '@/core/orchestrator/guards';

function makeInputs(overrides: Partial<AutopilotInputs> = {}): AutopilotInputs {
  return {
    mode: 'autopilot',
    applyType: 'quick_apply',
    fitScore: 0.8,
    minFitScore: 0.55,
    missingDocumentTypes: [],
    unknownQuestionCount: 0,
    sensitiveUnapprovedCount: 0,
    dailyCapReached: false,
    consecutiveFailures: 0,
    maxConsecutiveFailures: 3,
    sessionLoggedIn: true,
    ...overrides,
  };
}

describe('evaluateAutopilot', () => {
  it('allows a fully-qualified quick apply', () => {
    expect(evaluateAutopilot(makeInputs())).toEqual({ allowed: true, reasons: [] });
  });

  it('allows a handshake form when everything else qualifies', () => {
    expect(evaluateAutopilot(makeInputs({ applyType: 'handshake_form' })).allowed).toBe(true);
  });

  it('allows a fit score exactly at the minimum', () => {
    expect(evaluateAutopilot(makeInputs({ fitScore: 0.55 })).allowed).toBe(true);
  });

  it('ignores fit score when minFitScore is zero', () => {
    const decision = evaluateAutopilot(makeInputs({ fitScore: undefined, minFitScore: 0 }));
    expect(decision.allowed).toBe(true);
  });

  it.each<[string, Partial<AutopilotInputs>, RegExp]>([
    ['not autopilot', { mode: 'review' }, /review mode/i],
    ['dry run', { mode: 'dry_run' }, /dry run/i],
    ['external apply', { applyType: 'external' }, /external site/i],
    ['unknown apply type', { applyType: 'unknown' }, /apply type/i],
    ['missing fit score', { fitScore: undefined }, /no fit score/i],
    ['fit score below minimum', { fitScore: 0.4 }, /fit score 0\.40 is below the minimum 0\.55/i],
    [
      'missing documents',
      { missingDocumentTypes: ['resume', 'cover_letter'] },
      /missing required documents: resume, cover letter/i,
    ],
    ['unknown questions', { unknownQuestionCount: 1 }, /1 screening question/i],
    ['many unknown questions', { unknownQuestionCount: 3 }, /3 screening questions/i],
    ['unapproved answer', { sensitiveUnapprovedCount: 1 }, /1 answer needs your approval/i],
    ['many unapproved answers', { sensitiveUnapprovedCount: 2 }, /2 answers need your approval/i],
    ['daily cap', { dailyCapReached: true }, /daily application cap reached/i],
    [
      'failure threshold',
      { consecutiveFailures: 3, maxConsecutiveFailures: 3 },
      /too many consecutive failures \(3 of 3\)/i,
    ],
    ['logged out', { sessionLoggedIn: false }, /not signed in to handshake/i],
  ])('blocks when %s', (_label, overrides, reasonPattern) => {
    const decision = evaluateAutopilot(makeInputs(overrides));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons.some((reason) => reasonPattern.test(reason))).toBe(true);
  });

  it('allows failures just below the threshold', () => {
    expect(
      evaluateAutopilot(makeInputs({ consecutiveFailures: 2, maxConsecutiveFailures: 3 })).allowed,
    ).toBe(true);
  });

  it('caps reasons at five while remaining blocked', () => {
    const decision = evaluateAutopilot(
      makeInputs({
        mode: 'review',
        applyType: 'external',
        fitScore: 0.1,
        minFitScore: 0.9,
        missingDocumentTypes: ['resume'],
        unknownQuestionCount: 2,
        sensitiveUnapprovedCount: 1,
        dailyCapReached: true,
        consecutiveFailures: 3,
        sessionLoggedIn: false,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toHaveLength(MAX_AUTOPILOT_REASONS);
    expect(decision.reasons.every((reason) => reason.length > 0)).toBe(true);
  });

  it('is pure and deterministic', () => {
    const inputs = makeInputs({ applyType: 'external' });
    expect(evaluateAutopilot(inputs)).toEqual(evaluateAutopilot(inputs));
  });
});
