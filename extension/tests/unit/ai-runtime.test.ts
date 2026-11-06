import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestOpenRouterHostPermission } from '@/ui/screens/Settings/aiRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestOpenRouterHostPermission — P1-11', () => {
  it('requests the OpenRouter origin on the click', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('browser', { permissions: { request } });

    expect(await requestOpenRouterHostPermission()).toBe('granted');
    expect(request).toHaveBeenCalledWith({
      origins: ['https://openrouter.ai/*'],
    });
  });

  it('reports a denial so the caller can block key storage', async () => {
    vi.stubGlobal('browser', { permissions: { request: vi.fn(async () => false) } });
    expect(await requestOpenRouterHostPermission()).toBe('denied');
  });

  it('is unavailable when the permissions API is missing', async () => {
    vi.stubGlobal('browser', {});
    expect(await requestOpenRouterHostPermission()).toBe('unavailable');
  });
});
