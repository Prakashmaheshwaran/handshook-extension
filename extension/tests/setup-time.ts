import { afterEach, beforeEach, vi } from 'vitest';

// Optional full-suite date probe. Local ISO timestamps deliberately follow TZ.
const systemTime = process.env.HANDSHOOK_TEST_SYSTEM_TIME;
if (systemTime) {
  const date = new Date(systemTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error('HANDSHOOK_TEST_SYSTEM_TIME must be a valid ISO date/time.');
  }
  beforeEach(() => {
    // Keep IndexedDB, DOM waits, and cancellation timers running normally.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(date);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
