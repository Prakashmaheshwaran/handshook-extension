import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerTabManager } from '@/core/orchestrator/tabs';
import { createFakeBrowser } from './helpers/fakeBrowser';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RunnerTabManager focus — P1-9', () => {
  it('returns false when there is no extension-owned tab', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    expect(await new RunnerTabManager().focus()).toBe(false);
    expect(fake.windows.update).not.toHaveBeenCalled();
  });

  it('returns true after focusing its own tab, and false once the tab is gone', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/job-search', false);

    expect(await tabs.focus()).toBe(true);
    expect(fake.windows.update).toHaveBeenCalledWith(1, { focused: true });

    fake.tabs.get.mockRejectedValueOnce(new Error('gone'));
    expect(await tabs.focus()).toBe(false);
  });
});

describe('RunnerTabManager ensure — P1-17 never touches a user tab', () => {
  it('creates a new tab instead of reusing an existing Handshake tab', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const userTab = {
      id: 99,
      windowId: 2,
      status: 'complete',
      url: 'https://app.joinhandshake.com/jobs',
    };
    fake.tabs.query.mockResolvedValue([userTab]);

    const tabs = new RunnerTabManager();
    const tabId = await tabs.ensure('https://app.joinhandshake.com/job-search', false);

    expect(tabId).toBe(7);
    expect(fake.tabs.query).not.toHaveBeenCalled();
    expect(fake.tabs.update).not.toHaveBeenCalledWith(99, expect.anything());
    expect(fake.tabs.create).toHaveBeenCalledWith({
      url: 'https://app.joinhandshake.com/job-search',
      active: false,
    });
  });

  it('navigates only the tab it created on a later ensure', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/job-search', false);
    await tabs.ensure('https://app.joinhandshake.com/jobs/900001', false);

    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
    expect(fake.tabs.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ url: 'https://app.joinhandshake.com/jobs/900001' }),
    );
  });
});

describe('RunnerTabManager safety — M12/H2', () => {
  it('reloads the same URL only for a fresh read and waits for the new content script', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    const url = 'https://app.joinhandshake.com/profile/documents';
    await tabs.ensure(url, false);
    fake.tabs.sendMessage.mockClear();
    await tabs.ensure(url, false);
    expect(fake.tabs.reload).not.toHaveBeenCalled();

    // Reload returns before the new document finishes. The old DOM must never
    // satisfy readiness, and events from other tabs must not release the read.
    fake.tabs.reload.mockResolvedValue();
    const reload = tabs.ensure(url, false, { fresh: true });
    await vi.waitFor(() => expect(fake.tabs.reload).toHaveBeenCalledWith(7));
    const onUpdated = fake.tabs.onUpdated.addListener.mock.calls[0]?.[0];
    if (!onUpdated) throw new Error('No navigation listener registered');
    onUpdated(99, { status: 'complete' });
    onUpdated(7, { status: 'loading' });
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
    onUpdated(7, { status: 'complete' });
    expect(await reload).toBe(7);
    expect(fake.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'content.ping' }),
    );
    expect(fake.tabs.onUpdated.removeListener).toHaveBeenCalledWith(onUpdated);
    expect(fake.tabs.create).toHaveBeenCalledOnce();
  });

  it('fails a fresh read without losing runner ownership when reload fails', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    const url = 'https://app.joinhandshake.com/jobs/900001';
    await tabs.ensure(url, false);
    fake.tabs.reload.mockRejectedValueOnce(new Error('Reload failed'));
    await expect(tabs.ensure(url, false, { fresh: true })).rejects.toThrow('Reload failed');
    expect(fake.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    expect(tabs.id).toBe(7);
    expect(fake.tabs.create).toHaveBeenCalledOnce();
  });

  it('refuses to navigate anywhere but an HTTPS Handshake host', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();

    await expect(tabs.ensure('https://evil.example.com/jobs/1', false)).rejects.toThrow(
      /non-Handshake URL/,
    );
    await expect(tabs.ensure('http://app.joinhandshake.com/jobs/1', false)).rejects.toThrow(
      /non-Handshake URL/,
    );
    expect(fake.tabs.create).not.toHaveBeenCalled();
  });

  it('retries an idempotent read once after a lost response', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/job-search', false);

    fake.tabs.sendMessage.mockRejectedValueOnce(new Error('channel closed'));
    const response = await tabs.send<{ ok: boolean }>({
      type: 'content.inspectJob',
      requestId: 'inspect-1',
      jobId: '900001',
    });

    expect(response.ok).toBe(true);
  });

  it('never retries a mutating apply after a lost response', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/jobs/900001', false);
    const pingCalls = fake.tabs.sendMessage.mock.calls.length;

    fake.tabs.sendMessage.mockRejectedValueOnce(new Error('channel closed'));
    const response = await tabs.send(
      {
        type: 'content.apply',
        requestId: 'apply-1',
        job: {
          id: '900001',
          host: 'app.joinhandshake.com',
          title: 'Engineer',
          employer: 'Acme',
          url: 'https://app.joinhandshake.com/jobs/900001',
          description: '',
          applyType: 'quick_apply',
          requiredDocumentTypes: [],
          source: 'search',
          discoveredAt: 1,
        },
        options: {
          mode: 'autopilot',
          documents: {},
          answers: [],
          allowSensitiveAutoSubmit: false,
          allowEeoAutoFill: false,
          allowFreeTextAutoFill: false,
          reviewBeforeSubmit: false,
          stopOnUnknownQuestion: true,
          verifySubmissions: true,
          timeoutMs: 1_000,
        },
      },
      1_000,
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: false } });
    // Only the failed apply send; no wait-for-ready ping or retry.
    expect(fake.tabs.sendMessage.mock.calls.length).toBe(pingCalls + 1);
  });

  it('cancels an in-flight job through the content script', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const tabs = new RunnerTabManager();
    await tabs.ensure('https://app.joinhandshake.com/jobs/900001', false);

    await tabs.cancel('900001');

    expect(fake.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ type: 'content.cancel', jobId: '900001' }),
    );
  });
});
