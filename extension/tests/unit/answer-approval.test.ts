import { describe, expect, it } from 'vitest';
import { answerApprovalReason, type AnswerSafetyOptions } from '@/core/answers/policy';
import { evaluateAnswerGate } from '@/core/orchestrator/guards';
import { matchAllAnswers, matchAnswer } from '@/handshake/answerMatcher';
import { makeAnswer, makeQuestion } from '@/test/factories';

const allowAll: AnswerSafetyOptions = {
  allowSensitiveAutoSubmit: true,
  allowEeoAutoFill: true,
  allowFreeTextAutoFill: true,
};
const matchOptions = { allowSensitive: true, allowEeo: true, allowFreeText: true };

describe('per-answer approval and global opt-ins', () => {
  it.each(['Full name', 'Work authorization', 'Gender identity', 'Why this role?'])(
    'requires per-answer permission for %s even with every global opt-in enabled',
    (label) => {
      const answer = makeAnswer({ label, autoSubmitAllowed: false });
      const question = makeQuestion({ label });
      expect(answerApprovalReason(answer, allowAll, question)).toMatch(/approval/);
      expect(matchAnswer(question, [answer], matchOptions)).toMatchObject({ source: 'none' });
    },
  );

  it.each([
    ['Work authorization', 'allowSensitiveAutoSubmit'],
    ['Gender identity', 'allowSensitiveAutoSubmit'],
    ['Gender identity', 'allowEeoAutoFill'],
    ['Why this role?', 'allowFreeTextAutoFill'],
  ] as const)('also requires the %s global %s opt-in', (label, flag) => {
    const answer = makeAnswer({ label, autoSubmitAllowed: true });
    expect(answerApprovalReason(answer, { ...allowAll, [flag]: false })).toBeDefined();
    expect(answerApprovalReason(answer, allowAll)).toBeUndefined();
  });

  it('derives sensitivity from the actual question and section as well as the bank entry', () => {
    const answer = makeAnswer({ label: 'Status', autoSubmitAllowed: true, sensitive: false });
    const question = makeQuestion({ label: 'Status', section: 'EEO' });
    expect(
      answerApprovalReason(answer, { ...allowAll, allowEeoAutoFill: false }, question),
    ).toMatch(/EEO/);
  });

  it('does not replace a stronger unapproved answer with a weaker approved answer', () => {
    const question = makeQuestion({ label: 'Preferred location' });
    const exact = makeAnswer({
      id: 'exact',
      label: question.label,
      value: 'Boston',
      autoSubmitAllowed: false,
    });
    const weaker = makeAnswer({
      id: 'weaker',
      label: 'Location',
      value: 'Remote',
      autoSubmitAllowed: true,
    });
    for (const answers of [
      [exact, weaker],
      [weaker, exact],
    ]) {
      expect(matchAnswer(question, answers, matchOptions)).toMatchObject({
        source: 'none',
        answerId: 'exact',
      });
    }
  });

  it('treats conflicting equally strong reusable answers as ambiguous', () => {
    const question = makeQuestion({ label: 'Preferred location' });
    const first = makeAnswer({ id: 'first', label: question.label, autoSubmitAllowed: true });
    const second = { ...first, id: 'second', value: 'Different value' };
    expect(matchAnswer(question, [first, second], matchOptions)).toMatchObject({
      source: 'none',
      reason: expect.stringMatching(/Multiple answers/),
    });
  });

  it('binds a job override to the question identity before reusable label matches', () => {
    const question = makeQuestion({ label: 'Preferred location' });
    const override = makeAnswer({ id: question.id, label: 'Earlier label', value: 'Boston' });
    const bank = makeAnswer({ id: 'bank', label: question.label, autoSubmitAllowed: true });
    expect(
      matchAnswer(question, [bank, override], {
        ...matchOptions,
        explicitAnswerIds: new Set([override.id]),
      }),
    ).toMatchObject({ source: 'job', answerId: question.id, value: 'Boston' });
  });

  it('does not spread an explicit approval to a different question through an alias', () => {
    const answer = makeAnswer({
      id: 'job-answer',
      label: 'Earlier question',
      aliases: ['New question'],
      autoSubmitAllowed: false,
    });
    expect(
      matchAnswer(makeQuestion({ label: 'New question' }), [answer], {
        ...matchOptions,
        explicitAnswerIds: new Set([answer.id]),
      }).source,
    ).toBe('none');
  });

  it('fails closed on duplicate question identities', () => {
    const question = makeQuestion({ label: 'Full name' });
    const answer = makeAnswer({ label: question.label, autoSubmitAllowed: true });
    expect(
      matchAllAnswers([question, question], [answer]).every((match) => match.source === 'none'),
    ).toBe(true);
  });

  it('feeds real missing and unapproved counts into the shared guard', () => {
    expect(evaluateAnswerGate({ unknownQuestionCount: 2, sensitiveUnapprovedCount: 3 })).toEqual({
      allowed: false,
      reasons: [
        '2 screening questions still need answers',
        '3 answers need your approval for autopilot',
      ],
    });
  });
});
