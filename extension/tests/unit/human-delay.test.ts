import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerMatch } from '@/core/contracts';
import { humanDelay } from '@/handshake/human-delay';
import { extractQuestions, fillQuestions } from '@/handshake/questions';
import { selectRequiredDocuments } from '@/handshake/documents';
import { makeDocument } from '@/test/factories';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('human action pacing', () => {
  it('randomizes in the requested range and bounds oversized waits', async () => {
    let done = false;
    const waiting = humanDelay({ minMs: 400, maxMs: 1200 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(799);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    const bounded = humanDelay({ minMs: 40_000, maxMs: 90_000 });
    await vi.advanceTimersByTimeAsync(3000);
    await bounded;
  });

  it('aborts an active wait immediately and cancels its timer', async () => {
    const controller = new AbortController();
    const waiting = humanDelay({ minMs: 400, maxMs: 1200 }, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(humanDelay(undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('pauses between approved field fills and aborts before the next fill', async () => {
    document.body.innerHTML =
      '<label for="a">First name</label><input id="a"><label for="b">Last name</label><input id="b">';
    const questions = extractQuestions(document);
    expect(questions).toHaveLength(2);
    const matches = new Map<string, AnswerMatch>(
      questions.map((question) => [
        question.id,
        {
          questionId: question.id,
          value: 'Fixture',
          confidence: 1,
          source: 'job',
          reason: 'Explicit',
        },
      ]),
    );
    const controller = new AbortController();
    const filling = fillQuestions(document, questions, matches, {
      signal: controller.signal,
      humanDelay: { minMs: 400, maxMs: 400 },
    });
    const rejected = expect(filling).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(399);
    expect((document.querySelector('#a') as HTMLInputElement).value).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect((document.querySelector('#a') as HTMLInputElement).value).toBe('Fixture');
    expect((document.querySelector('#b') as HTMLInputElement).value).toBe('');
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect((document.querySelector('#b') as HTMLInputElement).value).toBe('');
  });

  it('aborts a document selection pause before changing the chosen document', async () => {
    document.body.innerHTML =
      '<label for="resume">Resume</label><select id="resume"><option value="">Choose</option><option value="r">Fixture resume</option></select>';
    const controller = new AbortController();
    const selecting = selectRequiredDocuments(
      document,
      ['resume'],
      { resumeId: 'r' },
      [makeDocument({ id: 'r', type: 'resume', title: 'Fixture resume' })],
      controller.signal,
      { minMs: 400, maxMs: 400 },
    );
    const rejected = expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(200);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('');
    controller.abort();
    await rejected;
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('');
  });
});
