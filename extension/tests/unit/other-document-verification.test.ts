import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRecord } from '@/core/contracts';
import {
  selectConfiguredDocuments,
  selectDocument,
  verifySelectedDocuments,
} from '@/handshake/documents';

vi.mock('@/handshake/page-assist', () => ({ assistLocate: vi.fn(async () => null) }));

const OTHER: DocumentRecord = {
  id: 'other-chosen',
  type: 'other',
  title: 'example_portfolio_link.pdf',
};

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element ${selector}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/other-required-document.html'),
    'utf8',
  );
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function select() {
  const pending = selectDocument(document, 'other', OTHER, undefined, [OTHER]);
  await vi.runAllTimersAsync();
  return pending;
}

describe('qualified Other document headings', () => {
  it.each([
    'Attach other required documents',
    'Attach other optional documents',
    'Attach additional required files',
    'Attach supporting documents',
  ])('recognises the existing attachment under %s without removing it', async (heading) => {
    element('h4').textContent = heading;
    const remove = vi.fn();
    element('#remove-other').addEventListener('click', remove);
    expect(await select()).toMatchObject({ ok: true });
    expect(remove).not.toHaveBeenCalled();
  });

  it('verifies the attached card after a search picker closes', async () => {
    element('#other-card').hidden = true;
    element('#other-picker').hidden = false;
    element('#other-search').addEventListener('click', () => {
      element('#other-listbox').hidden = false;
    });
    element('[role=option]').addEventListener('click', () => {
      element('#other-card').hidden = false;
      element('#other-picker').hidden = true;
    });
    expect(await select()).toMatchObject({ ok: true });
    expect(
      verifySelectedDocuments(document, [{ type: 'other', id: OTHER.id }], [OTHER]),
    ).toMatchObject({ ok: true });
  });

  it('still rejects a different document ID under the qualified heading', () => {
    element<HTMLAnchorElement>('#other-card a').href = '/docs/other-different';
    expect(
      verifySelectedDocuments(document, [{ type: 'other', id: OTHER.id }], [OTHER]),
    ).toMatchObject({ ok: false, missing: ['other'] });
  });

  it('does not accept a hidden card or unselected search result', async () => {
    element('#other-card').hidden = true;
    element('#other-picker').hidden = false;
    element('#other-listbox').hidden = false;
    expect(await select()).toMatchObject({ ok: false });
  });

  it('does not use a resume card as evidence for an Other document', async () => {
    element('h4').textContent = 'Attach your resume';
    expect(await select()).toMatchObject({ ok: false });
  });

  it('can attach the configured optional Other document under an optional heading', async () => {
    element('h4').textContent = 'Attach other optional documents';
    const result = await selectConfiguredDocuments(
      document,
      { otherDocumentId: OTHER.id },
      [OTHER],
      [],
    );
    expect(result).toMatchObject({ ok: true, used: [{ type: 'other', id: OTHER.id }] });
  });
});
