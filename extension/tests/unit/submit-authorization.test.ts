import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestSubmitAuthorization } from '@/content/submit-authorization';
import { PROTOCOL_VERSION } from '@/core/contracts';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';

let fake: FakeBrowser;
beforeEach(() => {
  fake = createFakeBrowser().fake;
  vi.stubGlobal('browser', fake);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('submit authorization transport fails closed', () => {
  it('accepts a matching positive response and binds the original apply request', async () => {
    fake.runtime.sendMessage.mockImplementation(async (message: unknown) => {
      expect(message).toMatchObject({
        type: 'engine.authorizeSubmit',
        jobId: '900001',
        applyRequestId: 'attempt-1',
        protocolVersion: PROTOCOL_VERSION,
      });
      return {
        requestId: (message as { requestId: string }).requestId,
        protocolVersion: PROTOCOL_VERSION,
        ok: true,
        data: { authorized: true },
      };
    });
    expect(await requestSubmitAuthorization('900001', 'attempt-1')).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { ok: true, data: { authorized: true } },
    { requestId: 'stale', ok: true, data: { authorized: true } },
    { requestId: 'stale', ok: false, error: { code: 'UNKNOWN' } },
  ])('denies a missing, invalid or mismatched response: %j', async (reply) => {
    fake.runtime.sendMessage.mockResolvedValue(reply);
    expect(await requestSubmitAuthorization('900001', 'attempt-1')).toBe(false);
  });

  it('denies a channel error', async () => {
    fake.runtime.sendMessage.mockRejectedValue(new Error('Background unavailable'));
    expect(await requestSubmitAuthorization('900001', 'attempt-1')).toBe(false);
  });

  it.each([undefined, 99])(
    'denies an otherwise matching grant with protocolVersion=%s',
    async (protocolVersion) => {
      fake.runtime.sendMessage.mockImplementation(async (message: unknown) => ({
        requestId: (message as { requestId: string }).requestId,
        protocolVersion,
        ok: true,
        data: { authorized: true },
      }));
      expect(await requestSubmitAuthorization('900001', 'attempt-1')).toBe(false);
    },
  );

  it('denies after two seconds when the background does not answer', async () => {
    vi.useFakeTimers();
    fake.runtime.sendMessage.mockImplementation(() => new Promise(() => {}));
    const pending = requestSubmitAuthorization('900001', 'attempt-1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
