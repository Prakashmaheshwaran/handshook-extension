import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions, DocumentRecord, Job } from '@/core/contracts';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { ONE_CLICK_APPLY_REVIEW_REASON } from '@/core/documents/selection';
import { applyToJob } from '@/handshake/applyFlow';
import { assistLocate } from '@/handshake/page-assist';
import { makeJob } from '@/test/factories';

// Page assist is a last resort; every test states whether it may be used.
vi.mock('@/handshake/page-assist', () => ({ assistLocate: vi.fn(async () => null) }));
const assist = vi.mocked(assistLocate);

const RESUME: DocumentRecord = { id: 'doc-resume', type: 'resume', title: 'Resume 2026' };
const OTHER_RESUME: DocumentRecord = {
  id: 'doc-other',
  type: 'resume',
  title: 'Other Resume',
};
const COVER: DocumentRecord = {
  id: 'doc-cover',
  type: 'cover_letter',
  title: 'Cover Letter 2026',
};

const bothDocumentsJob = makeJob({
  applyType: 'handshake_form',
  requiredDocumentTypes: ['resume', 'cover_letter'],
});
const resumeJob = makeJob({ applyType: 'handshake_form', requiredDocumentTypes: ['resume'] });

function options(patch: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    mode: 'autopilot',
    allowOneClickApply: true,
    reviewBeforeSubmit: false,
    documents: { resumeId: RESUME.id, coverLetterId: COVER.id },
    documentsAvailable: [RESUME, COVER],
    answers: [],
    allowSensitiveAutoSubmit: false,
    allowEeoAutoFill: false,
    allowFreeTextAutoFill: false,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
    timeoutMs: 1_000,
    ...patch,
  };
}

const resumeOnly = (patch: Partial<ApplyOptions> = {}): Partial<ApplyOptions> => ({
  documents: { resumeId: RESUME.id },
  documentsAvailable: [RESUME],
  ...patch,
});

const grant = (): ApplyControl & { authorizeSubmit: ReturnType<typeof vi.fn> } => ({
  authorizeSubmit: vi.fn(async () => true),
  needsReview: () => false,
});

function load(): void {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-dialog-attach.html'),
    'utf8',
  );
}

function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element ${selector}`);
  return found;
}

/** The live page: a plain Apply whose click opens the application dialog. */
function openDialog(): void {
  el('#apply').addEventListener('click', () => {
    el('#apply-dialog').hidden = false;
  });
}

/** The live cover-letter picker: click opens options, a choice shows a card. */
function wireCoverSearch(): void {
  const input = el('#cover-search');
  input.addEventListener('click', () => {
    el('#cover-options').hidden = false;
  });
  for (const option of Array.from(
    document.querySelectorAll<HTMLElement>('#cover-options [role="option"]'),
  )) {
    option.addEventListener('click', () => {
      const id = option.getAttribute('data-document-id') ?? '';
      const card = el('#cover-card');
      card.setAttribute('data-document-id', id);
      card.querySelector('a')?.setAttribute('href', `/docs/${id}`);
      el('#cover-options').hidden = true;
      input.hidden = true;
      card.hidden = false;
    });
  }
}

/** × clears the resume card and reveals the picker; a choice fills the card. */
function wireResumeReplacement(): ReturnType<typeof vi.fn> {
  const card = el('#resume-card');
  const remove = vi.fn(() => {
    card.hidden = true;
    el('#resume-picker').hidden = false;
  });
  card.querySelector('button')?.addEventListener('click', remove);
  el('#resume-search').addEventListener('click', () => {
    el('#resume-options').hidden = false;
  });
  for (const option of Array.from(
    document.querySelectorAll<HTMLElement>('#resume-options [role="option"]'),
  )) {
    option.addEventListener('click', () => {
      const id = option.getAttribute('data-document-id') ?? '';
      card.setAttribute('data-document-id', id);
      card.querySelector('a')?.setAttribute('href', `/docs/${id}`);
      el('#resume-options').hidden = true;
      el('#resume-picker').hidden = true;
      card.hidden = false;
    });
  }
  return remove;
}

function clickToConfirm(selector = '[data-testid="submit-application"]'): ReturnType<typeof vi.fn> {
  const click = vi.fn(() => {
    const banner = document.createElement('p');
    banner.setAttribute('role', 'status');
    banner.textContent = 'Application submitted';
    document.body.appendChild(banner);
  });
  el(selector).addEventListener('click', click);
  return click;
}

async function run(
  control: ApplyControl = grant(),
  patch: Partial<ApplyOptions> = {},
  targetJob: Job = bothDocumentsJob,
) {
  const pending = applyToJob(document, targetJob, options(patch), undefined, control);
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  assist.mockReset();
  assist.mockResolvedValue(null);
  load();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('retries Submit once when the first click does not register', async () => {
  openDialog();
  wireCoverSearch();
  const clicks = vi.fn();
  el('[data-testid="submit-application"]').addEventListener('click', () => {
    clicks();
    // The live failure: the first click is swallowed and the form stays open.
    if (clicks.mock.calls.length === 1) return;
    const banner = document.createElement('p');
    banner.setAttribute('role', 'status');
    banner.textContent = 'Application submitted';
    document.body.appendChild(banner);
  });

  const result = await run(grant(), { timeoutMs: 10_000 }, bothDocumentsJob);

  expect(clicks.mock.calls.length).toBe(2);
  expect(result.outcome).toBe('applied');
}, 20_000);

describe('Autopilot applies through the live-shaped document dialog', () => {
  it.each([false, true])(
    'preserves a brief missing-resume rejection despite an attached card (dialog closes=%s)',
    async (closes) => {
      openDialog();
      const submit = vi.fn(() => {
        setTimeout(() => {
          el('#apply-dialog').hidden = closes;
          const alert = document.createElement('p');
          alert.setAttribute('role', 'alert');
          alert.textContent = 'Documents must include a Resume';
          document.body.append(alert);
          setTimeout(() => alert.remove(), 200);
        }, 100);
      });
      el('[data-testid="submit-application"]').addEventListener('click', submit);

      const result = await run(grant(), resumeOnly({ timeoutMs: 10_000 }), resumeJob);

      expect(result).toMatchObject({
        outcome: 'needs_input',
        missingDocumentTypes: ['resume'],
        error: { code: 'MISSING_DOCUMENT', message: 'documents must include a resume' },
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(el('#resume-card').getAttribute('data-document-id')).toBe(RESUME.id);
    },
  );

  it('preserves a brief permission rejection without clicking Submit again', async () => {
    openDialog();
    const submit = vi.fn(() => {
      setTimeout(() => {
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'You do not have permission to apply';
        document.body.append(alert);
        setTimeout(() => alert.remove(), 200);
      }, 100);
    });
    el('[data-testid="submit-application"]').addEventListener('click', submit);

    const result = await run(grant(), resumeOnly({ timeoutMs: 10_000 }), resumeJob);

    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'FORBIDDEN' } });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('clicks Apply, verifies the preselected resume card by ID, chooses the cover letter, and submits once', async () => {
    openDialog();
    wireCoverSearch();
    const submit = clickToConfirm();
    const upload = vi.fn();
    el('#upload-cover').addEventListener('click', upload);
    const control = grant();

    const result = await run(control);

    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: [
        { type: 'resume', id: RESUME.id },
        { type: 'cover_letter', id: COVER.id },
      ],
    });
    expect(result.confirmationText).toMatch(/application submitted/i);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    // A fresh grant for the Apply click (it may submit) and another for Submit.
    expect(control.authorizeSubmit).toHaveBeenCalledTimes(2);
    // Deterministic selectors found every control; the AI was never asked.
    expect(assist).not.toHaveBeenCalled();
  });

  it('removes a different preselected resume and replaces it with the chosen one', async () => {
    openDialog();
    el('#resume-card').setAttribute('data-document-id', OTHER_RESUME.id);
    el('#resume-card').querySelector('a')?.setAttribute('href', '/docs/doc-other');
    const remove = wireResumeReplacement();
    const submit = clickToConfirm();

    const result = await run(
      grant(),
      resumeOnly({ documentsAvailable: [RESUME, OTHER_RESUME] }),
      resumeJob,
    );

    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: [{ type: 'resume', id: RESUME.id }],
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(el('#resume-card').getAttribute('data-document-id')).toBe(RESUME.id);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('replaces a card with no readable ID when the user gave the file no name', async () => {
    openDialog();
    const card = el('#resume-card');
    card.removeAttribute('data-document-id');
    card.querySelector('a')?.remove();
    const remove = wireResumeReplacement();
    const submit = clickToConfirm();

    const result = await run(
      grant(),
      { documents: { resumeId: RESUME.id }, documentsAvailable: [{ ...RESUME, title: '' }] },
      resumeJob,
    );

    expect(result.outcome).toBe('applied');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('accepts an unreadable card only when the user name matches its file title', async () => {
    openDialog();
    const card = el('#resume-card');
    card.removeAttribute('data-document-id');
    card.querySelector('a')?.remove();
    const remove = vi.fn();
    card.querySelector('button')?.addEventListener('click', remove);
    clickToConfirm();

    const result = await run(
      grant(),
      {
        documents: { resumeId: RESUME.id },
        documentsAvailable: [{ ...RESUME, title: 'fixture_resume.pdf' }],
      },
      resumeJob,
    );

    expect(result.outcome).toBe('applied');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('returns the missing cover letter before any click, without the Apply-yourself copy', async () => {
    const applyClick = vi.fn();
    el('#apply').addEventListener('click', applyClick);
    const control = grant();

    const result = await run(control, resumeOnly());

    expect(result).toMatchObject({
      outcome: 'needs_input',
      missingDocumentTypes: ['cover_letter'],
      error: { code: 'MISSING_DOCUMENT' },
    });
    expect(result.error?.message).toBe(
      'This job needs a cover letter. Add its Handshake document link or ID.',
    );
    expect(applyClick).not.toHaveBeenCalled();
    expect(control.authorizeSubmit).not.toHaveBeenCalled();
  });

  it('marks a plain Apply that confirms instantly as applied with profile defaults', async () => {
    const click = clickToConfirm('#apply');

    const result = await run(grant(), resumeOnly(), resumeJob);

    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: 'handshake_profile_defaults',
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('fails the click when the site surfaces a validation error instead of a dialog', async () => {
    const click = vi.fn(() => {
      const error = document.createElement('p');
      error.setAttribute('role', 'alert');
      error.textContent = 'Please select a resume';
      document.body.appendChild(error);
    });
    el('#apply').addEventListener('click', click);

    const result = await run(grant(), resumeOnly(), resumeJob);

    expect(result).toMatchObject({
      outcome: 'needs_input',
      missingDocumentTypes: ['resume'],
      error: { code: 'MISSING_DOCUMENT' },
    });
    expect(result.error?.message).toMatch(/please select a resume/i);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('stops at Needs You for a required dialog question with no approved answer', async () => {
    openDialog();
    wireCoverSearch();
    const question = document.createElement('label');
    question.textContent = 'Why do you want this role?';
    const answer = document.createElement('textarea');
    answer.required = true;
    question.append(answer);
    el('[role="dialog"]').append(question);
    const submit = clickToConfirm();

    const result = await run();

    expect(result.outcome).toBe('needs_input');
    expect(result.error?.code).toBe('UNKNOWN_QUESTION');
    expect(result.questions?.map((entry) => entry.label)).toEqual(['why do you want this role']);
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps Review mode handing the job to the user without clicking or granting', async () => {
    const applyClick = vi.fn();
    el('#apply').addEventListener('click', applyClick);
    const control = grant();

    const result = await run(control, { mode: 'review', reviewBeforeSubmit: true });

    expect(result.outcome).toBe('manual_submit_required');
    expect(result.confirmationText).toContain(ONE_CLICK_APPLY_REVIEW_REASON);
    expect(result.confirmationText).toContain('other documents');
    expect(applyClick).not.toHaveBeenCalled();
    expect(control.authorizeSubmit).not.toHaveBeenCalled();
  });
});

describe('page assist is the last resort', () => {
  it('uses an assisted Apply control only after readiness fails and still verifies the submit', async () => {
    document.body.innerHTML =
      '<main data-hook="job-details-page"><h1>Backend Engineer</h1><button id="assist-apply" type="button">Continue</button></main>';
    const assistedButton = el('#assist-apply');
    const click = clickToConfirm('#assist-apply');
    assist.mockImplementation(async (_doc, target) =>
      target === 'applyButton' ? assistedButton : null,
    );

    const result = await run(grant(), resumeOnly(), resumeJob);

    expect(result).toMatchObject({
      outcome: 'applied',
      documentsUsed: 'handshake_profile_defaults',
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(assist).toHaveBeenCalledWith(
      document,
      'applyButton',
      expect.objectContaining({ scope: 'job', root: document }),
    );
  });

  it('keeps the failure when page assist finds no safe Apply control', async () => {
    document.body.innerHTML =
      '<main data-hook="job-details-page"><h1>Backend Engineer</h1><button type="button">Continue</button></main>';

    const pending = applyToJob(document, resumeJob, options(resumeOnly()), undefined, grant());
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({
      outcome: 'failed',
      error: { code: 'UI_CHANGED', message: 'Could not find an Apply button on the job page' },
    });
  });

  it('uses an assisted Submit Application control only inside the open dialog', async () => {
    openDialog();
    wireCoverSearch();
    const submitButton = el('[data-testid="submit-application"]');
    submitButton.textContent = 'Continue';
    const click = clickToConfirm();
    assist.mockImplementation(async (_doc, target) =>
      target === 'submitButton' ? submitButton : null,
    );

    const result = await run();

    expect(result.outcome).toBe('applied');
    expect(click).toHaveBeenCalledTimes(1);
    expect(assist).toHaveBeenCalledWith(
      document,
      'submitButton',
      expect.objectContaining({ scope: 'dialog' }),
    );
  });

  it('uses an assisted document field and never uploads a new file', async () => {
    openDialog();
    // A picker whose label does not name the document type: selectors miss it.
    const section = el('[aria-label="Attach your cover letter"]');
    section.setAttribute('aria-label', 'Attach supporting files');
    const heading = section.querySelector('h3');
    if (heading) heading.textContent = 'Attach supporting files';
    const search = el('#cover-search');
    const select = document.createElement('select');
    select.id = 'cover-select';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Select a document';
    const chosen = document.createElement('option');
    chosen.value = COVER.id;
    chosen.textContent = COVER.title;
    select.append(empty, chosen);
    search.replaceWith(select);
    const upload = vi.fn();
    el('#upload-cover').addEventListener('click', upload);
    const click = clickToConfirm();
    assist.mockImplementation(async (_doc, target) =>
      target === 'coverLetterField' ? select : null,
    );

    const result = await run();

    expect(result.outcome).toBe('applied');
    expect(result.documentsUsed).toEqual([
      { type: 'resume', id: RESUME.id },
      { type: 'cover_letter', id: COVER.id },
    ]);
    expect(select.value).toBe(COVER.id);
    expect(assist).toHaveBeenCalledWith(
      document,
      'coverLetterField',
      expect.objectContaining({ scope: 'dialog' }),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('skips an optional attachment the deterministic scan does not find without a page-assist call', async () => {
    openDialog();
    const submit = clickToConfirm();
    const transcript: DocumentRecord = {
      id: 'doc-transcript',
      type: 'transcript',
      title: 'Transcript 2026',
    };

    const result = await run(
      grant(),
      {
        documents: { resumeId: RESUME.id, transcriptId: transcript.id },
        documentsAvailable: [RESUME, transcript],
      },
      resumeJob,
    );

    expect(result.outcome).toBe('applied');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(submit).toHaveBeenCalledTimes(1);
    // The open form renders no transcript slot. That is a deterministic answer,
    // so the paid page-assist lookup is never asked to search for one.
    expect(assist).not.toHaveBeenCalled();
  });
});
