import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions } from '@/core/contracts';
import { applyToJob } from '@/handshake/applyFlow';
import { makeAnswer, makeDocument, makeJob } from '@/test/factories';

const job = makeJob({
  id: '900001',
  applyType: 'handshake_form',
  requiredDocumentTypes: ['resume'],
});
const options: ApplyOptions = {
  mode: 'autopilot',
  documents: { resumeId: 'doc-resume' },
  documentsAvailable: [makeDocument({ id: 'doc-resume', type: 'resume' })],
  answers: [],
  allowSensitiveAutoSubmit: false,
  allowEeoAutoFill: false,
  allowFreeTextAutoFill: false,
  reviewBeforeSubmit: false,
  stopOnUnknownQuestion: true,
  verifySubmissions: false,
  timeoutMs: 1000,
};

beforeEach(() => {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-form.html'),
    'utf8',
  );
  document.querySelector('button')?.addEventListener('click', () => {
    const dialog = document.getElementById('apply-dialog');
    if (dialog) dialog.hidden = false;
  });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('adversarial form changes', () => {
  it('does not submit a previously selected optional attachment that was never chosen in Settings', async () => {
    const label = document.createElement('label');
    label.textContent = 'Cover letter';
    const select = document.createElement('select');
    select.id = 'unconfigured-cover';
    label.htmlFor = select.id;
    const option = document.createElement('option');
    option.value = 'unconfigured-cover';
    option.textContent = 'Previous cover letter';
    select.append(option);
    label.append(select);
    document.querySelector('[role="dialog"]')?.append(label);
    const submit = vi.fn();
    document.querySelector('[data-testid="submit-application"]')?.addEventListener('click', submit);
    const result = await applyToJob(document, job, options, undefined, {
      needsReview: () => false,
      authorizeSubmit: async () => true,
    });
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.message).toMatch(/unconfigured cover letter/);
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not apply a bank approval to a similar question with negated wording', async () => {
    const label = document.createElement('label');
    label.textContent = 'Do you not own a vehicle?';
    const select = document.createElement('select');
    select.required = true;
    for (const [value, text] of [
      ['', 'Choose'],
      ['yes', 'Yes'],
      ['no', 'No'],
    ]) {
      const option = document.createElement('option');
      option.value = value ?? '';
      option.textContent = text ?? '';
      select.append(option);
    }
    label.append(select);
    document.querySelector('[role="dialog"]')?.append(label);
    const grant = vi.fn(async () => true);
    const result = await applyToJob(
      document,
      job,
      {
        ...options,
        answers: [
          makeAnswer({
            label: 'Do you own a vehicle?',
            aliases: [],
            type: 'select',
            value: 'yes',
            category: 'custom',
            sensitive: false,
            autoSubmitAllowed: true,
          }),
        ],
      },
      undefined,
      { needsReview: () => false, authorizeSubmit: grant },
    );
    expect(result.outcome).toBe('needs_input');
    expect(select.value).toBe('');
    expect(grant).not.toHaveBeenCalled();
  });
  it.each(['review', 'autopilot'] as const)(
    'never clicks an undeclared Apply action in %s',
    async (mode) => {
      document.body.innerHTML = '<main data-hook="job-details-page"><button>Apply</button></main>';
      const clicked = vi.fn();
      document.querySelector('button')?.addEventListener('click', clicked);
      const grant = vi.fn(async () => true);
      const result = await applyToJob(document, job, { ...options, mode }, undefined, {
        needsReview: () => false,
        authorizeSubmit: grant,
      });
      expect(result.outcome).toBe('manual_submit_required');
      expect(clicked).not.toHaveBeenCalled();
      expect(grant).not.toHaveBeenCalled();
    },
  );

  it.each(['navigation', 'document', 'new-question', 'unapproved-prefill'] as const)(
    'rechecks %s after the authorization await and never submits a changed form',
    async (change) => {
      let currentJob = true;
      const submit = vi.fn();
      document
        .querySelector('[data-testid="submit-application"]')
        ?.addEventListener('click', submit);
      const result = await applyToJob(document, job, options, undefined, {
        needsReview: () => false,
        isCurrentJob: () => currentJob,
        authorizeSubmit: async () => {
          if (change === 'navigation') currentJob = false;
          if (change === 'document') {
            const select = document.querySelector<HTMLSelectElement>('#resume-select');
            if (select) select.value = '';
          }
          if (change === 'new-question' || change === 'unapproved-prefill') {
            const label = document.createElement('label');
            label.textContent = 'Additional screening question';
            const input = document.createElement('input');
            input.required = change === 'new-question';
            input.value = change === 'unapproved-prefill' ? 'Unapproved answer' : '';
            label.append(input);
            document.querySelector('[role="dialog"]')?.append(label);
          }
          return true;
        },
      });
      expect(submit).not.toHaveBeenCalled();
      expect(['ready_for_review', 'needs_input', 'failed']).toContain(result.outcome);
      if (change === 'document') expect(result.error?.code).toBe('MISSING_DOCUMENT');
      if (change === 'new-question' || change === 'unapproved-prefill')
        expect(result.error?.code).toBe('UNKNOWN_QUESTION');
    },
  );

  it('selects Submit only inside the verified application dialog', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'Submit Application';
    const outsideClick = vi.fn();
    outside.addEventListener('click', outsideClick);
    document.body.prepend(outside);
    const insideClick = vi.fn();
    document
      .querySelector('[data-testid="submit-application"]')
      ?.addEventListener('click', insideClick);
    await applyToJob(document, job, options, undefined, {
      needsReview: () => false,
      authorizeSubmit: async () => true,
    });
    expect(outsideClick).not.toHaveBeenCalled();
    expect(insideClick).toHaveBeenCalledTimes(1);
  });
});
