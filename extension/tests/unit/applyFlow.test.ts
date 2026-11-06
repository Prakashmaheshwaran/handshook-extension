import { afterEach, describe, expect, it } from 'vitest';
import { classifySubmitFailure } from '@/handshake/applyFlow';
import { detectValidationErrors } from '@/handshake/verification';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('classifySubmitFailure', () => {
  it('maps rate-limit copy to a retryable RATE_LIMITED error', () => {
    const error = classifySubmitFailure(['Too many requests. Please wait a moment.']);

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
  });

  it('maps permission copy to FORBIDDEN so the run pauses instead of retrying', () => {
    const error = classifySubmitFailure(['You do not have permission to apply to this job.']);

    expect(error.code).toBe('FORBIDDEN');
    expect(error.retryable).toBe(false);
  });

  it('keeps unrecognized copy as a non-retryable UNKNOWN failure', () => {
    const error = classifySubmitFailure(['That did not work.']);

    expect(error.code).toBe('UNKNOWN');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('That did not work.');
  });
});

describe('detectValidationErrors', () => {
  it('surfaces a permission banner rendered by the site', () => {
    document.body.innerHTML = `
      <p role="alert">You do not have permission to apply to this job.</p>
    `;

    expect(detectValidationErrors(document)).toEqual([
      'you do not have permission to apply to this job',
    ]);
  });

  it('ignores visible copy that is not an error', () => {
    document.body.innerHTML = `<p role="alert">Processing your application</p>`;

    expect(detectValidationErrors(document)).toEqual([]);
  });
});
