import { describe, expect, it } from 'vitest';
import { jobSchema } from '@/core/contracts';
import { makeJob, makeQueueItem } from '@/test/factories';
import { EXTERNAL_DISMISSED, isExternalJob, safeExternalUrl } from '@/core/util/application-policy';

describe('employer link contract', () => {
  it('round-trips a safe employer URL separately from the canonical Handshake URL', () => {
    const job = makeJob({
      applyType: 'external',
      externalUrl: 'https://careers.example.test/apply?role=123',
    });
    expect(jobSchema.parse(job)).toEqual(job);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    'https://user:password@example.test/apply',
    'https://app.joinhandshake.com/jobs/1001',
    '/apply',
    'broken',
  ])('discards unsafe or non-employer links at the contract boundary: %s', (externalUrl) => {
    expect(safeExternalUrl(externalUrl)).toBeUndefined();
    expect(jobSchema.parse(makeJob({ externalUrl })).externalUrl).toBeUndefined();
  });

  it('recognizes legacy status and error markers even when job details are missing', () => {
    expect(isExternalJob(undefined, makeQueueItem({ status: 'external' }))).toBe(true);
    expect(
      isExternalJob(
        undefined,
        makeQueueItem({
          lastError: { code: 'EXTERNAL_APPLY', message: 'External', retryable: false },
        }),
      ),
    ).toBe(true);
    expect(isExternalJob(undefined, makeQueueItem({ skipReason: EXTERNAL_DISMISSED }))).toBe(true);
    expect(isExternalJob(makeJob(), makeQueueItem())).toBe(false);
  });
});
