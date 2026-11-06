import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, type JobEvent } from '@/core/contracts';
import {
  PAGE_ASSIST_ATTRIBUTES,
  type PageAssistCandidate,
  type PageAssistRequest,
  type PageAssistTarget,
} from '@/core/contracts/pageAssist';
import { pageAssistLearnedKey, runPageAssist } from '@/background/page-assist';
import { PAGE_ASSIST_MIN_CONFIDENCE } from '@/ai/page-assist';
import { resetDb, getMeta, setMeta } from '@/core/storage/db';
import { clearAiKey, saveAiKey, saveSettings } from '@/core/storage/settings';
import type { PageAssistSelection } from '@/ai/page-assist';
import { createFakeBrowser } from './helpers/fakeBrowser';

const HOST = 'app.joinhandshake.com';
const KEY = 'sk-or-v1-page-assist-unit-test';

function attributes(
  overrides: Partial<Record<(typeof PAGE_ASSIST_ATTRIBUTES)[number], string>> = {},
): PageAssistCandidate['attributes'] {
  return Object.fromEntries(
    PAGE_ASSIST_ATTRIBUTES.map((name) => [name, overrides[name] ?? '']),
  ) as PageAssistCandidate['attributes'];
}

function candidate(
  index: number,
  overrides: Partial<PageAssistCandidate> = {},
): PageAssistCandidate {
  return {
    index,
    tag: 'button',
    role: 'button',
    name: 'Apply',
    attributes: attributes(),
    inDialog: false,
    disabled: false,
    ...overrides,
  };
}

function request(
  candidates: PageAssistCandidate[],
  target: PageAssistTarget = 'applyButton',
): PageAssistRequest {
  return {
    type: 'engine.pageAssist',
    requestId: 'assist-1',
    jobId: '900001',
    applyRequestId: 'attempt-1',
    target,
    scope: target === 'submitButton' ? 'dialog' : 'job',
    candidates,
  };
}

function selection(patch: Partial<PageAssistSelection> = {}): PageAssistSelection {
  return {
    index: 0,
    confidence: 0.9,
    reason: 'Looks like the Apply button',
    model: 'deepseek/deepseek-v4.1-flash',
    costUsd: 0.000012,
    ...patch,
  };
}

function chooseReturning(value: PageAssistSelection) {
  return vi.fn(async () => value);
}

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

describe('page assist settings gate', () => {
  it('returns none without calling the model when AI is disabled', async () => {
    await saveSettings(mergeSettings(DEFAULT_SETTINGS, { ai: { enabled: false } }));
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(request([candidate(0)]), HOST, { choose });

    expect(answer).toEqual({ index: null, source: 'none' });
    expect(choose).not.toHaveBeenCalled();
  });

  it('returns none when page assist is turned off', async () => {
    await saveSettings(mergeSettings(DEFAULT_SETTINGS, { ai: { pageAssist: false } }));
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(request([candidate(0)]), HOST, { choose });

    expect(answer).toEqual({ index: null, source: 'none' });
    expect(choose).not.toHaveBeenCalled();
  });

  it('returns none when no key or model is configured', async () => {
    await saveSettings(
      mergeSettings(DEFAULT_SETTINGS, {
        ai: { openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: null } },
      }),
    );
    const choose = chooseReturning(selection());
    expect(await runPageAssist(request([candidate(0)]), HOST, { choose })).toEqual({
      index: null,
      source: 'none',
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it('returns none when the OpenRouter permission is missing', async () => {
    vi.stubGlobal('browser', createFakeBrowser().fake);
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(request([candidate(0)]), HOST, { choose });

    expect(answer).toEqual({ index: null, source: 'none' });
    expect(choose).not.toHaveBeenCalled();
  });
});

describe('page assist learned locators', () => {
  it('uses a unique learned signature without calling the model', async () => {
    await setMeta(pageAssistLearnedKey(HOST, 'applyButton'), [
      { tag: 'button', role: 'button', name: 'apply', hook: '' },
    ]);
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(
      request([candidate(0), candidate(1, { name: 'Sign in' })]),
      HOST,
      {
        choose,
      },
    );

    expect(answer).toEqual({ index: 0, source: 'learned', confidence: 1 });
    expect(choose).not.toHaveBeenCalled();
  });

  it('uses a learned signature without an OpenRouter key or permission', async () => {
    // Learned locators are local; only a model call needs a key and permission.
    await clearAiKey();
    await setMeta(pageAssistLearnedKey(HOST, 'applyButton'), [
      { tag: 'button', role: 'button', name: 'apply', hook: '' },
    ]);
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(request([candidate(0)]), HOST, {
      choose,
      hasPermission: async () => false,
    });

    expect(answer).toEqual({ index: 0, source: 'learned', confidence: 1 });
    expect(choose).not.toHaveBeenCalled();
  });

  it('falls back to the model when the learned signature is ambiguous', async () => {
    await setMeta(pageAssistLearnedKey(HOST, 'applyButton'), [
      { tag: 'button', role: 'button', name: 'apply', hook: '' },
    ]);
    const choose = chooseReturning(selection());

    const answer = await runPageAssist(request([candidate(0), candidate(1)]), HOST, { choose });

    expect(choose).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ index: 0, source: 'ai' });
  });

  it('stores the picked candidate signature for the next request', async () => {
    const choose = chooseReturning(selection({ index: 1 }));

    const first = await runPageAssist(
      request([
        candidate(0, { name: 'Apply' }),
        candidate(1, { name: 'Apply', attributes: attributes({ 'data-hook': 'apply-footer' }) }),
      ]),
      HOST,
      { choose },
    );
    expect(first).toMatchObject({ index: 1, source: 'ai' });

    const stored = (await getMeta<unknown>(pageAssistLearnedKey(HOST, 'applyButton'))) as Array<
      Record<string, unknown>
    >;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ tag: 'button', role: 'button', name: 'apply' });
    expect(stored[0]?.hook).toBe('apply-footer');

    const second = await runPageAssist(
      request([
        candidate(0, { name: 'Apply' }),
        candidate(1, { name: 'Apply', attributes: attributes({ 'data-hook': 'apply-footer' }) }),
      ]),
      HOST,
      { choose },
    );
    expect(choose).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ index: 1, source: 'learned', confidence: 1 });
  });
});

describe('page assist model answers', () => {
  it('returns none for an answer below the confidence threshold', async () => {
    const choose = chooseReturning(selection({ confidence: PAGE_ASSIST_MIN_CONFIDENCE - 0.01 }));
    const events: JobEvent[] = [];

    const answer = await runPageAssist(request([candidate(0)]), HOST, {
      choose,
      emit: (event) => events.push(event),
    });

    expect(answer).toEqual({ index: null, source: 'none' });
    expect(await getMeta(pageAssistLearnedKey(HOST, 'applyButton'))).toBeUndefined();
    expect(events.at(-1)?.type).toBe('page_assist.none');
  });

  it('returns none when the model answers -1', async () => {
    const choose = chooseReturning(selection({ index: null }));

    const answer = await runPageAssist(request([candidate(0)]), HOST, { choose });

    expect(answer).toEqual({ index: null, source: 'none' });
  });

  it('emits only target, confidence, model and cost — never candidate text', async () => {
    const choose = chooseReturning(selection({ index: 0 }));
    const events: JobEvent[] = [];

    await runPageAssist(
      request([candidate(0, { name: 'Apply at Secret Employer', text: 'Apply now' })]),
      HOST,
      { choose, emit: (event) => events.push(event) },
    );

    const aiEvent = events.find((event) => event.type === 'page_assist.ai');
    expect(aiEvent?.data).toEqual({
      target: 'applyButton',
      confidence: 0.9,
      model: 'deepseek/deepseek-v4.1-flash',
      cost: 0.000012,
    });
    expect(JSON.stringify(aiEvent)).not.toContain('Secret Employer');
  });

  it('degrades to none and logs an error when the provider fails', async () => {
    const choose = vi.fn(async () => {
      throw new Error(`provider exploded with ${KEY}`);
    });
    const events: JobEvent[] = [];

    const answer = await runPageAssist(request([candidate(0)]), HOST, {
      choose,
      emit: (event) => events.push(event),
    });

    expect(answer).toEqual({ index: null, source: 'none' });
    const errorEvent = events.find((event) => event.type === 'page_assist.error');
    expect(errorEvent?.data).toEqual({ target: 'applyButton' });
    expect(JSON.stringify(errorEvent)).not.toContain(KEY);
  });
});
