import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionDescriptor } from '@/core/contracts';
import {
  dismissInboxQuestion,
  inboxKey,
  listInboxQuestions,
  recordInboxQuestions,
} from '@/core/storage/questionInbox';
import { saveAnswer } from '@/core/storage/answers';
import { resetDb } from '@/core/storage/db';
import { makeAnswer } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

function question(label: string, overrides: Partial<QuestionDescriptor> = {}): QuestionDescriptor {
  return {
    id: `q-${label}`,
    label,
    type: 'text',
    required: true,
    fingerprint: label,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.stubGlobal('browser', createFakeBrowser().fake);
  await resetDb();
});
afterEach(() => vi.unstubAllGlobals());

describe('Questions to answer', () => {
  it('collects unanswered questions once per wording and counts repeats', async () => {
    await recordInboxQuestions([question('why do you want this role')], 'job-1', 'run', 1);
    await recordInboxQuestions([question('Why do you want this role?')], 'job-2', 'run', 2);
    const [entry, ...rest] = await listInboxQuestions();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ seenCount: 2, jobIds: ['job-2', 'job-1'], firstSeenAt: 1 });
  });

  it('skips questions the answer bank already covers, blank answers excepted', async () => {
    await saveAnswer(makeAnswer({ label: 'Major', aliases: ['field of study'], value: 'CS' }, 1));
    await saveAnswer(makeAnswer({ label: 'GPA', value: '' }, 2));
    await recordInboxQuestions(
      [question('field of study'), question('gpa'), question('school')],
      'job-1',
    );
    expect((await listInboxQuestions()).map((entry) => entry.label)).toEqual(['gpa', 'school']);
  });

  it('drops a question once it is answered later', async () => {
    await recordInboxQuestions([question('school')], 'job-1');
    await saveAnswer(makeAnswer({ label: 'School', value: 'Binghamton University' }));
    expect(await listInboxQuestions()).toEqual([]);
  });

  it('keeps a dismissed question out, even when asked again', async () => {
    const asked = question('do you have a car');
    await recordInboxQuestions([asked], 'job-1');
    await dismissInboxQuestion(inboxKey(asked));
    await recordInboxQuestions([asked], 'job-2');
    expect(await listInboxQuestions()).toEqual([]);
  });

  it('ignores unlabelled and unknown-type controls', async () => {
    await recordInboxQuestions(
      [question(''), question('mystery widget', { type: 'unknown' })],
      'job-1',
    );
    expect(await listInboxQuestions()).toEqual([]);
  });

  it('lists required and frequently asked questions first', async () => {
    await recordInboxQuestions([question('optional thing', { required: false })], 'a', 'scan', 3);
    await recordInboxQuestions([question('common thing')], 'b', 'run', 1);
    await recordInboxQuestions([question('common thing')], 'c', 'run', 2);
    await recordInboxQuestions([question('rare thing')], 'd', 'run', 4);
    expect((await listInboxQuestions()).map((entry) => entry.label)).toEqual([
      'common thing',
      'rare thing',
      'optional thing',
    ]);
  });
});
