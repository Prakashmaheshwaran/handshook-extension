import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions } from '@/core/contracts';
import { applyResultSchema } from '@/core/contracts';
import { ONE_CLICK_APPLY_REVIEW_REASON } from '@/core/documents/selection';
import { hasPositiveSubmissionEvidence } from '@/core/contracts/submitAuthorization';
import { applyToJob } from '@/handshake/applyFlow';
import { CancelledError, WaitTimeoutError } from '@/handshake/dom';
import { detectJobPageState, inspectJob } from '@/handshake/jobDetails';
import {
  confirmationBaseline,
  detectAlreadyApplied,
  detectConfirmation,
  findApplyButton,
  waitForJobPageReady,
} from '@/handshake/verification';
import { makeJob } from '@/test/factories';

// This suite drives every fallback the flow has; page assist stays out of it.
vi.mock('@/handshake/page-assist', () => ({ assistLocate: async () => null }));

function fixture(name: string): string {
  return readFileSync(resolve('tests/fixtures/ux-6', name), 'utf8');
}
const job = makeJob({ requiredDocumentTypes: ['resume'], applyType: 'handshake_form' });
const options: ApplyOptions = {
  mode: 'autopilot',
  allowOneClickApply: true,
  reviewBeforeSubmit: false,
  documents: { resumeId: 'chosen-resume' },
  documentsAvailable: [
    { id: 'chosen-resume', type: 'resume', title: 'Chosen resume' },
    { id: 'profile-default', type: 'resume', title: 'Profile default', isDefault: true },
  ],
  answers: [],
  allowSensitiveAutoSubmit: false,
  allowEeoAutoFill: false,
  allowFreeTextAutoFill: false,
  stopOnUnknownQuestion: true,
  verifySubmissions: true,
  timeoutMs: 1_000,
};

function button(): HTMLElement {
  const found = document.querySelector<HTMLElement>('button');
  if (!found) throw new Error('Missing fixture action');
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = fixture('job-one-click.html');
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('live-shaped one-click Apply policy', () => {
  it.each([
    ['review', false],
    ['review', true],
    ['autopilot', false],
    ['autopilot', true],
  ] as const)(
    'requires a missing resume before a handoff or send (mode=%s, opt-in=%s)',
    async (mode, allowOneClickApply) => {
      const click = vi.fn();
      button().addEventListener('click', click);
      const authorizeSubmit = vi.fn(async () => true);
      const result = await applyToJob(
        document,
        job,
        { ...options, mode, allowOneClickApply, documents: {}, documentsAvailable: [] },
        undefined,
        { authorizeSubmit, needsReview: () => false },
      );
      expect(result).toMatchObject({
        outcome: 'needs_input',
        missingDocumentTypes: ['resume'],
        error: { code: 'MISSING_DOCUMENT' },
      });
      expect(authorizeSubmit).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    },
  );

  it('rechecks missing files after the asynchronous grant without claiming chosen IDs were sent', async () => {
    const click = vi.fn();
    button().addEventListener('click', click);
    const snapshot = { ...options };
    const result = await applyToJob(document, job, snapshot, undefined, {
      needsReview: () => false,
      authorizeSubmit: async () => {
        snapshot.documentsAvailable = [];
        return true;
      },
    });
    expect(result).toMatchObject({ outcome: 'needs_input', missingDocumentTypes: ['resume'] });
    expect(result.documentsUsed).toEqual([]);
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['Apply', 'Quick apply'])(
    '%s requires an opt-in, unrestricted Autopilot, and a last-moment grant',
    async (label) => {
      button().textContent = label;
      for (const patch of [
        { mode: 'review' as const },
        { reviewBeforeSubmit: true },
        { allowOneClickApply: false },
        { allowOneClickApply: undefined },
      ]) {
        const click = vi.fn();
        button().addEventListener('click', click, { once: true });
        const authorizeSubmit = vi.fn(async () => true);
        const result = await applyToJob(document, job, { ...options, ...patch }, undefined, {
          authorizeSubmit,
          needsReview: () => false,
        });
        expect(result).toMatchObject({
          outcome: 'manual_submit_required',
          confirmationText: ONE_CLICK_APPLY_REVIEW_REASON,
        });
        expect(authorizeSubmit).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
        button().removeEventListener('click', click);
      }
      const authorizeSubmit = vi.fn(async () => true);
      const click = vi.fn(() => {
        document.body.innerHTML = fixture('job-applied.html');
      });
      button().addEventListener('click', click);
      const result = await applyToJob(document, job, options, undefined, {
        authorizeSubmit,
        needsReview: () => false,
      });
      expect(result).toMatchObject({
        outcome: 'applied',
        documentsUsed: 'handshake_profile_defaults',
      });
      expect(applyResultSchema.parse(result)).toEqual(result);
      expect(hasPositiveSubmissionEvidence(result)).toBe(true);
      expect(authorizeSubmit).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      // Re-entering a completed job never replays a send.
      expect((await applyToJob(document, job, options)).outcome).toBe('already_applied');
      expect(click).toHaveBeenCalledTimes(1);
    },
  );

  it('dry run does not authorize or click even with the opt-in enabled', async () => {
    const click = vi.fn();
    button().addEventListener('click', click);
    expect((await applyToJob(document, job, { ...options, mode: 'dry_run' })).outcome).toBe(
      'would_apply',
    );
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['cover_letter', 'transcript', 'other'] as const)(
    'never one-clicks a job requiring %s in Review mode even when that file is chosen',
    async (type) => {
      const click = vi.fn();
      button().addEventListener('click', click);
      const result = await applyToJob(
        document,
        { ...job, requiredDocumentTypes: ['resume', type] },
        {
          ...options,
          mode: 'review',
          documents: {
            ...options.documents,
            coverLetterId: 'cover',
            transcriptId: 'transcript',
            otherDocumentId: 'other',
          },
          documentsAvailable: [
            ...(options.documentsAvailable ?? []),
            ...(['cover_letter', 'transcript', 'other'] as const).map((type) => ({
              id: type === 'cover_letter' ? 'cover' : type,
              type,
              title: 'Fixture file',
            })),
          ],
        },
      );
      expect(result.outcome).toBe('manual_submit_required');
      expect(click).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['coverLetterId', 'cover_letter'],
    ['transcriptId', 'transcript'],
    ['otherDocumentId', 'other'],
  ] as const)('does not silently omit an optional chosen %s in Review mode', async (key, type) => {
    const click = vi.fn();
    button().addEventListener('click', click);
    const result = await applyToJob(document, job, {
      ...options,
      mode: 'review',
      documents: { ...options.documents, [key]: 'fixture-file' },
      documentsAvailable: [
        ...(options.documentsAvailable ?? []),
        { id: 'fixture-file', type, title: 'Fixture attachment' },
      ],
    });
    expect(result.outcome).toBe('manual_submit_required');
    expect(result.confirmationText).toContain('chosen');
    expect(click).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'blocks known screening questions in Review mode even when answered=%s',
    async (answered) => {
      if (!answered)
        document
          .querySelector('main')
          ?.insertAdjacentHTML(
            'beforeend',
            '<label for="screen">Why this job?</label><textarea id="screen"></textarea>',
          );
      const click = vi.fn();
      button().addEventListener('click', click);
      const result = await applyToJob(document, job, {
        ...options,
        mode: 'review',
        explicitAnswerIds: answered ? ['known-answer'] : [],
      });
      expect(result.outcome).toBe('manual_submit_required');
      expect(result.confirmationText).toContain('screening questions');
      expect(click).not.toHaveBeenCalled();
    },
  );

  it.each(['denied', 'throws', 'revoked', 'navigated', 'changed-opt-in'])(
    'does not click after authorization is %s',
    async (caseName) => {
      let revoked = false;
      let current = true;
      const snapshot = { ...options };
      const click = vi.fn();
      button().addEventListener('click', click);
      const result = await applyToJob(document, job, snapshot, undefined, {
        needsReview: () => revoked,
        isCurrentJob: () => current,
        authorizeSubmit: async () => {
          if (caseName === 'throws') throw new Error('Fixture grant unavailable');
          if (caseName === 'revoked') revoked = true;
          if (caseName === 'navigated') current = false;
          if (caseName === 'changed-opt-in') snapshot.allowOneClickApply = false;
          return caseName !== 'denied';
        },
      });
      expect(result.outcome).toBe('manual_submit_required');
      if (caseName !== 'changed-opt-in')
        expect(result.confirmationText).toContain('Automatic submission was not authorized');
      expect(click).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'keeps a send without positive evidence verifying (wait=%s)',
    async (verifySubmissions) => {
      const click = vi.fn();
      button().addEventListener('click', click);
      const beforeSubmit = vi.fn();
      const pending = applyToJob(document, job, { ...options, verifySubmissions }, undefined, {
        authorizeSubmit: async () => {
          document.body.insertAdjacentHTML('beforeend', fixture('submitted-toast.html'));
          return true;
        },
        needsReview: () => false,
        beforeSubmit,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        outcome: 'verifying',
        documentsUsed: 'handshake_profile_defaults',
      });
      expect(beforeSubmit).toHaveBeenCalledWith(expect.arrayContaining(['application submitted']));
      expect(click).toHaveBeenCalledTimes(1);
    },
  );

  it('never retries after cancellation following the one-click send', async () => {
    const controller = new AbortController();
    const click = vi.fn(() => controller.abort());
    button().addEventListener('click', click);
    const result = await applyToJob(document, job, options, controller.signal, {
      authorizeSubmit: async () => true,
      needsReview: () => false,
    });
    expect(result).toMatchObject({
      outcome: 'verifying',
      documentsUsed: 'handshake_profile_defaults',
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('does not verify a send using a banner on a different job route', async () => {
    let current = true;
    const click = vi.fn(() => {
      current = false;
      document.body.innerHTML = fixture('job-applied.html');
    });
    button().addEventListener('click', click);
    const pending = applyToJob(document, job, options, undefined, {
      authorizeSubmit: async () => true,
      needsReview: () => false,
      isCurrentJob: () => current,
    });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      outcome: 'verifying',
      documentsUsed: 'handshake_profile_defaults',
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it.each(['closed', 'external', 'disabled'])(
    'rechecks the page action after an asynchronous grant: %s',
    async (state) => {
      const click = vi.fn();
      button().addEventListener('click', click);
      const result = await applyToJob(document, job, options, undefined, {
        needsReview: () => false,
        authorizeSubmit: async () => {
          if (state === 'closed')
            document
              .querySelector('main')
              ?.insertAdjacentHTML('beforeend', '<p role="status">This job is closed</p>');
          if (state === 'external') button().textContent = 'Apply externally';
          if (state === 'disabled') button().setAttribute('disabled', '');
          return true;
        },
      });
      expect(result.outcome).toBe(state === 'closed' ? 'failed' : 'manual_submit_required');
      expect(click).not.toHaveBeenCalled();
    },
  );
});

describe('live applied state and new evidence', () => {
  it('recognizes the persistent banner on load without clicking or reading the API', async () => {
    document.body.innerHTML = fixture('job-applied.html');
    const click = vi.fn();
    button().addEventListener('click', click);
    const fetcher = vi.fn<typeof fetch>();
    await waitForJobPageReady(document);
    expect(detectAlreadyApplied(document)).toBe(true);
    expect(detectJobPageState(document)).toBe('applied');
    expect(findApplyButton(document)).toBeNull();
    expect((await applyToJob(document, job, options)).outcome).toBe('already_applied');
    await expect(inspectJob(document, job.host, job.id, fetcher)).rejects.toMatchObject({
      code: 'ALREADY_APPLIED',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['heading', 'withdraw', 'toast'] as const)(
    'accepts new %s evidence and excludes its stale baseline',
    (kind) => {
      const baselineTexts = confirmationBaseline(document);
      if (kind === 'toast')
        document.body.insertAdjacentHTML('beforeend', fixture('submitted-toast.html'));
      else {
        document.body.innerHTML = fixture('job-applied.html');
        if (kind === 'heading') {
          document.querySelector('.rosetta-banner button')?.remove();
          document
            .querySelector('h2')
            ?.after(document.createTextNode('Fixture explanation. '.repeat(40)));
        } else document.querySelector('h2')?.remove();
      }
      expect(detectConfirmation(document, { baselineTexts }).applied).toBe(true);
      if (kind !== 'toast') expect(detectAlreadyApplied(document)).toBe(true);
      expect(
        detectConfirmation(document, { baselineTexts: confirmationBaseline(document) }).applied,
      ).toBe(false);
    },
  );

  it('does not call a disabled Apply alone a successful application', () => {
    button().setAttribute('disabled', '');
    button().setAttribute('aria-disabled', 'true');
    expect(detectConfirmation(document).applied).toBe(false);
    expect(detectAlreadyApplied(document)).toBe(false);
  });

  it('ignores applied copy in descriptions and invisible sticky areas', () => {
    document.body.innerHTML = `<main data-hook="job-details-page"><section aria-label="Job description">${fixture('job-applied.html')}</section><div style="opacity: 0">${fixture('job-applied.html')}</div></main>`;
    expect(detectConfirmation(document).applied).toBe(false);
    expect(detectAlreadyApplied(document)).toBe(false);
    expect(detectJobPageState(document)).toBeNull();
  });
});

describe('direct inspection readiness and abort', () => {
  it('waits for the action area before reading details or fetching', async () => {
    document.body.innerHTML = '<main data-hook="job-details-page"><h1>Loading</h1></main>';
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 403 }));
    const pending = inspectJob(document, job.host, job.id, fetcher, { timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).not.toHaveBeenCalled();
    document.body.innerHTML = fixture('job-one-click.html');
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).title).toBe('Software Engineer Intern');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds a direct inspection with no actions and makes no API call', async () => {
    document.body.innerHTML = '<main data-hook="job-details-page"><h1>Loading</h1></main>';
    const fetcher = vi.fn<typeof fetch>();
    const pending = inspectJob(document, job.host, job.id, fetcher, { timeoutMs: 1_000 });
    const rejected = expect(pending).rejects.toBeInstanceOf(WaitTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['before-readiness', 'during-fetch'])(
    'aborts %s without returning a job',
    async (phase) => {
      const controller = new AbortController();
      if (phase === 'before-readiness')
        document.body.innerHTML = '<main data-hook="job-details-page"></main>';
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        return new Response('', { status: 403 });
      });
      const pending = inspectJob(document, job.host, job.id, fetcher, {
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(CancelledError);
      if (phase === 'before-readiness') controller.abort();
      await rejected;
      if (phase === 'before-readiness') expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
