import { beforeEach, describe, expect, it } from 'vitest';
import { hasPositiveSubmissionEvidence } from '@/core/contracts/submitAuthorization';
import {
  detectAlreadyApplied,
  confirmationBaseline,
  detectConfirmation,
  detectValidationErrors,
  missingDocumentTypesInErrors,
} from '@/handshake/verification';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('confirmation and applied detection — H5/M6', () => {
  it.each([
    'No application submitted',
    'Application not successfully applied',
    'Application sent failed with an error',
  ])('rejects negated or failed confirmation: %s', (text) => {
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = text;
    document.body.append(status);
    expect(detectConfirmation(document).applied).toBe(false);
    expect(
      hasPositiveSubmissionEvidence({
        jobId: '900001',
        outcome: 'applied',
        confirmationText: text,
      }),
    ).toBe(false);
  });
  it('ignores job-description prose that claims a submission or an application', () => {
    document.body.innerHTML = `
      <main data-testid="job-detail">
        <h1>Backend Engineer</h1>
        <section aria-label="Job description">
          <p>Application submitted by our team is reviewed weekly.</p>
          <p>You applied on your last attempt; this posting is closed to new candidates.</p>
        </section>
      </main>`;

    expect(detectConfirmation(document).applied).toBe(false);
    expect(detectAlreadyApplied(document)).toBe(false);
  });

  it('reads a real status banner and ignores a stale pre-action banner', () => {
    document.body.innerHTML = `
      <div data-testid="job-status">
        <p role="status">Application submitted</p>
      </div>`;

    expect(detectConfirmation(document)).toMatchObject({ applied: true });

    // A baseline equal to the visible text means nothing new happened.
    expect(detectConfirmation(document, { baselineText: 'application submitted' }).applied).toBe(
      false,
    );
  });

  it('accepts a confirmation that appears after the baseline', () => {
    document.body.innerHTML = `<div data-testid="job-status"></div>`;
    expect(detectConfirmation(document, { baselineText: 'draft saved' }).applied).toBe(false);

    const banner = document.createElement('p');
    banner.setAttribute('role', 'status');
    banner.textContent = 'Application submitted';
    document.querySelector('[data-testid="job-status"]')?.append(banner);

    expect(detectConfirmation(document, { baselineText: 'draft saved' })).toMatchObject({
      applied: true,
      text: 'application submitted',
    });
  });

  it('still detects validation errors inside the form', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <p role="alert">This field is required</p>
      </div>`;
    expect(detectValidationErrors(document).join(' ')).toMatch(/required/i);
  });

  it.each([
    'Document is missing the resume',
    'Resume is missing',
    'Resume is required',
    'Please attach your resume',
    'Documents must include a Resume',
  ])('recognizes a document rejection: %s', (message) => {
    const alert = document.createElement('p');
    alert.setAttribute('role', 'alert');
    alert.textContent = message;
    document.body.append(alert);
    expect(detectValidationErrors(document)).toEqual([message.toLowerCase()]);
  });

  it('ignores missing-resume prose outside an error region and hidden old errors', () => {
    document.body.innerHTML = `
      <section aria-label="Job description">A resume is required.</section>
      <p role="alert" hidden>Resume is missing</p>
      <div role="status" aria-label="alert positive">Resume attached</div>`;
    expect(detectValidationErrors(document)).toEqual([]);
  });

  it('recognizes a document rejection in a toast without an alert role', () => {
    document.body.innerHTML = '<div class="toast">Document is missing the resume</div>';
    expect(detectValidationErrors(document)).toEqual(['document is missing the resume']);
  });

  it('names only the rejected attachment when another file is already attached', () => {
    expect(missingDocumentTypesInErrors(['Documents must include a Resume'])).toEqual(['resume']);
    expect(missingDocumentTypesInErrors(['Resume attached. Cover letter is missing.'])).toEqual([
      'cover_letter',
    ]);
    expect(
      missingDocumentTypesInErrors(['Transcript is required', 'Please attach your CV']),
    ).toEqual(['resume', 'transcript']);
  });

  it('ignores every pre-action confirmation when multiple stale banners are visible', () => {
    document.body.innerHTML =
      '<p role="status">Application submitted</p><p role="alert">Application received</p>';
    const baselineTexts = confirmationBaseline(document);
    expect(detectConfirmation(document, { baselineTexts }).applied).toBe(false);
    const banner = document.createElement('p');
    banner.setAttribute('role', 'status');
    banner.textContent = 'Successfully applied';
    document.body.append(banner);
    expect(detectConfirmation(document, { baselineTexts })).toMatchObject({
      applied: true,
      text: 'successfully applied',
    });
  });

  it('accepts a disabled applied indicator in the application status region', () => {
    document.body.innerHTML = '<header><button disabled>Applied</button></header>';
    expect(detectConfirmation(document)).toMatchObject({ applied: true, text: 'applied' });
  });

  it('rejects description prose and enabled actions labeled Applied as evidence', () => {
    document.body.innerHTML =
      '<section aria-label="Job description"><button disabled>Applied</button></section><header><button>Applied</button></header>';
    expect(detectConfirmation(document).applied).toBe(false);
  });
});
