import { describe, expect, it } from 'vitest';
import { matchAllAnswers, requiresFreeText } from '@/handshake/answerMatcher';
import { normalizeAnswerSafety } from '@/core/answers/answerDraft';
import { saveAnswer, listAnswers } from '@/core/storage/answers';
import { resetDb } from '@/core/storage/db';
import { makeAnswer, makeQuestion } from '@/test/factories';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  window.localStorage.clear();
  await resetDb();
});

describe('EEO and sensitivity opt-ins — M7/M9', () => {
  it('never matches an EEO answer without allowEeo, even when the stored flag is false', () => {
    const question = makeQuestion({ id: 'q-eeo', label: 'Gender identity', type: 'select' }, 1);
    question.options = [
      { label: 'Woman', value: 'woman' },
      { label: 'Man', value: 'man' },
    ];
    const answer = makeAnswer(
      {
        id: 'a-eeo',
        label: 'Gender identity',
        aliases: [],
        type: 'select',
        value: 'woman',
        options: { woman: 'woman' },
        category: 'custom',
        sensitive: false,
        autoSubmitAllowed: true,
      },
      1,
    );

    expect(
      matchAllAnswers([question], [answer], { allowSensitive: true, allowEeo: false })[0],
    ).toMatchObject({ source: 'none' });
    expect(
      matchAllAnswers([question], [answer], { allowSensitive: true, allowEeo: true })[0],
    ).toMatchObject({ source: 'bank', value: 'woman' });
  });

  it('derives sensitivity from the label even when the stored flag says false', () => {
    const question = makeQuestion(
      { id: 'q-sponsor', label: 'Will you require visa sponsorship?', type: 'radio' },
      1,
    );
    question.options = [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ];
    const answer = makeAnswer(
      {
        id: 'a-sponsor',
        label: 'Will you require visa sponsorship?',
        type: 'radio',
        value: false,
        options: { yes: 'true', no: 'false' },
        category: 'custom',
        sensitive: false,
        autoSubmitAllowed: true,
      },
      1,
    );

    expect(matchAllAnswers([question], [answer], { allowSensitive: false })[0]?.source).toBe(
      'none',
    );
    expect(matchAllAnswers([question], [answer], { allowSensitive: true })[0]?.source).toBe('bank');
  });

  it('normalizes stored answers on save', async () => {
    await saveAnswer(
      makeAnswer(
        {
          id: 'stale',
          label: 'Are you a protected veteran?',
          sensitive: false,
          category: 'custom',
        },
        1,
      ),
    );
    const [saved] = await listAnswers();
    expect(saved).toMatchObject({ sensitive: true, category: 'eeo' });
  });

  it('normalizeAnswerSafety never downgrades a previously sensitive answer', () => {
    const answer = makeAnswer(
      { label: 'Preferred name', sensitive: true, category: 'identity' },
      1,
    );
    expect(normalizeAnswerSafety(answer)).toMatchObject({
      sensitive: true,
      category: 'identity',
    });
  });
});

describe('free-text opt-out — M8', () => {
  it('does not treat prose as structured just because its category is work', () => {
    const question = makeQuestion(
      { id: 'q-why', label: 'Why do you want this job?', type: 'textarea' },
      1,
    );
    const answer = makeAnswer(
      {
        id: 'a-why',
        label: 'Why do you want this job?',
        type: 'textarea',
        value: 'I like building reliable tools.',
        category: 'work',
        autoSubmitAllowed: true,
      },
      1,
    );

    expect(requiresFreeText(question)).toBe(true);
    expect(matchAllAnswers([question], [answer], { allowFreeText: false })[0]?.source).toBe('none');
    expect(matchAllAnswers([question], [answer], { allowFreeText: true })[0]?.source).toBe('bank');
  });

  it('still fills structured identity fields without the free-text opt-in', () => {
    const question = makeQuestion({ id: 'q-email', label: 'Email address', type: 'text' }, 1);
    const answer = makeAnswer(
      {
        id: 'a-email',
        label: 'Email address',
        type: 'text',
        value: 'candidate@example.test',
        autoSubmitAllowed: true,
      },
      1,
    );
    expect(requiresFreeText(question)).toBe(false);
    expect(matchAllAnswers([question], [answer], { allowFreeText: false })[0]?.source).toBe('bank');
  });
});

describe('job-specific answer precedence — M10', () => {
  it('prefers an explicit job answer on a label tie with the bank', () => {
    const question = makeQuestion({ id: 'q-loc', label: 'Preferred location', type: 'text' }, 1);
    const jobAnswer = makeAnswer(
      { id: 'job-loc', label: 'Preferred location', value: 'New York', updatedAt: 2 },
      1,
    );
    const bankAnswer = makeAnswer(
      {
        id: 'bank-loc',
        label: 'Preferred location',
        value: 'Remote',
        updatedAt: 1,
        autoSubmitAllowed: true,
      },
      2,
    );

    const [match] = matchAllAnswers([question], [jobAnswer, bankAnswer], {
      allowFreeText: true,
      explicitAnswerIds: new Set([jobAnswer.id]),
    });
    expect(match).toMatchObject({ answerId: 'job-loc', value: 'New York' });
  });
});
