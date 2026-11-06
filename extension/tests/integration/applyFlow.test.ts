import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, ApplyOptions, DocumentRecord, Job } from '@/core/contracts';
import { CancelledError } from '@/handshake/dom';
import { applyToJob as applyWithAuthorization } from '@/handshake/applyFlow';
import { resetSelectorHealth } from '@/handshake/health';

const HOST = 'app.joinhandshake.com';
// Adapter tests inject the background grant; production obtains it over RPC.
function applyToJob(...args: Parameters<typeof applyWithAuthorization>) {
  return applyWithAuthorization(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4] ?? {
      authorizeSubmit: async () => true,
      needsReview: () => false,
    },
  );
}
const RESUME: DocumentRecord = {
  id: 'doc-resume',
  type: 'resume',
  title: 'Resume 2026',
};

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/synthetic/apply', name), 'utf8');
}

function load(name: string): void {
  document.body.innerHTML = fixture(name);
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '1001',
    host: HOST,
    title: 'Software Engineer Intern',
    employer: 'Acme Robotics',
    url: `https://${HOST}/jobs/1001`,
    description: 'Build reliable tools.',
    applyType: 'quick_apply',
    requiredDocumentTypes: ['resume'],
    source: 'search',
    discoveredAt: 0,
    ...overrides,
  };
}

const WORK_AUTH_ANSWER: Answer = {
  id: 'q-work-auth',
  label: 'Are you authorized to work in the United States?',
  aliases: [],
  type: 'select',
  value: 'yes',
  options: { Yes: 'yes' },
  category: 'work',
  autoSubmitAllowed: false,
  sensitive: true,
  updatedAt: 1,
};

function makeOptions(overrides: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    mode: 'review',
    documents: { resumeId: RESUME.id },
    documentsAvailable: [RESUME],
    answers: [],
    allowSensitiveAutoSubmit: false,
    allowEeoAutoFill: false,
    allowFreeTextAutoFill: false,
    reviewBeforeSubmit: true,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function dialog(): HTMLElement {
  const element = document.getElementById('apply-dialog');
  if (!(element instanceof HTMLElement)) throw new Error('fixture has no apply dialog');
  return element;
}

function submitButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('[data-testid="submit-application"]');
  if (!button) throw new Error('fixture has no submit button');
  return button;
}

function clickToOpen(selector: string): void {
  const button = document.querySelector<HTMLElement>(selector);
  if (!button) throw new Error(`fixture has no ${selector}`);
  button.addEventListener('click', () => {
    dialog().hidden = false;
  });
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

describe('dry run', () => {
  it('opens a declared form to read its questions, without filling or submitting', async () => {
    load('handshake-form-unknown-question.html');
    clickToOpen('button');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'dry_run' }),
    );

    expect(result).toMatchObject({ outcome: 'would_apply' });
    expect(result.confirmationText).toMatch(/dry run/i);
    expect(result.questions?.map((question) => question.label)).toEqual([
      'are you authorized to work in the united states',
    ]);
    expect(document.querySelector<HTMLSelectElement>('#work-auth')?.value).toBe('');
    expect(document.querySelector<HTMLSelectElement>('#resume-select')?.value).toBe('');
    expect(submitted).toBe(false);
  });

  it('never clicks a plain Apply in a dry run, because it may submit immediately', async () => {
    load('handshake-form.html');
    const apply = document.querySelector('button')!;
    apply.removeAttribute('aria-haspopup');
    apply.removeAttribute('aria-controls');
    let clicked = false;
    apply.addEventListener('click', () => {
      clicked = true;
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'dry_run' }),
    );

    expect(result).toMatchObject({ outcome: 'would_apply' });
    expect(result.questions).toBeUndefined();
    expect(clicked).toBe(false);
    expect(dialog().hidden).toBe(true);
  });

  it('still reports external jobs as external', async () => {
    document.body.innerHTML = `
      <main data-hook="job-details-page">
        <h1>External Job</h1>
        <a href="https://careers.example.com/apply">Apply Externally</a>
      </main>
    `;

    const result = await applyToJob(document, makeJob({ applyType: 'external' }), makeOptions());

    expect(result.outcome).toBe('external');
  });
});

describe('quick apply review mode', () => {
  it('never clicks a one-click Quick Apply and asks the user to submit', async () => {
    load('quick-apply-single-click.html');
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await applyToJob(document, makeJob(), makeOptions());

    expect(result.outcome).toBe('manual_submit_required');
    expect(result.confirmationText).toBe(
      'One-click Apply: click Apply on Handshake yourself - it submits immediately',
    );
    expect(clicked).toBe(false);
  });

  it('does not treat aria-haspopup="true" (a menu) as a review dialog', async () => {
    load('quick-apply-single-click.html');
    const button = document.querySelector<HTMLElement>('button');
    if (!button) throw new Error('fixture has no apply button');
    button.setAttribute('aria-haspopup', 'true');
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = await applyToJob(document, makeJob(), makeOptions());

    expect(result.outcome).toBe('manual_submit_required');
    expect(clicked).toBe(false);
  });

  it('validates required documents before asking for a manual submit', async () => {
    load('quick-apply-single-click.html');

    const result = await applyToJob(
      document,
      makeJob({ requiredDocumentTypes: ['cover_letter'] }),
      makeOptions({ documents: {}, documentsAvailable: [RESUME] }),
    );

    expect(result.outcome).toBe('needs_input');
    expect(result.missingDocumentTypes).toEqual(['cover_letter']);
  });

  it('opens a declared review step, selects documents, and stops before submit', async () => {
    load('quick-apply-review.html');
    clickToOpen('button[aria-haspopup="dialog"]');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(document, makeJob(), makeOptions());

    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual([{ type: 'resume', id: RESUME.id }]);
    expect(result.confirmationText).toMatch(/review and submit/i);
    expect(dialog().hidden).toBe(false);
    expect(submitted).toBe(false);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('reports missing documents inside the review step', async () => {
    load('quick-apply-review.html');
    clickToOpen('button[aria-haspopup="dialog"]');

    const result = await applyToJob(
      document,
      makeJob({ requiredDocumentTypes: ['transcript'] }),
      makeOptions({ documents: {}, documentsAvailable: [RESUME] }),
    );

    expect(result.outcome).toBe('needs_input');
    expect(result.missingDocumentTypes).toEqual(['transcript']);
  });
});

describe('reviewBeforeSubmit enforcement', () => {
  it('stops an autopilot quick apply with a review step before submit', async () => {
    load('quick-apply-review.html');
    clickToOpen('button[aria-haspopup="dialog"]');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(
      document,
      makeJob(),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: true }),
    );

    expect(result.outcome).toBe('ready_for_review');
    expect(submitted).toBe(false);
  });

  it('stops an autopilot form before submit when reviewBeforeSubmit is set', async () => {
    load('handshake-form.html');
    clickToOpen('button');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: true }),
    );

    expect(result.outcome).toBe('ready_for_review');
    expect(submitted).toBe(false);
    expect(document.querySelector<HTMLSelectElement>('#resume-select')?.value).toBe(RESUME.id);
  });

  it('submits an autopilot form when reviewBeforeSubmit is false', async () => {
    load('handshake-form.html');
    clickToOpen('button');
    submitButton().addEventListener('click', () => {
      const banner = document.createElement('p');
      banner.setAttribute('role', 'status');
      banner.textContent = 'Application submitted';
      document.body.appendChild(banner);
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false }),
    );

    expect(result.outcome).toBe('applied');
    expect(result.confirmationText).toMatch(/application submitted/i);
  });

  it('submits an autopilot quick apply with a review step when reviewBeforeSubmit is false', async () => {
    load('quick-apply-review.html');
    clickToOpen('button[aria-haspopup="dialog"]');
    submitButton().addEventListener('click', () => {
      const banner = document.createElement('p');
      banner.setAttribute('role', 'status');
      banner.textContent = 'Application submitted';
      document.body.appendChild(banner);
    });

    const result = await applyToJob(
      document,
      makeJob(),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false }),
    );

    expect(result.outcome).toBe('applied');
  });
});

describe('stopOnUnknownQuestion', () => {
  it('pauses on an unanswered required question when the setting is on', async () => {
    load('handshake-form-unknown-question.html');
    clickToOpen('button');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false }),
    );

    expect(result.outcome).toBe('needs_input');
    expect(result.error?.code).toBe('UNKNOWN_QUESTION');
    expect(result.questions?.map((question) => question.label)).toEqual([
      'are you authorized to work in the united states',
    ]);
    expect(submitted).toBe(false);
  });

  it('fills an explicitly supplied sensitive answer and stops at review', async () => {
    load('handshake-form-unknown-question.html');
    clickToOpen('button');
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({
        mode: 'autopilot',
        reviewBeforeSubmit: true,
        allowSensitiveAutoSubmit: false,
        answers: [WORK_AUTH_ANSWER],
        explicitAnswerIds: [WORK_AUTH_ANSWER.id],
      }),
    );

    expect(result.outcome).toBe('ready_for_review');
    expect(document.querySelector<HTMLSelectElement>('#work-auth')?.value).toBe('yes');
    expect(submitted).toBe(false);
  });

  it('still pauses when a sensitive answer was not explicitly supplied', async () => {
    load('handshake-form-unknown-question.html');
    clickToOpen('button');

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({
        mode: 'autopilot',
        reviewBeforeSubmit: false,
        allowSensitiveAutoSubmit: false,
        answers: [WORK_AUTH_ANSWER],
      }),
    );

    expect(result.outcome).toBe('needs_input');
    expect(document.querySelector<HTMLSelectElement>('#work-auth')?.value).toBe('');
  });

  it('stops at review when the setting is off instead of submitting an unanswered required question', async () => {
    load('handshake-form-unknown-question.html');
    clickToOpen('button');
    submitButton().addEventListener('click', () => {
      const banner = document.createElement('p');
      banner.setAttribute('role', 'status');
      banner.textContent = 'Application submitted';
      document.body.appendChild(banner);
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({
        mode: 'autopilot',
        reviewBeforeSubmit: false,
        stopOnUnknownQuestion: false,
      }),
    );

    expect(result.outcome).toBe('ready_for_review');
    expect(document.querySelector<HTMLSelectElement>('#work-auth')?.value).toBe('');
  });
});

describe('verifySubmissions', () => {
  it('accepts immediate positive evidence even when extended verification is off', async () => {
    load('handshake-form.html');
    clickToOpen('button');
    submitButton().addEventListener('click', () => {
      const banner = document.createElement('p');
      banner.setAttribute('role', 'status');
      banner.textContent = 'Application submitted';
      document.body.append(banner);
    });
    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false, verifySubmissions: false }),
    );
    expect(result).toMatchObject({ outcome: 'applied', confirmationText: 'application submitted' });
  });

  it('reports verifying without waiting when verification is off and evidence is missing', async () => {
    load('handshake-form.html');
    clickToOpen('button');
    submitButton().addEventListener('click', () => {
      // The site shows no confirmation banner in this scenario.
    });

    const startedAt = Date.now();
    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false, verifySubmissions: false }),
    );

    expect(result.outcome).toBe('verifying');
    expect(result.confirmationText).toBeUndefined();
    expect(result.error?.message).toMatch(/no submission confirmation/i);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('waits for a confirmation when verification is on', async () => {
    load('handshake-form.html');
    clickToOpen('button');
    submitButton().addEventListener('click', () => {
      const banner = document.createElement('p');
      banner.setAttribute('role', 'status');
      banner.textContent = 'Application submitted';
      document.body.appendChild(banner);
    });

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false }),
    );

    expect(result.outcome).toBe('applied');
    expect(result.confirmationText).toMatch(/application submitted/i);
  });

  it('keeps a submit without evidence verifying even when the form remains open after timeout', async () => {
    vi.useFakeTimers();
    try {
      load('handshake-form.html');
      clickToOpen('button');
      const pending = applyToJob(
        document,
        makeJob({ applyType: 'handshake_form' }),
        makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false, timeoutMs: 1_000 }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ outcome: 'verifying' });
      expect(dialog().hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safety review — abort and optional documents', () => {
  it('never clicks anything when the signal is already aborted (H1)', async () => {
    load('handshake-form.html');
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      applyToJob(
        document,
        makeJob({ applyType: 'handshake_form' }),
        makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false }),
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(clicked).toBe(false);
  });

  it('aborts while waiting for the form instead of submitting (H1)', async () => {
    load('handshake-form.html');
    // No click handler: the form never opens, so the adapter waits.
    const controller = new AbortController();
    let submitted = false;
    submitButton().addEventListener('click', () => {
      submitted = true;
    });
    const pending = applyToJob(
      document,
      makeJob({ applyType: 'handshake_form' }),
      makeOptions({ mode: 'autopilot', reviewBeforeSubmit: false, timeoutMs: 5_000 }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(submitted).toBe(false);
  });

  it('attaches a configured cover letter even when the posting does not require it (M15)', async () => {
    load('handshake-form-optional-docs.html');
    clickToOpen('button');
    const cover: DocumentRecord = { id: 'doc-cover', type: 'cover_letter', title: 'Cover Letter' };

    const result = await applyToJob(
      document,
      makeJob({ applyType: 'handshake_form', requiredDocumentTypes: ['resume'] }),
      makeOptions({
        documents: { resumeId: RESUME.id, coverLetterId: cover.id },
        documentsAvailable: [RESUME, cover],
      }),
    );

    expect(result.outcome).toBe('ready_for_review');
    expect(result.documentsUsed).toEqual(
      expect.arrayContaining([
        { type: 'resume', id: RESUME.id },
        { type: 'cover_letter', id: cover.id },
      ]),
    );
    expect(document.querySelector<HTMLSelectElement>('#cover-select')?.value).toBe(cover.id);
  });

  it('does not invent an applied result when a quick apply has no evidence (L16)', async () => {
    load('quick-apply-single-click.html');
    // The click handler does nothing: no dialog and no confirmation.

    const result = await applyToJob(
      document,
      makeJob(),
      makeOptions({
        mode: 'autopilot',
        reviewBeforeSubmit: false,
        verifySubmissions: false,
        timeoutMs: 1_000,
        allowOneClickApply: true,
      }),
    );

    expect(result.outcome).toBe('verifying');
    expect(result.error?.message).toMatch(/check the job page/i);
  });
});
