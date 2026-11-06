import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions, Job } from '@/core/contracts';
import { applyToJob } from '@/handshake/applyFlow';
import { CancelledError } from '@/handshake/dom';
import { getSelectorHealth, resetSelectorHealth } from '@/handshake/health';
import { classifyApplyType, detectJobPageState } from '@/handshake/jobDetails';
import { findFirstStrategy } from '@/handshake/health';
import { describeJobActionArea, jobSelectors } from '@/handshake/selectors/job';
import { findApplyButton, waitForJobPageReady } from '@/handshake/verification';

const job: Job = {
  id: '90000000',
  host: 'app.joinhandshake.com',
  url: 'https://app.joinhandshake.com/jobs/90000000',
  title: 'Synthetic role',
  employer: 'Synthetic employer',
  description: '',
  applyType: 'quick_apply',
  requiredDocumentTypes: ['resume'],
  source: 'search',
  discoveredAt: 0,
};
const options: ApplyOptions = {
  mode: 'review',
  documents: { resumeId: 'fixture-resume' },
  documentsAvailable: [{ id: 'fixture-resume', type: 'resume', title: 'Synthetic document' }],
  answers: [],
  allowSensitiveAutoSubmit: false,
  allowEeoAutoFill: false,
  allowFreeTextAutoFill: false,
  reviewBeforeSubmit: true,
  stopOnUnknownQuestion: true,
  verifySubmissions: true,
  timeoutMs: 15_000,
};

function load(name = 'job-late-actions.html'): void {
  document.body.innerHTML = readFileSync(resolve('tests/fixtures/ux-1', name), 'utf8');
}

function render(): void {
  const root = document.querySelector('[data-hook="job-details-page"]');
  const template = document.querySelector<HTMLTemplateElement>('#job-content');
  if (!root || !template) throw new Error('Missing fixture root/template');
  root.replaceChildren(template.content.cloneNode(true));
  root.setAttribute('aria-busy', 'false');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSelectorHealth();
  load();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('late job action readiness', () => {
  it('finds the action rendered after two seconds and preserves Review one-click safety', async () => {
    const click = vi.fn();
    document.addEventListener('click', click, { once: true });
    let settled = false;
    const pending = applyToJob(document, job, options).then((result) => {
      settled = true;
      return result;
    });
    setTimeout(render, 2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ outcome: 'manual_submit_required' });
    expect(findApplyButton(document)?.element).toBe(document.querySelector('.primary-action'));
    expect(click).not.toHaveBeenCalled();
    document.removeEventListener('click', click);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports UI_CHANGED only after the entire readiness bound and records the action outline', async () => {
    render();
    document.querySelectorAll('[aria-label="Quick apply"]').forEach((button) => button.remove());
    let settled = false;
    const pending = applyToJob(document, job, options).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(getSelectorHealth()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ outcome: 'failed', error: { code: 'UI_CHANGED' } });
    expect(getSelectorHealth()).toEqual([
      expect.objectContaining({
        selector: 'job.readiness',
        strategy: 'dom:action-area',
        ok: false,
        detail: JSON.stringify(describeJobActionArea(document)),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts cleanly during readiness without a click or a UI_CHANGED diagnostic', async () => {
    const controller = new AbortController();
    const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
    const pending = applyToJob(document, job, options, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(CancelledError);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await rejected;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getSelectorHealth()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wakes on a mutation before a background-throttled poll could run', async () => {
    let ready = false;
    const pending = waitForJobPageReady(document, { intervalMs: 60_000 }).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    render();
    await pending;
    expect(ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires the job root as well as an action, ignoring unrelated page chrome', async () => {
    document.body.innerHTML = '<button>Quick apply</button>';
    let ready = false;
    const pending = waitForJobPageReady(document).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(ready).toBe(false);
    load();
    render();
    await pending;
    expect(ready).toBe(true);
  });

  it.each([
    ['applied', 'You applied on a prior date', 'already_applied', undefined],
    ['closed', 'This job is closed', 'failed', 'JOB_CLOSED'],
    ['not_open', 'Applications are not yet open', 'waiting', 'NOT_OPEN'],
  ])(
    'recognizes a late %s status without waiting for an Apply control',
    async (state, copy, outcome, code) => {
      const pending = applyToJob(document, job, options);
      setTimeout(() => {
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.textContent = copy ?? '';
        document.querySelector('main')?.append(status);
      }, 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(detectJobPageState(document)).toBe(state);
      const result = await pending;
      expect(result.outcome).toBe(outcome);
      expect(result.error?.code).toBe(code);
    },
  );

  it('does not wait on a replacement login page', async () => {
    document.body.innerHTML = '<h1>Sign in to Handshake</h1><input type="password">';
    expect(await applyToJob(document, job, options)).toMatchObject({
      error: { code: 'AUTH_REQUIRED' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('live-shaped Rosetta actions', () => {
  it.each(['Quick apply', 'QUICK APPLY', 'quick apply', 'QuIcK ApPlY'])(
    'classifies %s and ignores the invisible sticky clone',
    (label) => {
      render();
      const primary = document.querySelector('.primary-action');
      primary?.setAttribute('aria-label', label);
      expect(findApplyButton(document)).toMatchObject({ type: 'quick_apply', element: primary });
      expect(classifyApplyType(document)).toBe('quick_apply');
      expect(findFirstStrategy(jobSelectors.applyButton, document)).toBe(primary);
    },
  );

  it('prefers the visible primary over an earlier secondary Apply action', () => {
    render();
    const secondary = document.createElement('button');
    secondary.textContent = 'Apply';
    secondary.setAttribute('data-variant', 'secondary');
    document.querySelector('main')?.prepend(secondary);
    expect(findApplyButton(document)?.element).toBe(document.querySelector('.primary-action'));
    expect(findFirstStrategy(jobSelectors.applyButton, document)).toBe(
      document.querySelector('.primary-action'),
    );
  });

  it('ignores every matching action when it is inside an opacity-zero ancestor', () => {
    render();
    document.querySelector('.primary-action')?.remove();
    expect(findApplyButton(document)).toBeNull();
    expect(classifyApplyType(document)).toBe('unknown');
    expect(findFirstStrategy(jobSelectors.applyButton, document)).toBeNull();
  });

  it.each(['Apply externally', 'Apply on the employer website'])(
    'preserves the known external pattern %s without clicking',
    async (label) => {
      load('job-external-rosetta.html');
      const primary = document.querySelector('.primary-action');
      primary?.setAttribute('aria-label', label);
      if (primary) primary.textContent = label;
      const click = vi.fn();
      primary?.addEventListener('click', click);
      expect(findApplyButton(document)).toMatchObject({ type: 'external', element: primary });
      expect(classifyApplyType(document)).toBe('external');
      expect(await applyToJob(document, job, options)).toMatchObject({ outcome: 'external' });
      expect(click).not.toHaveBeenCalled();
    },
  );
});
