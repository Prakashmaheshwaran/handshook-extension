import { expect, test } from '../helpers/extension';
import { installHandshakeRoutes } from '../helpers/handshake';
import { getQueue, listSubmissions, seedExtension, startEngine, waitFor } from '../helpers/seed';
import { SAMPLE_JOBS } from '../../../src/test/mockData';

test('Autopilot submits an explicit no-documents dialog once after fresh setup', async ({
  context,
  sidePanel,
}) => {
  const mock = await installHandshakeRoutes(context, 'no-additional-documents');
  mock.setSearchJobs([SAMPLE_JOBS[0]!]);
  await seedExtension(sidePanel, {
    settings: {
      mode: 'autopilot',
      documents: {
        defaultResumeId: 'document-0001',
        coverLetterId: 'document-0003',
        transcriptId: 'document-0004',
        otherDocumentId: 'document-0005',
        autoSelectResume: false,
      },
      safety: { reviewBeforeSubmit: false, allowOneClickApply: true },
    },
  });
  await startEngine(sidePanel);
  await waitFor(
    () => getQueue(sidePanel),
    (queue) => queue.items.some((item) => item.jobId === '900001' && item.status === 'applied'),
    { description: 'document-free application confirmed', timeoutMs: 30_000 },
  );
  const item = (await getQueue(sidePanel)).items.find((entry) => entry.jobId === '900001');
  expect(item?.missingDocumentTypes ?? []).toEqual([]);
  expect((await listSubmissions(sidePanel)).filter((entry) => entry.jobId === '900001')).toEqual([
    expect.objectContaining({ status: 'applied', documents: [] }),
  ]);
  expect(mock.requestsFor('/jobs/900001/applications')).toHaveLength(1);
});
