import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionDescriptor } from '@/core/contracts';
import { matchAnswer, matchChosenAnswer } from '@/handshake/answerMatcher';
import {
  ANSWERS_DEFAULTS_KEY,
  ANSWERS_DEFAULTS_REVISION,
  listAnswers,
  saveAnswer,
} from '@/core/storage/answers';
import { getDb, getMeta, resetDb } from '@/core/storage/db';
import { DB_STORES } from '@/core/contracts';
import { defaultAnswers } from '@/ui/screens/Onboarding/defaults';
import { makeAnswer } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

function choice(labels: string[], overrides: Partial<QuestionDescriptor> = {}): QuestionDescriptor {
  return {
    id: 'q',
    label: 'Cumulative GPA',
    type: 'select',
    required: true,
    options: labels.map((label, index) => ({ label, value: `opt-${index}` })),
    fingerprint: 'f',
    ...overrides,
  };
}

const gpa = makeAnswer({
  id: 'gpa',
  label: 'Cumulative GPA',
  type: 'number',
  value: 3.8,
  autoSubmitAllowed: true,
});

describe('numeric choices', () => {
  it.each([
    [['Below 3.0', '3.0 - 3.49', '3.5 - 4.0'], 'opt-2'],
    [['Under 3.5', '3.5+'], 'opt-1'],
    [['Less than 3.5', '3.5 or above'], 'opt-1'],
    [['2.0–2.9', '3.0–3.9'], 'opt-1'],
  ])('picks the one range that contains a saved number: %j', (labels, expected) => {
    expect(matchAnswer(choice(labels), [gpa]).value).toBe(expected);
  });

  it('chooses nothing when ranges overlap ambiguously', () => {
    expect(matchAnswer(choice(['3.0 - 4.0', '3.5 - 4.0']), [gpa]).value).toBeUndefined();
  });

  it('never applies to a non-numeric value', () => {
    const answer = makeAnswer({ label: 'Cumulative GPA', value: 'yes', autoSubmitAllowed: true });
    expect(matchAnswer(choice(['3.0 - 4.0']), [answer]).value).toBeUndefined();
  });
});

describe('matchChosenAnswer', () => {
  it('fills a chosen saved answer when it is approved and fits', () => {
    const match = matchChosenAnswer(
      choice(['3.5 - 4.0'], { label: 'Overall grade point average' }),
      gpa,
      0.9,
    );
    expect(match).toMatchObject({
      source: 'bank',
      answerId: 'gpa',
      value: 'opt-0',
      confidence: 0.9,
    });
  });

  it('keeps the per-answer opt-out', () => {
    const match = matchChosenAnswer(choice(['3.5 - 4.0']), { ...gpa, autoSubmitAllowed: false }, 1);
    expect(match.source).toBe('none');
  });

  it('keeps the global sensitive switch', () => {
    const sensitive = { ...gpa, sensitive: true };
    expect(matchChosenAnswer(choice(['3.5 - 4.0']), sensitive, 1).source).toBe('none');
    expect(
      matchChosenAnswer(choice(['3.5 - 4.0']), sensitive, 1, { allowSensitive: true }).source,
    ).toBe('bank');
  });
});

describe('answers entered by the user are used automatically', () => {
  beforeEach(async () => {
    vi.stubGlobal('browser', createFakeBrowser().fake);
    await resetDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('setup answers are automatic by default', () => {
    expect(defaultAnswers().every((answer) => answer.autoSubmitAllowed)).toBe(true);
  });

  it('a new database is already at the current answer defaults', async () => {
    await saveAnswer(makeAnswer({ id: 'opted-out', value: 'x', autoSubmitAllowed: false }));
    const [answer] = await listAnswers();
    expect(answer?.autoSubmitAllowed).toBe(false);
    expect(await getMeta(ANSWERS_DEFAULTS_KEY)).toBe(ANSWERS_DEFAULTS_REVISION);
  });

  it('upgrades answers saved by an older build once, leaving blank ones alone', async () => {
    const db = await getDb();
    await db.delete(DB_STORES.meta, ANSWERS_DEFAULTS_KEY);
    await db.put(
      DB_STORES.answers,
      makeAnswer({ id: 'gpa', value: '3.8', autoSubmitAllowed: false }, 1),
    );
    await db.put(
      DB_STORES.answers,
      makeAnswer({ id: 'blank', value: '', autoSubmitAllowed: false }, 2),
    );

    const byId = Object.fromEntries((await listAnswers()).map((answer) => [answer.id, answer]));
    expect(byId.gpa?.autoSubmitAllowed).toBe(true);
    expect(byId.blank?.autoSubmitAllowed).toBe(false);

    // A later opt-out in Settings is kept: the upgrade runs only once.
    await saveAnswer({ ...byId.gpa!, autoSubmitAllowed: false });
    const again = (await listAnswers()).find((answer) => answer.id === 'gpa');
    expect(again?.autoSubmitAllowed).toBe(false);
  });
});

describe('blank saved answers', () => {
  it('never tie with a saved answer that has a value', () => {
    const blank = makeAnswer({ id: 'blank', label: 'Cumulative GPA', value: '' }, 1);
    const filled = makeAnswer(
      { id: 'filled', label: 'Cumulative GPA', value: '3.8', autoSubmitAllowed: true },
      2,
    );
    const question: QuestionDescriptor = {
      id: 'q',
      label: 'cumulative gpa',
      type: 'text',
      required: true,
      fingerprint: 'q',
    };
    expect(matchAnswer(question, [blank, filled], { allowFreeText: true })).toMatchObject({
      source: 'bank',
      answerId: 'filled',
      value: '3.8',
    });
  });
});
