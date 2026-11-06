import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, type Answer } from '@/core/contracts';
import type { AnswerAssistQuestion, AnswerAssistRequest } from '@/core/contracts/answerAssist';
import {
  ANSWER_ASSIST_LEARNED_KEY,
  answerAssistLearnedKey,
  runAnswerAssist,
} from '@/background/answer-assist';
import type { AnswerAssistInput, AnswerAssistSelection } from '@/ai/answer-assist';
import { resetDb, getMeta, setMeta } from '@/core/storage/db';
import { saveAnswer } from '@/core/storage/answers';
import { saveAiKey, saveSettings } from '@/core/storage/settings';
import { makeAnswer } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

const KEY = 'sk-or-v1-answer-assist-unit-test';

const GPA = makeAnswer({
  id: 'gpa',
  label: 'Cumulative GPA',
  aliases: ['gpa'],
  type: 'number',
  value: 3.8,
  category: 'education',
  autoSubmitAllowed: true,
});
const SPONSORSHIP = makeAnswer({
  id: 'sponsorship',
  label: 'Will you now or in the future require sponsorship?',
  type: 'radio',
  value: 'no',
  options: { Yes: 'yes', No: 'no' },
  category: 'work',
  autoSubmitAllowed: true,
  sensitive: true,
});
const BLANK = makeAnswer({ id: 'location', label: 'Preferred location', value: '' });

function question(overrides: Partial<AnswerAssistQuestion> = {}): AnswerAssistQuestion {
  return {
    id: 'q-gpa',
    label: 'What is your overall grade point average?',
    type: 'text',
    required: true,
    ...overrides,
  };
}

function request(questions: AnswerAssistQuestion[]): AnswerAssistRequest {
  return {
    type: 'engine.answerAssist',
    requestId: 'assist-1',
    jobId: '900001',
    applyRequestId: 'attempt-1',
    questions,
  };
}

function choosing(matches: AnswerAssistSelection['matches']) {
  return vi.fn(async (_input: AnswerAssistInput): Promise<AnswerAssistSelection> => ({
    matches,
    model: 'deepseek/deepseek-v4.1-flash',
    costUsd: 0.00001,
  }));
}

const bank = (...answers: Answer[]) => vi.fn(async () => answers);

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser({ openRouterPermission: true }).fake);
  await resetDb();
  window.localStorage.clear();
  await saveSettings(DEFAULT_SETTINGS);
  await saveAiKey(KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('answer assist gates', () => {
  it.each([
    ['AI is disabled', { ai: { enabled: false } }],
    ['answer assist is off', { ai: { answerAssist: false } }],
    [
      'no model is chosen',
      { ai: { openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: null } } },
    ],
  ] as const)('maps nothing without calling the model when %s', async (_name, patch) => {
    await saveSettings(mergeSettings(DEFAULT_SETTINGS, patch));
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.95 }]);
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(GPA) });
    expect(result).toEqual([
      { questionId: 'q-gpa', answerId: null, source: 'none', confidence: 0 },
    ]);
    expect(choose).not.toHaveBeenCalled();
  });

  it('maps nothing when the OpenRouter permission is missing', async () => {
    vi.stubGlobal('browser', createFakeBrowser().fake);
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.95 }]);
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(GPA) });
    expect(result[0]?.answerId).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });

  it('does not call the model when no saved answer has a value', async () => {
    const choose = choosing([]);
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(BLANK) });
    expect(result[0]?.answerId).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });
});

describe('answer assist mapping', () => {
  it('sends saved-answer labels but never their values, and accepts a confident match', async () => {
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.92 }]);
    const result = await runAnswerAssist(request([question()]), {
      choose,
      answers: bank(GPA, SPONSORSHIP, BLANK),
    });
    expect(result).toEqual([
      { questionId: 'q-gpa', answerId: 'gpa', source: 'ai', confidence: 0.92 },
    ]);
    const input = choose.mock.calls[0]![0];
    expect(input.answers.map((answer) => answer.id)).toEqual(['gpa', 'sponsorship']);
    const sent = JSON.stringify(input);
    expect(sent).toContain('Cumulative GPA');
    expect(sent).not.toContain('3.8');
    expect(input.answers.every((answer) => !('value' in answer))).toBe(true);
  });

  it('rejects a mapping below the confidence floor', async () => {
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.6 }]);
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(GPA) });
    expect(result[0]?.answerId).toBeNull();
  });

  it('needs more certainty for a sensitive question', async () => {
    const sponsorship = question({
      id: 'q-visa',
      label: 'Do you need an employer to sponsor a visa for you?',
      type: 'radio',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    const unsure = choosing([{ questionId: 'q-visa', answerId: 'sponsorship', confidence: 0.85 }]);
    expect(
      (
        await runAnswerAssist(request([sponsorship]), {
          choose: unsure,
          answers: bank(SPONSORSHIP),
        })
      )[0]?.answerId,
    ).toBeNull();
    const sure = choosing([{ questionId: 'q-visa', answerId: 'sponsorship', confidence: 0.95 }]);
    expect(
      (
        await runAnswerAssist(request([sponsorship]), { choose: sure, answers: bank(SPONSORSHIP) })
      )[0]?.answerId,
    ).toBe('sponsorship');
  });

  it('rejects a saved answer whose value does not fit the question’s choices', async () => {
    const choice = question({
      type: 'select',
      options: [
        { label: 'Freshman', value: 'fr' },
        { label: 'Senior', value: 'sr' },
      ],
    });
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.99 }]);
    const result = await runAnswerAssist(request([choice]), { choose, answers: bank(GPA) });
    expect(result[0]?.answerId).toBeNull();
  });

  it('ignores ids the model invents', async () => {
    const choose = choosing([{ questionId: 'q-gpa', answerId: null, confidence: 0 }]);
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(GPA) });
    expect(result[0]).toEqual({
      questionId: 'q-gpa',
      answerId: null,
      source: 'none',
      confidence: 0,
    });
  });

  it('remembers a confident match and reuses it without a model call', async () => {
    const first = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.92 }]);
    await runAnswerAssist(request([question()]), { choose: first, answers: bank(GPA) });
    expect(await getMeta(ANSWER_ASSIST_LEARNED_KEY)).toEqual([
      { key: answerAssistLearnedKey(question()), answerId: 'gpa' },
    ]);

    const second = choosing([]);
    const result = await runAnswerAssist(request([question({ id: 'other-form-id' })]), {
      choose: second,
      answers: bank(GPA),
    });
    expect(result[0]).toEqual({
      questionId: 'other-form-id',
      answerId: 'gpa',
      source: 'learned',
      confidence: 1,
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('uses a learned mapping even without a key, and drops one whose answer is gone', async () => {
    await setMeta(ANSWER_ASSIST_LEARNED_KEY, [
      { key: answerAssistLearnedKey(question()), answerId: 'deleted-answer' },
    ]);
    await saveSettings(
      mergeSettings(DEFAULT_SETTINGS, {
        ai: { openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: null } },
      }),
    );
    const result = await runAnswerAssist(request([question()]), {
      choose: choosing([]),
      answers: bank(GPA),
    });
    expect(result[0]?.answerId).toBeNull();
  });

  it('degrades to no mapping when the provider fails', async () => {
    const choose = vi.fn(async () => {
      throw new Error('provider down');
    });
    const result = await runAnswerAssist(request([question()]), { choose, answers: bank(GPA) });
    expect(result[0]?.answerId).toBeNull();
  });

  it('reads the saved bank from storage when no override is given', async () => {
    await saveAnswer(GPA);
    const choose = choosing([{ questionId: 'q-gpa', answerId: 'gpa', confidence: 0.9 }]);
    const result = await runAnswerAssist(request([question()]), { choose });
    expect(result[0]?.answerId).toBe('gpa');
  });
});
