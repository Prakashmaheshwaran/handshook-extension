import { beforeEach, describe, expect, it } from 'vitest';
import type { Answer } from '@/core/contracts';
import { matchAllAnswers } from '@/handshake/answerMatcher';
import { extractQuestions, fillQuestions } from '@/handshake/questions';
import { makeAnswer } from '@/test/factories';

async function fill(answers: Answer[]) {
  const questions = extractQuestions(document);
  const matches = matchAllAnswers(questions, answers, {
    allowFreeText: true,
    allowSensitive: true,
    allowEeo: true,
  });
  const result = await fillQuestions(
    document,
    questions,
    new Map(matches.map((match) => [match.questionId, match])),
    {},
  );
  return { questions, matches, ...result };
}

function value(id: string): string {
  return document.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('matching is filling', () => {
  it('fills a fuzzy match without requiring an exact label or alias a second time', async () => {
    document.body.innerHTML =
      '<label for="field">Preferred work locations</label><input id="field" required>';
    const result = await fill([
      makeAnswer({ label: 'Preferred work location', value: 'Remote', autoSubmitAllowed: true }),
    ]);
    expect(result.matches[0]?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.unknown).toEqual([]);
    expect(value('field')).toBe('Remote');
  });

  it('keeps overlapping aliases bound to their own mapped questions', async () => {
    document.body.innerHTML =
      '<label for="desired">Desired location</label><input id="desired" required><label for="current">Current location</label><input id="current" required>';
    const result = await fill([
      makeAnswer({
        id: 'desired-answer',
        label: 'Desired location',
        aliases: ['location'],
        value: 'Remote',
        autoSubmitAllowed: true,
      }),
      makeAnswer({
        id: 'current-answer',
        label: 'Current location',
        value: 'Boston',
        autoSubmitAllowed: true,
      }),
    ]);
    expect(result.filled).toHaveLength(2);
    expect(value('desired')).toBe('Remote');
    expect(value('current')).toBe('Boston');
  });

  it('fills each select, radio, and checkbox from its resolved option values', async () => {
    document.body.innerHTML = `
      <label for="location">Preferred location</label>
      <select id="location" required><option value="">Choose</option><option value="r">Remote</option><option value="o">Onsite</option></select>
      <fieldset><legend>Available to start?</legend>
        <input id="yes" name="available" type="radio" value="1" required><label for="yes">Yes</label>
        <input id="no" name="available" type="radio" value="0"><label for="no">No</label>
      </fieldset>
      <fieldset><legend>Preferred shifts</legend>
        <input id="morning" name="shifts" type="checkbox" value="am"><label for="morning">Morning</label>
        <input id="evening" name="shifts" type="checkbox" value="pm"><label for="evening">Evening</label>
        <input id="night" name="shifts" type="checkbox" value="night" checked><label for="night">Night</label>
      </fieldset>`;
    const answers = [
      makeAnswer({
        id: 'location',
        label: 'Preferred location',
        type: 'select',
        value: 'Anywhere',
        options: { Anywhere: 'r' },
        autoSubmitAllowed: true,
      }),
      makeAnswer({
        id: 'availability',
        label: 'Available to start?',
        type: 'radio',
        value: true,
        options: { yes: '1', no: '0' },
        autoSubmitAllowed: true,
      }),
      makeAnswer({
        id: 'shifts',
        label: 'Preferred shifts',
        type: 'checkbox',
        value: ['Early', 'Evening'],
        options: { early: 'am' },
        autoSubmitAllowed: true,
      }),
    ];
    const result = await fill(answers);
    expect(result.questions.map((question) => question.label)).toEqual([
      'preferred location',
      'available to start',
      'preferred shifts',
    ]);
    expect(result.filled).toHaveLength(3);
    expect(value('location')).toBe('r');
    expect(
      ['yes', 'morning', 'evening'].every(
        (id) => document.querySelector<HTMLInputElement>(`#${id}`)?.checked,
      ),
    ).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#night')?.checked).toBe(false);
    expect(extractQuestions(document).map((question) => question.currentValue)).toEqual([
      'r',
      '1',
      ['am', 'pm'],
    ]);
    // A persisted, already-selected answer also counts as successfully filled.
    expect((await fill(answers)).unknown).toEqual([]);
  });

  it('maps a boolean checkbox only when there is one unambiguous option', async () => {
    document.body.innerHTML =
      '<fieldset><legend>Accept terms?</legend><input type="checkbox" id="terms" value="accepted"></fieldset>';
    const answer = makeAnswer({
      label: 'Accept terms?',
      type: 'checkbox',
      value: true,
      autoSubmitAllowed: true,
    });
    expect((await fill([answer])).unknown).toEqual([]);
    expect(document.querySelector<HTMLInputElement>('#terms')?.checked).toBe(true);
    expect((await fill([{ ...answer, value: false }])).unknown).toEqual([]);
    expect(document.querySelector<HTMLInputElement>('#terms')?.checked).toBe(false);
  });

  it('does not pick the first of multiple matching options', async () => {
    document.body.innerHTML =
      '<label for="location">Location</label><select id="location" required><option value="">Choose</option><option value="east">Remote east</option><option value="west">Remote west</option></select>';
    const result = await fill([
      makeAnswer({ label: 'Location', type: 'select', value: 'Remote', autoSubmitAllowed: true }),
    ]);
    expect(result.unknown).toHaveLength(1);
    expect(value('location')).toBe('');
  });

  it('leaves duplicate question identities blank instead of filling the first control twice', async () => {
    document.body.innerHTML =
      '<label for="first">Full name</label><input id="first" required><label for="second">Full name</label><input id="second" required>';
    const result = await fill([makeAnswer({ label: 'Full name', autoSubmitAllowed: true })]);
    expect(result.unknown).toHaveLength(2);
    expect([value('first'), value('second')]).toEqual(['', '']);
  });

  it('does not write to a hidden duplicate control outside the application dialog', async () => {
    document.body.innerHTML =
      '<input aria-label="Full name" id="outside"><div role="dialog"><input aria-label="Full name" id="inside" required></div>';
    const result = await fill([
      makeAnswer({ label: 'Full name', value: 'Example Candidate', autoSubmitAllowed: true }),
    ]);
    expect(result.filled).toHaveLength(1);
    expect(value('inside')).toBe('Example Candidate');
    expect(value('outside')).toBe('');
  });

  it('does not substitute a new option if the options change after matching', async () => {
    document.body.innerHTML =
      '<label for="location">Location</label><select id="location" required><option value="">Choose</option><option value="remote">Remote</option></select>';
    const questions = extractQuestions(document);
    const matches = matchAllAnswers(questions, [
      makeAnswer({ label: 'Location', value: 'remote', autoSubmitAllowed: true }),
    ]);
    document.querySelector('option[value="remote"]')?.setAttribute('value', 'onsite');
    const result = await fillQuestions(
      document,
      questions,
      new Map(matches.map((match) => [match.questionId, match])),
      {},
    );
    expect(result.unknown).toHaveLength(1);
    expect(value('location')).toBe('');
  });

  it('extracts required markers before normalization and ignores an earlier hidden dialog', async () => {
    document.body.innerHTML =
      '<div role="dialog" hidden><input aria-label="Unused"></div><div role="dialog"><label for="unknown">Unknown question *</label><input id="unknown"></div>';
    const result = await fill([]);
    expect(result.questions).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ label: 'unknown question', required: true });
  });
});
