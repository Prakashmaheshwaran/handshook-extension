import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBackground } from '@/background/router';
import { PROTOCOL_VERSION } from '@/core/contracts';
import { engine } from '@/core/orchestrator/engine';
import { resetDb } from '@/core/storage/db';
import { makeEngineState } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

beforeEach(async () => {
  await resetDb();
  vi.spyOn(engine, 'load').mockResolvedValue(makeEngineState());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function register() {
  const { fake, storage } = createFakeBrowser();
  vi.stubGlobal('browser', fake);
  registerBackground();
  const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    respond: (value: unknown) => void,
  ) => boolean;
  return { fake, storage, listener };
}

describe('background security startup and health check', () => {
  it('does not recover or run scheduled automation when storage isolation fails', async () => {
    const { fake } = createFakeBrowser();
    fake.storage.local.setAccessLevel.mockRejectedValueOnce(new Error('Fixture isolation failure'));
    vi.stubGlobal('browser', fake);
    const failure = vi.spyOn(engine, 'reportUnexpectedFailure').mockImplementation(() => undefined);
    const onAlarm = vi.spyOn(engine, 'onAlarm').mockResolvedValue(undefined);
    registerBackground();
    const alarmListener = fake.alarms.onAlarm.addListener.mock.calls[0]?.[0] as (alarm: {
      name: string;
    }) => void;
    alarmListener({ name: 'handshook.tick' });
    await vi.waitFor(() => expect(failure).toHaveBeenCalled());
    expect(engine.load).not.toHaveBeenCalled();
    expect(onAlarm).not.toHaveBeenCalled();
  });

  it('validates the ping schema as well as the sender before responding', async () => {
    const { fake, listener } = register();
    const respond = vi.fn();
    listener({ type: 'ping', unexpected: 'untrusted payload' }, { id: fake.runtime.id }, respond);
    listener({ type: 'ping' }, { id: 'foreign' }, respond);
    expect(respond).not.toHaveBeenCalled();
    listener({ type: 'ping' }, { id: fake.runtime.id }, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { pong: true } });
    // Let startup/logging settle before restoring the fake runtime.
    await vi.waitFor(() => expect(fake.storage.local.setAccessLevel).toHaveBeenCalled());
  });

  it('does not process a key message until startup storage isolation finishes', async () => {
    const { fake, storage } = createFakeBrowser();
    let ready: (() => void) | undefined;
    fake.storage.local.setAccessLevel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    vi.stubGlobal('browser', fake);
    registerBackground();
    const listener = fake.runtime.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      respond: (value: unknown) => void,
    ) => boolean;
    const response = new Promise((resolve) =>
      listener(
        {
          type: 'ui.ai.setKey',
          requestId: 'key',
          protocolVersion: PROTOCOL_VERSION,
          apiKey: 'sk-or-v1-fixture-key',
        },
        { id: fake.runtime.id },
        resolve,
      ),
    );
    expect(storage.has('handshook.ai.keys.v1')).toBe(false);
    ready?.();
    await expect(response).resolves.toMatchObject({ ok: true, data: { saved: true } });
    expect(storage.has('handshook.ai.keys.v1')).toBe(true);
    expect(JSON.stringify(fake.runtime.sendMessage.mock.calls)).not.toContain(
      'sk-or-v1-fixture-key',
    );
    expect(JSON.stringify(await response)).not.toContain('sk-or-v1-fixture-key');
  });
});
