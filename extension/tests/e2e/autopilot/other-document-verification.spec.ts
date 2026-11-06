import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, listSubmissions, seedExtension, startEngine, waitFor } from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';

test('verifies the selected Other document under the qualified heading before submitting', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'form-other-document');
  mock.setSearchJobs([SAMPLE_JOBS[0]!]);
  mock.setDocuments([{ id: 'document-other', type: 'other', title: 'example_portfolio_link.pdf' }]);
  await context.addInitScript(() => {
    if (location.hostname !== 'app.joinhandshake.com') return;
    document.addEventListener('DOMContentLoaded', () => {
      const select = document.querySelector<HTMLSelectElement>('select[data-document-type=other]');
      const original = select?.closest('.field');
      if (!select || !original) return;
      const fieldset = document.createElement('fieldset');
      const heading = document.createElement('h4');
      heading.textContent = 'Attach other required documents';
      const picker = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = 'Search your other documents';
      input.setAttribute('role', 'combobox');
      const list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.hidden = true;
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = 'example_portfolio_link.pdf';
      list.append(option);
      picker.append(input, list);
      select.hidden = true;
      fieldset.append(heading, picker, select);
      original.replaceWith(fieldset);
      input.addEventListener('click', () => {
        list.hidden = false;
      });
      option.addEventListener('click', () => {
        select.value = 'document-other';
        picker.hidden = true;
        const card = document.createElement('div');
        card.className = 'rosetta-inline-alert';
        card.setAttribute('role', 'status');
        const content = document.createElement('div');
        content.className = 'rosetta-inline-alert__content';
        const name = document.createElement('h5');
        name.textContent = 'example_portfolio_link.pdf';
        const preview = document.createElement('a');
        preview.href = '/docs/document-other';
        preview.textContent = 'Preview document';
        content.append(name, preview);
        card.append(content);
        fieldset.append(card);
      });
    });
  });
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      documents: {
        defaultResumeId: 'document-0001',
        otherDocumentId: 'document-other',
        otherDocumentName: 'example_portfolio_link.pdf',
        autoSelectResume: false,
      },
      safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
    },
  });
  await startEngine(sidePanel);
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.items.some((item) => item.jobId === '900001' && item.status === 'applied'),
    { description: 'verified Other document application', timeoutMs: 30_000 },
  );
  expect(
    (await listSubmissions(sidePanel)).filter((attempt) => attempt.jobId === '900001'),
  ).toEqual([
    expect.objectContaining({
      status: 'applied',
      documents: [{ type: 'other', id: 'document-other' }],
    }),
  ]);
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
});
