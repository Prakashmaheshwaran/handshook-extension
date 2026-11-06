import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRecord } from '@/core/contracts';
import { selectDocument, verifySelectedDocuments } from '@/handshake/documents';

vi.mock('@/handshake/page-assist', () => ({ assistLocate: vi.fn(async () => null) }));

const RESUME: DocumentRecord = { id: 'doc-resume', type: 'resume', title: 'Resume 2026' };
const OTHER_RESUME: DocumentRecord = { id: 'doc-other', type: 'resume', title: 'Other Resume' };
const COVER: DocumentRecord = { id: 'doc-cover', type: 'cover_letter', title: 'Cover Letter 2026' };

function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element ${selector}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-dialog-attach.html'),
    'utf8',
  );
  el('#apply-dialog').hidden = false;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('selected document cards', () => {
  it('verifies a preselected card by its document ID without touching a picker', async () => {
    const resumeSearch = vi.fn();
    el('#resume-search').addEventListener('click', resumeSearch);

    const result = await selectDocument(document, 'resume', RESUME, undefined, [RESUME]);

    expect(result.ok).toBe(true);
    expect(result.field).toBe(el('#resume-card'));
    expect(resumeSearch).not.toHaveBeenCalled();
  });

  it('matches an unreadable card only to the user name for the file', async () => {
    const card = el('#resume-card');
    card.removeAttribute('data-document-id');
    card.querySelector('a')?.remove();
    // Without a readable ID the card is only evidence until it is replaced.
    card.querySelector('button')?.addEventListener('click', () => {
      card.hidden = true;
    });

    const named = await selectDocument(
      document,
      'resume',
      { ...RESUME, title: 'fixture_resume.pdf' },
      undefined,
      [{ ...RESUME, title: 'fixture_resume.pdf' }],
    );
    const unnamed = await selectDocument(document, 'resume', { ...RESUME, title: '' }, undefined, [
      { ...RESUME, title: '' },
    ]);

    expect(named.ok).toBe(true);
    // No name and no readable ID: the card cannot prove the choice.
    expect(unnamed.ok).toBe(false);
    expect(unnamed.error).toMatch(/replace/i);
  });

  it('fails pre-submit verification when a different document is attached', () => {
    el('#resume-card').setAttribute('data-document-id', OTHER_RESUME.id);

    const result = verifySelectedDocuments(
      document,
      [{ type: 'resume', id: RESUME.id }],
      [RESUME, OTHER_RESUME],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['resume']);
    expect(result.errors[0]).toMatch(/chosen resume changed/i);
  });

  it('passes pre-submit verification when the chosen card is attached', () => {
    const result = verifySelectedDocuments(
      document,
      [{ type: 'resume', id: RESUME.id }],
      [RESUME, OTHER_RESUME],
    );

    expect(result).toMatchObject({ ok: true, used: [{ type: 'resume', id: RESUME.id }] });
  });
});

describe('assisted document fields', () => {
  it('verifies an assisted field recorded before submission', () => {
    el('#cover-search').hidden = true;
    const select = document.createElement('select');
    for (const [value, text] of [
      ['', 'Select'],
      [COVER.id, COVER.title],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    // A label that does not name the type keeps the deterministic field finder
    // from seeing this control, so only the recorded element can verify it.
    select.setAttribute('aria-label', 'Pick an attachment');
    document.body.append(select);
    select.value = COVER.id;

    const result = verifySelectedDocuments(
      document,
      [
        { type: 'resume', id: RESUME.id },
        { type: 'cover_letter', id: COVER.id },
      ],
      [RESUME, COVER],
      { cover_letter: select },
    );

    expect(result.ok).toBe(true);
  });

  it('fails an assisted field that now shows a different document', () => {
    el('#cover-search').hidden = true;
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = 'another-document';
    option.textContent = 'Another document';
    select.append(option);
    select.setAttribute('aria-label', 'Pick an attachment');
    document.body.append(select);
    select.value = 'another-document';

    const result = verifySelectedDocuments(
      document,
      [
        { type: 'resume', id: RESUME.id },
        { type: 'cover_letter', id: COVER.id },
      ],
      [RESUME, COVER],
      { cover_letter: select },
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['cover_letter']);
  });
});

describe('live dialog shape: heading and attached file in separate containers', () => {
  const LIVE = { id: 'resume-live', type: 'resume', title: 'fixture_live_resume.pdf' } as const;

  beforeEach(() => {
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-dialog-nested-heading.html'),
      'utf8',
    );
  });

  it('finds the already-attached resume beside the heading, not only inside it', async () => {
    const result = await selectDocument(document, 'resume', LIVE, undefined, [LIVE]);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts the attached resume when the form offers no way to replace it', async () => {
    const other: DocumentRecord = { id: 'resume-wanted', type: 'resume', title: 'Wanted Resume' };
    const result = await selectDocument(document, 'resume', other, undefined, [other]);

    // Handshake's Quick apply form shows its own default resume with no remove
    // control; the job must still be able to apply, and Activity must name the
    // document that was actually sent.
    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBe('resume-live');
  });

  it('re-verifies the attached file before submit without a configured record', () => {
    const result = verifySelectedDocuments(document, [{ type: 'resume', id: 'resume-live' }], []);
    expect(result).toMatchObject({ ok: true, missing: [] });
  });

  it('still refuses a card whose document changed to something else', () => {
    const result = verifySelectedDocuments(document, [{ type: 'resume', id: 'resume-other' }], []);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/changed/);
  });
});

describe('live dialog shape: dismissible attached resume', () => {
  function attachCard(id: string, name: string): void {
    const alert = document.createElement('div');
    alert.className = 'rosetta-inline-alert';
    alert.setAttribute('role', 'status');
    alert.innerHTML = `<div class="rosetta-inline-alert__content"><h5>${name}</h5><a class="rosetta-link" href="/docs/${id}">Preview document</a></div>`;
    document.querySelector('#resume-fieldset')?.append(alert);
  }

  beforeEach(() => {
    document.body.innerHTML = readFileSync(
      resolve(
        process.cwd(),
        'tests/fixtures/synthetic/apply/handshake-dialog-dismissible-alert.html',
      ),
      'utf8',
    );
    const list = document.querySelector('#resume-listbox') as HTMLElement;
    document.querySelector('#dismiss-resume')?.addEventListener('click', () => {
      document.querySelector('#attached-resume')?.remove();
      (document.querySelector('#resume-picker') as HTMLElement).hidden = false;
      list.hidden = false;
    });
    for (const option of Array.from(list.querySelectorAll('[role="option"]'))) {
      option.addEventListener('click', () => {
        attachCard(
          option.getAttribute('data-document-id') ?? '',
          (option.textContent ?? '').trim(),
        );
        (document.querySelector('#resume-picker') as HTMLElement).hidden = true;
        list.hidden = true;
      });
    }
  });

  it('dismisses the attached resume and selects the wanted one by name', async () => {
    const wanted: DocumentRecord = {
      id: 'resume-wanted',
      type: 'resume',
      title: 'fixture_wanted.pdf',
    };

    const result = await selectDocument(document, 'resume', wanted, undefined, [wanted]);

    // The picked file verifies against the configured record, so the caller
    // reports the configured ID (no usedDocumentId override).
    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBeUndefined();
  });

  it('uses the account default when the slot has no saved name', async () => {
    // A cover letter or transcript added by ID only has nothing to search for;
    // the picker's first row is the account's own default for that slot.
    const unnamed: DocumentRecord = { id: 'cover-unknown', type: 'resume', title: '' };

    const result = await selectDocument(document, 'resume', unnamed, undefined, [unnamed]);

    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBe('resume-wanted');
  });

  it('uses the account default when the saved name is not a file in the account', async () => {
    // A renamed or mistyped label must not stop the application.
    (document.querySelector('#dismiss-resume') as HTMLElement).click();
    const wanted: DocumentRecord = {
      id: 'resume-gone',
      type: 'resume',
      title: 'Not A Real File.pdf',
    };

    const result = await selectDocument(document, 'resume', wanted, undefined, [wanted]);

    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBe('resume-wanted');
  });

  it('waits for a virtualised picker to render the filtered row before deciding', async () => {
    // Live Handshake lists ~200 resumes and renders only a window of rows; the
    // list is visible before the search filter has applied.
    const list = document.querySelector('#resume-listbox') as HTMLElement;
    list.innerHTML = '<li role="option">Unrelated.pdf</li>';
    list.addEventListener('click', (event) => {
      const option = (event.target as Element).closest('[role="option"]');
      if (!option) return;
      attachCard(option.getAttribute('data-document-id') ?? '', (option.textContent ?? '').trim());
      (document.querySelector('#resume-picker') as HTMLElement).hidden = true;
    });
    const input = document.querySelector('#resume-search') as HTMLInputElement;
    input.addEventListener('input', () => {
      setTimeout(() => {
        list.innerHTML =
          '<li role="option" data-document-id="resume-wanted">fixture_wanted.pdf</li>';
      }, 150);
    });
    const wanted: DocumentRecord = {
      id: 'resume-wanted',
      type: 'resume',
      title: 'fixture_wanted.pdf',
    };

    const result = await selectDocument(document, 'resume', wanted, undefined, [wanted]);

    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBeUndefined();
  });

  it('matches a file offered under a slightly different name', async () => {
    // The account file is "fixture_wanted.pdf"; the user's label can differ by
    // punctuation, extra words or truncation.
    const wanted: DocumentRecord = {
      id: 'resume-wanted',
      type: 'resume',
      title: 'fixture wanted',
    };

    const result = await selectDocument(document, 'resume', wanted, undefined, [wanted]);

    // Matched by the option's document ID, so the configured ID is reported.
    expect(result.ok).toBe(true);
    expect(result.usedDocumentId).toBeUndefined();
  });

  it('puts the form’s own resume back when the wanted name is not offered', async () => {
    const wanted: DocumentRecord = {
      id: 'resume-missing',
      type: 'resume',
      title: 'Not In Account.pdf',
    };

    const result = await selectDocument(document, 'resume', wanted, undefined, [wanted]);

    expect(result).toMatchObject({ ok: true, usedDocumentId: 'resume-live' });
  });
});
