import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  isAllowedHandshakeHost,
  parseSettings,
  parseUiRequest,
} from '@/core/contracts';
import {
  isPanelSender,
  isTrustedExtensionSender,
  handleUi,
  registerBackground,
} from '@/background/router';
import { listSelectorHealth } from '@/core/diagnostics/selectorHealth';
import { resetDb } from '@/core/storage/db';
import { loadSettings } from '@/core/storage/settings';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';

let fake: FakeBrowser;

beforeEach(async () => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UI request validation — P2 boundary', () => {
  it('accepts a well-formed request', () => {
    const parsed = parseUiRequest({
      type: 'ui.job.answer',
      requestId: 'r1',
      jobId: '900001',
      questionId: 'q1',
      value: ['yes'],
      remember: true,
    });
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['unknown type', { type: 'ui.nope', requestId: 'r1' }],
    ['missing request id', { type: 'ui.settings.get' }],
    [
      'wrong value type',
      {
        type: 'ui.job.answer',
        requestId: 'r',
        jobId: 'j',
        questionId: 'q',
        value: { nested: true },
        remember: false,
      },
    ],
    ['bad mode', { type: 'ui.engine.start', requestId: 'r', mode: 'turbo' }],
    ['unconfirmed reset', { type: 'ui.data.reset', requestId: 'r', confirm: false }],
    [
      'unknown migration kind',
      { type: 'ui.migration.import', requestId: 'r', kind: 'csv', content: '{}' },
    ],
  ])('rejects %s', (_label, value) => {
    const parsed = parseUiRequest(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('host validation — P1-15', () => {
  it('accepts both Handshake apexes and their subdomains', () => {
    expect(isAllowedHandshakeHost('app.joinhandshake.com')).toBe(true);
    expect(isAllowedHandshakeHost('joinhandshake.com')).toBe(true);
    expect(isAllowedHandshakeHost('app.joinhandshake.co.uk')).toBe(true);
    expect(isAllowedHandshakeHost('JOINHANDSHAKE.CO.UK')).toBe(true);
  });

  it('rejects lookalikes and path tricks', () => {
    expect(isAllowedHandshakeHost('joinhandshake.com.evil.test')).toBe(false);
    expect(isAllowedHandshakeHost('evil-joinhandshake.com')).toBe(false);
    expect(isAllowedHandshakeHost('app.joinhandshake..com')).toBe(false);
    expect(isAllowedHandshakeHost('')).toBe(false);
  });

  it('refuses to persist an invalid host', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, host: 'evil.example.com' }).ok).toBe(false);
    expect(parseSettings({ ...DEFAULT_SETTINGS, host: 'app.joinhandshake.co.uk' }).ok).toBe(true);
  });

  it('persists the host detected by a session check', async () => {
    fake.tabs.sendMessage.mockImplementation(
      async (_tabId: number, request: { type?: string }): Promise<unknown> => {
        if (request?.type === 'content.ping')
          return { protocolVersion: PROTOCOL_VERSION, ok: true, data: { pong: true } };
        if (request?.type === 'content.detectSession') {
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: true,
            data: { status: 'logged_in', host: 'app.joinhandshake.co.uk' },
          };
        }
        return { ok: true, data: [] };
      },
    );

    const result = await handleUi({ type: 'ui.session.check', requestId: 'session-1' });

    expect(result.ok).toBe(true);
    expect((await loadSettings()).host).toBe('app.joinhandshake.co.uk');
  });

  it('ignores a detected host outside the Handshake apexes', async () => {
    fake.tabs.sendMessage.mockImplementation(
      async (_tabId: number, request: { type?: string }): Promise<unknown> => {
        if (request?.type === 'content.ping')
          return { protocolVersion: PROTOCOL_VERSION, ok: true, data: { pong: true } };
        if (request?.type === 'content.detectSession') {
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: true,
            data: { status: 'logged_in', host: 'evil.example.com' },
          };
        }
        return { ok: true, data: [] };
      },
    );

    await handleUi({ type: 'ui.session.check', requestId: 'session-2' });

    expect((await loadSettings()).host).toBe(DEFAULT_SETTINGS.host);
  });
});

describe('AI status — on-device model removed', () => {
  it('reports no on-device availability', async () => {
    const result = await handleUi({ type: 'ui.ai.status', requestId: 'status-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ enabled: true, provider: 'auto' });
      expect(result.data).not.toHaveProperty('availability');
    }
  });
});

describe('sender checks — P2 boundary', () => {
  it('accepts only this extension id, and panels must not be content tabs', () => {
    expect(isTrustedExtensionSender({ id: 'test-extension' })).toBe(true);
    expect(isTrustedExtensionSender({ id: 'someone-else' })).toBe(false);
    expect(isPanelSender({ id: 'test-extension' })).toBe(true);
    expect(
      isPanelSender({
        id: 'test-extension',
        tab: { id: 3, url: 'chrome-extension://test-extension/sidepanel.html' },
      }),
    ).toBe(true);
    expect(
      isPanelSender({
        id: 'test-extension',
        tab: { id: 3, url: 'https://app.joinhandshake.com/jobs' },
      }),
    ).toBe(false);
  });

  it('drops messages from another extension and rejects malformed panel requests', () => {
    registerBackground();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    expect(listener).toBeTypeOf('function');

    const intruderResponse = vi.fn();
    expect(
      listener(
        { type: 'ui.settings.get', requestId: 'r' },
        { id: 'evil-extension' },
        intruderResponse,
      ),
    ).toBe(false);
    expect(intruderResponse).not.toHaveBeenCalled();

    const invalidResponse = vi.fn();
    expect(
      listener(
        {
          type: 'ui.engine.start',
          requestId: 'r',
          mode: 'turbo',
          protocolVersion: PROTOCOL_VERSION,
        },
        { id: 'test-extension' },
        invalidResponse,
      ),
    ).toBe(false);
    expect(invalidResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_INPUT' }),
      }),
    );

    const contentResponse = vi.fn();
    expect(
      listener(
        { type: 'ui.settings.get', requestId: 'r' },
        { id: 'test-extension', tab: { id: 4, url: 'https://app.joinhandshake.com/jobs' } },
        contentResponse,
      ),
    ).toBe(false);
    expect(contentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    );
  });

  it('accepts content events only from this extension', async () => {
    registerBackground();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;

    listener(
      {
        type: 'content.event.selectorHealth',
        protocolVersion: PROTOCOL_VERSION,
        health: {
          at: 1,
          page: 'job',
          selector: 'job.applyButton',
          strategy: 'role=button',
          ok: true,
        },
      },
      { id: 'evil-extension', tab: { id: 4 } },
      vi.fn(),
    );
    expect(await listSelectorHealth()).toEqual([]);

    listener(
      {
        type: 'content.event.selectorHealth',
        protocolVersion: PROTOCOL_VERSION,
        health: {
          at: 1,
          page: 'job',
          selector: 'job.applyButton',
          strategy: 'role=button',
          ok: true,
        },
      },
      { id: 'test-extension', tab: { id: 4, url: 'https://app.joinhandshake.com/jobs/900001' } },
      vi.fn(),
    );
    await vi.waitFor(async () => {
      expect(await listSelectorHealth()).toHaveLength(1);
    });
  });
});
