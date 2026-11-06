import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PROTOCOL_VERSION, contentRequestSchema, type ApplyOptions } from '@/core/contracts';
import { registerContentBridge, registerContentCommand, sendContentEvent } from '@/content/bridge';
import { registerContentRouter } from '@/content/router';
import { RunnerTabManager } from '@/core/orchestrator/tabs';
import { makeJob, makeDocument, makeAnswer } from '@/test/factories';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';

vi.mock('@/content/lifecycle', () => ({ watchRoute: vi.fn() }));

let fake: FakeBrowser;
beforeEach(() => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bridge() {
  const handler = vi.fn(async (request: { requestId: string }) => ({
    requestId: request.requestId,
    ok: true as const,
    data: { pong: true },
  }));
  registerContentBridge(handler);
  const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    respond: (value: unknown) => void,
  ) => boolean;
  return { handler, listener };
}
const ping = { type: 'content.ping', requestId: 'ping-1', protocolVersion: PROTOCOL_VERSION };

describe('worker to content boundary', () => {
  it('validates sender, version and payload before invoking any handler', async () => {
    const { handler, listener } = bridge();
    for (const sender of [{ id: 'foreign' }, {}, { id: fake.runtime.id, tab: { id: 2 } }]) {
      expect(listener(ping, sender, vi.fn())).toBe(false);
    }
    const mismatch = vi.fn();
    listener({ ...ping, protocolVersion: 999 }, { id: fake.runtime.id }, mismatch);
    expect(mismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: PROTOCOL_VERSION,
        ok: false,
        error: expect.objectContaining({
          code: 'PROTOCOL_MISMATCH',
          message: expect.stringMatching(/Reload/),
        }),
      }),
    );
    const invalid = vi.fn();
    listener(
      { type: 'content.apply', requestId: 'r', protocolVersion: PROTOCOL_VERSION },
      { id: fake.runtime.id },
      invalid,
    );
    expect(invalid).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_INPUT' }),
      }),
    );
    expect(handler).not.toHaveBeenCalled();
    const response = await new Promise((resolve) =>
      listener(ping, { id: fake.runtime.id }, resolve),
    );
    expect(response).toMatchObject({
      requestId: 'ping-1',
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports additional schema-registered commands behind the same gate', async () => {
    const handler = vi.fn(async (request: { requestId: string }) => ({
      requestId: request.requestId,
      ok: true as const,
      data: true,
    }));
    registerContentCommand(
      'content.testCommand',
      z.object({ requestId: z.string(), jobId: z.string() }),
      handler,
    );
    const { listener } = bridge();
    const message = {
      type: 'content.testCommand',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'extra',
      jobId: '900001',
    };
    listener(message, { id: 'foreign' }, vi.fn());
    expect(handler).not.toHaveBeenCalled();
    await new Promise((resolve) => listener(message, { id: fake.runtime.id }, resolve));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('registers submit revocation behind the common sender, version and schema gates', async () => {
    registerContentRouter();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      respond: (value: unknown) => void,
    ) => boolean;
    const request = {
      type: 'content.revokeSubmit',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'revoke',
      jobId: '900001',
      applyRequestId: 'attempt',
    };
    expect(listener(request, { id: 'foreign' }, vi.fn())).toBe(false);
    const mismatch = vi.fn();
    expect(listener({ ...request, protocolVersion: 99 }, { id: fake.runtime.id }, mismatch)).toBe(
      false,
    );
    expect(mismatch).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    const invalid = await new Promise((resolve) =>
      listener({ ...request, applyRequestId: null }, { id: fake.runtime.id }, resolve),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const response = await new Promise((resolve) =>
      listener(request, { id: fake.runtime.id }, resolve),
    );
    expect(response).toMatchObject({
      requestId: request.requestId,
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      data: { revoked: true },
    });
  });

  it.each([false, true])(
    'keeps every apply option and document field after validation (None=%s)',
    (none) => {
      const options = {
        mode: 'review',
        documents: {
          resumeId: 'resume',
          coverLetterId: none ? '' : 'cover',
          transcriptId: none ? '' : 'transcript',
          otherDocumentId: none ? '' : 'other',
        },
        documentsAvailable: [
          makeDocument({
            filename: 'fixture.pdf',
            description: 'Sanitized fixture metadata',
            updatedAt: '2026-10-27',
            isDefault: true,
          }),
        ],
        answers: [makeAnswer({ id: 'answer-1', autoSubmitAllowed: false })],
        explicitAnswerIds: ['answer-1'],
        allowOneClickApply: !none,
        allowSensitiveAutoSubmit: false,
        allowEeoAutoFill: false,
        allowFreeTextAutoFill: false,
        reviewBeforeSubmit: true,
        stopOnUnknownQuestion: true,
        verifySubmissions: true,
        timeoutMs: 1000,
        humanDelay: { minMs: 400, maxMs: 1200 },
      } satisfies Required<ApplyOptions>;
      const parsed = contentRequestSchema.parse({
        type: 'content.apply',
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'attempt',
        job: makeJob(),
        options,
      });
      if (parsed.type !== 'content.apply') throw new Error('Expected apply command');
      expect(parsed.options).toEqual(options);
    },
  );

  it('parses all supported commands with their required fields', () => {
    const commands = [
      { type: 'content.ping' },
      { type: 'content.detectSession' },
      {
        type: 'content.scan',
        options: {
          searchUrl: 'https://app.joinhandshake.com/job-search',
          maxJobs: 10,
          maxPages: 1,
          pageDelayMs: 0,
        },
      },
      { type: 'content.inspectJob', jobId: '900001' },
      { type: 'content.cancel', jobId: '900001' },
      {
        type: 'content.verifySubmission',
        jobId: '900001',
        host: 'app.joinhandshake.com',
        attemptId: 'attempt',
        timeoutMs: 1000,
      },
    ];
    for (const command of commands)
      expect(
        contentRequestSchema.safeParse({
          ...command,
          requestId: 'r',
          protocolVersion: PROTOCOL_VERSION,
        }).success,
      ).toBe(true);
    const verification = contentRequestSchema.parse({
      ...commands.at(-1),
      requestId: 'verify',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(verification).toMatchObject({ host: 'app.joinhandshake.com' });
  });

  it('adds a protocol version to outgoing content events', async () => {
    await sendContentEvent({
      type: 'content.event.session',
      host: 'app.joinhandshake.com',
      status: 'logged_out',
    });
    expect(fake.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: PROTOCOL_VERSION }),
    );
  });

  it('requires a refreshed tab when an old content script answers the readiness ping', async () => {
    fake.tabs.sendMessage.mockResolvedValue({ ok: true, data: { pong: true } });
    await expect(
      new RunnerTabManager().ensure('https://app.joinhandshake.com/job-search'),
    ).rejects.toThrow(/Reload the Handshake tab/);
    expect(fake.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
});
