import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions, DocumentRecord, DocumentType } from '@/core/contracts';
import { applyToJob } from '@/handshake/applyFlow';
import { makeJob } from '@/test/factories';

vi.mock('@/handshake/page-assist', () => ({ assistLocate: vi.fn(async () => null) }));

const DOCUMENTS: DocumentRecord[] = [
  { id: 'doc-resume', type: 'resume', title: 'Resume' },
  { id: 'doc-cover', type: 'cover_letter', title: 'Cover letter' },
  { id: 'doc-transcript', type: 'transcript', title: 'Transcript' },
  { id: 'doc-other', type: 'other', title: 'Other document' },
];

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element ${selector}`);
  return found;
}

async function apply(
  requiredDocumentTypes: DocumentType[] = [],
  patch: Partial<ApplyOptions> = {},
  authorized: boolean | (() => boolean) = true,
) {
  const options: ApplyOptions = {
    mode: 'autopilot',
    allowOneClickApply: true,
    reviewBeforeSubmit: false,
    documents: {
      resumeId: 'doc-resume',
      coverLetterId: 'doc-cover',
      transcriptId: 'doc-transcript',
      otherDocumentId: 'doc-other',
    },
    documentsAvailable: DOCUMENTS,
    answers: [],
    allowSensitiveAutoSubmit: false,
    allowEeoAutoFill: false,
    allowFreeTextAutoFill: false,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
    timeoutMs: 1_000,
    ...patch,
  };
  const pending = applyToJob(
    document,
    makeJob({ applyType: 'handshake_form', requiredDocumentTypes }),
    options,
    undefined,
    {
      authorizeSubmit: async () => (typeof authorized === 'function' ? authorized() : authorized),
      needsReview: () => false,
    },
  );
  await vi.runAllTimersAsync();
  return pending;
}

let submit: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/no-additional-documents.html'),
    'utf8',
  );
  element('#apply').addEventListener('click', () => {
    element('#apply-dialog').hidden = false;
  });
  submit = vi.fn(() => {
    element('#apply-dialog').hidden = true;
    const banner = document.createElement('p');
    banner.setAttribute('role', 'status');
    banner.textContent = 'Application submitted';
    document.body.append(banner);
  });
  element('#submit').addEventListener('click', submit);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('a dialog that explicitly requires no additional documents', () => {
  it('submits without inventing a resume picker or claiming saved files were attached', async () => {
    expect(await apply()).toMatchObject({ outcome: 'applied', documentsUsed: [] });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'hidden', 'outside', 'answer'] as const)(
    'keeps the resume fallback when the declaration is %s',
    async (shape) => {
      const message = element('#document-requirements');
      if (shape === 'missing') message.remove();
      if (shape === 'hidden') message.hidden = true;
      if (shape === 'outside') document.body.append(message);
      if (shape === 'answer') {
        const answer = document.createElement('textarea');
        answer.textContent = message.textContent;
        message.replaceWith(answer);
      }
      expect(await apply()).toMatchObject({
        outcome: 'needs_input',
        missingDocumentTypes: ['resume'],
      });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it.each(['resume', 'cover_letter'] as const)(
    'does not override an explicit %s requirement',
    async (type) => {
      expect(await apply([type])).toMatchObject({
        outcome: 'needs_input',
        missingDocumentTypes: [type],
      });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('still selects the configured resume when the form offers its picker', async () => {
    const label = document.createElement('label');
    label.textContent = 'Resume';
    label.htmlFor = 'resume-picker';
    const picker = document.createElement('select');
    picker.id = 'resume-picker';
    picker.innerHTML = '<option value="">Choose</option><option value="doc-resume">Resume</option>';
    element('#apply-dialog').prepend(label, picker);
    expect(await apply()).toMatchObject({
      outcome: 'applied',
      documentsUsed: [{ type: 'resume', id: 'doc-resume' }],
    });
    expect(picker.value).toBe('doc-resume');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('keeps Review mode at the filled form', async () => {
    element('#apply').setAttribute('aria-haspopup', 'dialog');
    expect(await apply([], { mode: 'review' })).toMatchObject({
      outcome: 'ready_for_review',
      documentsUsed: [],
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not submit without the final background authorization', async () => {
    element('#apply').setAttribute('aria-haspopup', 'dialog');
    expect(await apply([], {}, false)).toMatchObject({ outcome: 'ready_for_review' });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['declaration removed', 'picker added'] as const)(
    'rechecks the document-free form after authorization when %s',
    async (change) => {
      element('#apply').setAttribute('aria-haspopup', 'dialog');
      const result = await apply([], {}, () => {
        if (change === 'declaration removed') element('#document-requirements').remove();
        else {
          const picker = document.createElement('select');
          picker.setAttribute('aria-label', 'Resume');
          element('#apply-dialog').prepend(picker);
        }
        return true;
      });
      expect(result).toMatchObject({
        outcome: 'needs_input',
        error: { code: 'MISSING_DOCUMENT' },
      });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('still pauses for an unanswered required question', async () => {
    const label = document.createElement('label');
    label.textContent = 'What is your professional license number?';
    const input = document.createElement('input');
    input.required = true;
    label.append(input);
    element('#apply-dialog').prepend(label);
    expect(await apply()).toMatchObject({
      outcome: 'needs_input',
      error: { code: 'UNKNOWN_QUESTION' },
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
