import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import {
  PAGE_ASSIST_ATTRIBUTES,
  PAGE_ASSIST_MAX_CANDIDATES,
  PAGE_ASSIST_TEXT_MAX,
  type PageAssistAnswer,
  type PageAssistCandidate,
  type PageAssistQuery,
  type PageAssistScope,
  type PageAssistTarget,
} from '@/core/contracts/pageAssist';
import { assistLocate } from '@/handshake/page-assist';

type Assist = (query: PageAssistQuery) => Promise<PageAssistAnswer | null>;

function control(assist: Assist): ApplyControl & { pageAssist: ReturnType<typeof vi.fn> } {
  const pageAssist = vi.fn(assist);
  return {
    authorizeSubmit: async () => true,
    needsReview: () => false,
    pageAssist,
  };
}

function answering(index: number | null): ApplyControl & { pageAssist: ReturnType<typeof vi.fn> } {
  return control(async () => ({ index, source: index === null ? 'none' : 'ai', confidence: 0.9 }));
}

function body(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function candidatesOf(
  wrapper: ApplyControl & { pageAssist: ReturnType<typeof vi.fn> },
): PageAssistCandidate[] {
  const call = wrapper.pageAssist.mock.calls[0]?.[0] as PageAssistQuery | undefined;
  return call?.candidates ?? [];
}

async function locate(
  target: PageAssistTarget,
  scope: PageAssistScope,
  wrapper: ApplyControl,
  root: ParentNode = document,
): Promise<HTMLElement | null> {
  return assistLocate(document, target, { root, scope, control: wrapper });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('page assist candidate description', () => {
  it('masks personal identifiers and never includes values, hrefs or unknown attributes', async () => {
    const root = body(`
      <button aria-label="Email jane.doe@example.com or call 555-123-4567" data-hook="apply-btn" data-secret="do-not-send">Apply now</button>
      <a href="https://app.joinhandshake.com/private/path?token=secret-token" data-testid="apply-link">Apply via link</a>
      <input id="search" placeholder="Search your cover letters" value="My Secret Value" name="coverLetter" data-kind="document" />
      <button aria-label="Application 987654321">Open</button>
    `);
    const wrapper = answering(0);

    const picked = await locate('applyButton', 'job', wrapper, root);

    expect(picked?.textContent).toBe('Apply now');
    const candidates = candidatesOf(wrapper);
    expect(candidates).toHaveLength(4);
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('555-123-4567');
    expect(serialized).not.toContain('My Secret Value');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('data-secret');
    expect(serialized).not.toContain('do-not-send');
    expect(serialized).not.toContain('987654321');
    expect(candidates[0]?.name).toContain('[email]');
    expect(candidates[0]?.name).toContain('[phone]');

    for (const candidate of candidates) {
      for (const key of Object.keys(candidate.attributes)) {
        expect(PAGE_ASSIST_ATTRIBUTES).toContain(key);
      }
      for (const value of Object.values(candidate.attributes)) {
        expect(value.length).toBeLessThanOrEqual(PAGE_ASSIST_TEXT_MAX);
      }
    }
    // The input's value and every href stay out of the payload entirely.
    expect(candidates[2]?.attributes.name).toBe('coverLetter');
    expect(candidates[2]?.placeholder).toBe('Search your cover letters');
    expect(candidates[2]?.text).toBeUndefined();
  });

  it('caps the number of candidates', async () => {
    body(
      Array.from(
        { length: PAGE_ASSIST_MAX_CANDIDATES + 15 },
        (_, index) => `<button>Act ${index}</button>`,
      ).join(''),
    );
    const wrapper = answering(null);

    await locate('applyButton', 'job', wrapper);

    expect(candidatesOf(wrapper)).toHaveLength(PAGE_ASSIST_MAX_CANDIDATES);
  });
});

describe('page assist deterministic safety rules', () => {
  it('rejects an apply button that sits inside a dialog', async () => {
    body('<div role="dialog"><button>Apply</button></div>');
    const wrapper = answering(0);

    expect(await locate('applyButton', 'job', wrapper)).toBeNull();
  });

  it('rejects an apply target that is not button-like', async () => {
    body('<a href="/jobs/1">Apply</a>');
    const wrapper = answering(0);

    expect(await locate('applyButton', 'job', wrapper)).toBeNull();
  });

  it('rejects a submit button that is outside the dialog', async () => {
    body('<button>Submit Application</button>');
    const wrapper = answering(0);

    expect(await locate('submitButton', 'dialog', wrapper)).toBeNull();
  });

  it('rejects a submit target that is not button-like', async () => {
    body('<div role="dialog"><a href="#">Submit</a></div>');
    const wrapper = answering(0);

    expect(await locate('submitButton', 'dialog', wrapper)).toBeNull();
  });

  it('rejects a document field outside the dialog', async () => {
    body('<input type="search" placeholder="Search your resumes" />');
    const wrapper = answering(0);

    expect(await locate('resumeField', 'dialog', wrapper)).toBeNull();
  });

  it('rejects a document field with the wrong control type', async () => {
    body('<div role="dialog"><input type="email" placeholder="Email" /></div>');
    const wrapper = answering(0);

    expect(await locate('coverLetterField', 'dialog', wrapper)).toBeNull();
  });

  it('accepts a combobox inside the dialog for a document field', async () => {
    body('<div role="dialog"><select aria-label="Resume"><option>One</option></select></div>');
    const wrapper = answering(0);

    expect(await locate('resumeField', 'dialog', wrapper)).not.toBeNull();
  });

  it('rejects a disabled control', async () => {
    body('<button disabled>Apply</button>');
    const wrapper = answering(0);

    expect(await locate('applyButton', 'job', wrapper)).toBeNull();
  });

  it('rejects destructive or unrelated button names', async () => {
    body('<div role="dialog"><button>Withdraw application</button></div>');
    expect(await locate('submitButton', 'dialog', answering(0))).toBeNull();

    body(
      '<div role="dialog"><button aria-haspopup="listbox" aria-label="Upload new">+</button></div>',
    );
    expect(await locate('coverLetterField', 'dialog', answering(0))).toBeNull();

    body(
      '<div role="dialog"><button aria-haspopup="listbox" aria-label="Preview document">+</button></div>',
    );
    expect(await locate('resumeField', 'dialog', answering(0))).toBeNull();
  });

  it('rejects an element that was disconnected while the background answered', async () => {
    body('<button>Apply</button>');
    const wrapper = control(async () => {
      document.querySelector('button')?.remove();
      return { index: 0, source: 'ai', confidence: 0.9 };
    });

    expect(await locate('applyButton', 'job', wrapper)).toBeNull();
  });

  it('returns null for a missing, out-of-range or malformed answer', async () => {
    body('<button>Apply</button>');
    expect(await locate('applyButton', 'job', answering(3))).toBeNull();
    expect(await locate('applyButton', 'job', answering(null))).toBeNull();
    expect(
      await locate(
        'applyButton',
        'job',
        control(async () => ({ index: 0.5, source: 'ai' }) as unknown as PageAssistAnswer),
      ),
    ).toBeNull();
    expect(
      await locate(
        'applyButton',
        'job',
        control(async () => {
          throw new Error('background unavailable');
        }),
      ),
    ).toBeNull();
  });

  it('returns null when the caller did not bind page assist', async () => {
    body('<button>Apply</button>');

    expect(
      await assistLocate(document, 'applyButton', {
        root: document,
        scope: 'job',
        control: { authorizeSubmit: async () => true, needsReview: () => false },
      }),
    ).toBeNull();
  });
});
