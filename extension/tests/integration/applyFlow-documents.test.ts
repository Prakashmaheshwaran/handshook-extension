import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions, DocumentRecord } from '@/core/contracts';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { applyToJob } from '@/handshake/applyFlow';
import { makeJob } from '@/test/factories';
import { CancelledError } from '@/handshake/dom';

const RESUME: DocumentRecord = { id: 'doc-resume', type: 'resume', title: 'Resume 2026' };
const OTHER: DocumentRecord = { id: 'doc-other', type: 'resume', title: 'Other Resume' };
const COVER: DocumentRecord = { id: 'doc-cover', type: 'cover_letter', title: 'Cover Letter' };

function options(patch: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    mode: 'autopilot',
    documents: { resumeId: RESUME.id },
    documentsAvailable: [RESUME],
    answers: [],
    allowSensitiveAutoSubmit: false,
    allowEeoAutoFill: false,
    allowFreeTextAutoFill: false,
    reviewBeforeSubmit: false,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
    timeoutMs: 1_000,
    ...patch,
  };
}

function load(name: string): void {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply', name),
    'utf8',
  );
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element ${selector}`);
  return found;
}

function openForm(selector = 'button'): void {
  element(selector).addEventListener('click', () => {
    element('#apply-dialog').hidden = false;
  });
}

function confirm(): void {
  const banner = document.createElement('p');
  banner.setAttribute('role', 'status');
  banner.textContent = 'Application submitted';
  document.body.appendChild(banner);
}

async function apply(
  patch: Partial<ApplyOptions> = {},
  required: ('resume' | 'cover_letter')[] = ['resume'],
  control: ApplyControl = {
    authorizeSubmit: async () => true,
    needsReview: () => false,
  },
) {
  const pending = applyToJob(
    document,
    makeJob({ requiredDocumentTypes: required }),
    options(patch),
    undefined,
    control,
  );
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Quick Apply document preflight', () => {
  it('never clicks a different chosen resume and uses the advertised normal form', async () => {
    load('quick-apply-document-choice.html');
    const quickClick = vi.fn();
    element('#quick-apply').addEventListener('click', quickClick);
    openForm('#normal-apply');
    const submit = vi.fn(confirm);
    element('#submit').addEventListener('click', submit);

    const result = await apply({ documentsAvailable: [OTHER, RESUME] });

    expect(quickClick).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(element<HTMLSelectElement>('#resume-select').value).toBe(RESUME.id);
    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: [{ type: 'resume', id: RESUME.id }],
    });
  });

  it('routes a different Quick Apply resume to manual review when no form is offered', async () => {
    load('quick-apply-document-choice.html');
    element('#normal-apply').remove();
    const click = vi.fn();
    element('#quick-apply').addEventListener('click', click);

    const result = await apply({ documentsAvailable: [OTHER, RESUME] });

    expect(click).not.toHaveBeenCalled();
    expect(result.outcome).toBe('manual_submit_required');
    expect(result.confirmationText).toMatch(/one-click Apply.*submits immediately/i);
    expect(result.documentsUsed).toBeUndefined();
  });

  it('records profile defaults rather than claiming a selected ID after a one-click opt-in', async () => {
    load('quick-apply-document-choice.html');
    element<HTMLSelectElement>('#quick-resume').value = RESUME.id;
    const click = vi.fn(confirm);
    element('#quick-apply').addEventListener('click', click);

    const result = await apply({ documentsAvailable: [OTHER, RESUME], allowOneClickApply: true });

    expect(click).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: 'handshake_profile_defaults',
    });
  });

  it('requires opt-in even for a single-resume one-click and records profile defaults', async () => {
    load('quick-apply-single-click.html');
    element('button').addEventListener('click', confirm);
    const result = await apply({ allowOneClickApply: true });
    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: 'handshake_profile_defaults',
    });
  });

  it('does not claim documents were sent when one-click submit authorization is denied', async () => {
    load('quick-apply-single-click.html');
    const click = vi.fn();
    element('button').addEventListener('click', click);
    const authorizeSubmit = vi.fn(async () => false);
    const result = await apply({ allowOneClickApply: true }, ['resume'], {
      authorizeSubmit,
      needsReview: () => false,
    });
    expect(authorizeSubmit).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'manual_submit_required',
    });
    expect(result.documentsUsed).toBeUndefined();
  });

  it('requires review when multiple candidates have no visible selected-document evidence', async () => {
    load('quick-apply-single-click.html');
    const click = vi.fn();
    element('button').addEventListener('click', click);
    const result = await apply({ documentsAvailable: [RESUME, OTHER] });
    expect(result.outcome).toBe('manual_submit_required');
    expect(click).not.toHaveBeenCalled();
  });

  it('does not weaken Review mode even with a verified one-click document', async () => {
    load('quick-apply-single-click.html');
    const click = vi.fn();
    element('button').addEventListener('click', click);
    expect((await apply({ mode: 'review', reviewBeforeSubmit: false })).outcome).toBe(
      'manual_submit_required',
    );
    expect(click).not.toHaveBeenCalled();
  });

  it('does not silently omit a configured optional file from a one-click handoff', async () => {
    load('quick-apply-single-click.html');
    const click = vi.fn();
    element('button').addEventListener('click', click);
    const result = await apply({
      mode: 'review',
      documents: { resumeId: RESUME.id, coverLetterId: COVER.id },
      documentsAvailable: [RESUME, COVER],
    });
    expect(result.outcome).toBe('manual_submit_required');
    expect(result.confirmationText).toContain('chosen cover letter');
    expect(click).not.toHaveBeenCalled();
  });
});

describe('exact and verified document selection', () => {
  it('fails a missing explicit ID instead of falling back to another resume', async () => {
    load('handshake-form.html');
    openForm();
    const result = await apply({ documents: { resumeId: 'missing-resume' } });
    expect(result).toMatchObject({
      outcome: 'needs_input',
      documentsUsed: [],
      missingDocumentTypes: ['resume'],
    });
    expect(result.error?.message).toBe(
      'Your resume (ID missing-resume) is not a valid Handshake document link or ID.',
    );
    expect(element<HTMLSelectElement>('#resume-select').value).toBe('');
  });

  it('rejects a chosen ID of the wrong document type', async () => {
    load('handshake-form.html');
    openForm();
    const result = await apply({
      documents: { resumeId: COVER.id },
      documentsAvailable: [RESUME, COVER],
    });
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.message).toMatch(/has type cover letter, not resume/);
    expect(result.documentsUsed).toEqual([]);
  });

  it('fails when the cached chosen file is absent on the page even with the same title', async () => {
    load('handshake-form.html');
    openForm();
    element<HTMLOptionElement>('option[value="doc-resume"]').value = 'different-id';
    const result = await apply();
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.message).toBe(
      "Your resume (Resume 2026) is not offered in this application's picker",
    );
    expect(result.documentsUsed).toEqual([]);
  });

  it('selects an unnamed record by ID when the picker exposes that ID', async () => {
    load('handshake-form.html');
    openForm();
    const unnamed: DocumentRecord = { id: 'doc-resume', type: 'resume', title: '' };
    const result = await apply({
      documents: { resumeId: unnamed.id },
      documentsAvailable: [unnamed],
      reviewBeforeSubmit: true,
    });
    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: unnamed.id }]);
    expect(element<HTMLSelectElement>('#resume-select').value).toBe(unnamed.id);
  });

  it('selects a duplicate-title combobox option by exact ID and clicks it once', async () => {
    load('document-combobox.html');
    openForm('#open');
    const picker = element('#resume-picker');
    picker.addEventListener('click', () => {
      element('#resume-options').hidden = false;
    });
    const chosenClick = vi.fn(() => {
      picker.setAttribute('data-value', RESUME.id);
      picker.textContent = RESUME.title;
      element('#resume-options').hidden = true;
    });
    element('[data-value="doc-resume"]').addEventListener('click', chosenClick);
    const otherClick = vi.fn();
    element('[data-value="doc-other"]').addEventListener('click', otherClick);
    const result = await apply({
      reviewBeforeSubmit: true,
      documentsAvailable: [RESUME, { ...OTHER, title: RESUME.title }],
    });
    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(chosenClick).toHaveBeenCalledTimes(1);
    expect(otherClick).not.toHaveBeenCalled();
  });

  it('treats a combobox verification timeout as failure despite the title in its options', async () => {
    load('document-combobox.html');
    openForm('#open');
    element('#resume-picker').addEventListener('click', () => {
      element('#resume-options').hidden = false;
    });
    const submit = vi.fn();
    element('#submit').addEventListener('click', submit);
    const result = await apply();
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.message).toContain('Could not verify chosen resume');
    expect(result.documentsUsed).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'requires a committed document ID after search selection: committed=%s',
    async (committed) => {
      load('document-combobox.html');
      openForm('#open');
      const original = element('#resume-picker');
      const input = document.createElement('input');
      input.id = original.id;
      input.type = 'text';
      input.placeholder = 'Search resumes';
      original.replaceWith(input);
      const backing = document.createElement('input');
      backing.type = 'hidden';
      backing.name = 'resume_id';
      input.after(backing);
      input.addEventListener('click', () => {
        element('#resume-options').hidden = false;
      });
      element('[data-value="doc-resume"]').addEventListener('click', () => {
        if (committed) backing.value = RESUME.id;
        element('#resume-options').hidden = true;
      });

      const result = await apply({ reviewBeforeSubmit: true });
      expect(result.outcome).toBe(committed ? 'ready_for_review' : 'needs_input');
      expect(result.documentsUsed).toEqual(committed ? [{ type: 'resume', id: RESUME.id }] : []);
    },
  );

  it('rejects title-only duplicate options instead of guessing a document ID', async () => {
    load('document-combobox.html');
    openForm('#open');
    element('#resume-picker').addEventListener('click', () => {
      element('#resume-options').hidden = false;
    });
    for (const option of document.querySelectorAll('[role="option"]'))
      option.removeAttribute('data-value');
    const result = await apply({ documentsAvailable: [RESUME, { ...OTHER, title: RESUME.title }] });
    expect(result.outcome).toBe('needs_input');
    expect(result.documentsUsed).toEqual([]);
  });

  it('records optional-picker errors and verified files and stops before submission', async () => {
    load('handshake-form-optional-docs.html');
    openForm();
    element<HTMLOptionElement>('option[value="doc-cover"]').remove();
    const submit = vi.fn();
    element('[data-testid="submit-application"]').addEventListener('click', submit);
    const result = await apply({
      documents: { resumeId: RESUME.id, coverLetterId: COVER.id },
      documentsAvailable: [RESUME, COVER],
    });
    expect(result.outcome).toBe('needs_input');
    expect(result.missingDocumentTypes).toEqual(['cover_letter']);
    expect(result.error?.details?.documentWarnings).toEqual([
      "Your cover letter (Cover Letter) is not offered in this application's picker",
    ]);
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('selects an aria-labelled optional picker without drifting to the preceding resume control', async () => {
    load('handshake-form-optional-docs.html');
    openForm();
    element('label[for="cover-select"]').remove();
    element('#cover-select').setAttribute('aria-label', 'Cover letter');
    const result = await apply({
      reviewBeforeSubmit: true,
      documents: { resumeId: RESUME.id, coverLetterId: COVER.id },
      documentsAvailable: [RESUME, COVER],
    });
    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual([
      { type: 'resume', id: RESUME.id },
      { type: 'cover_letter', id: COVER.id },
    ]);
  });

  it('does not verify a native picker that retains an extra selected file', async () => {
    load('handshake-form.html');
    openForm();
    const select = element<HTMLSelectElement>('#resume-select');
    select.multiple = true;
    const extra = document.createElement('option');
    extra.value = OTHER.id;
    extra.textContent = OTHER.title;
    select.appendChild(extra);
    select.addEventListener('change', () => {
      extra.selected = true;
    });
    const result = await apply();
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.message).toContain('Could not verify chosen resume');
    expect(result.documentsUsed).toEqual([]);
  });

  it('retains a sensible default only when the user did not choose a document', async () => {
    load('handshake-form.html');
    openForm();
    const result = await apply({ documents: {}, reviewBeforeSubmit: true });
    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
  });

  it('propagates cancellation while a missing document option is loading', async () => {
    load('handshake-form.html');
    openForm();
    element<HTMLOptionElement>('option[value="doc-resume"]').remove();
    const controller = new AbortController();
    const pending = applyToJob(document, makeJob(), options(), controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(CancelledError);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
  });
});
