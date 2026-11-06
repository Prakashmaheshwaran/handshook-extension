import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@/core/contracts';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { getJob } from '@/core/orchestrator/queue';
import { getDb, resetDb } from '@/core/storage/db';
import { putJob } from '@/core/storage/jobs';
import {
  loadAiKeys,
  loadOnboarding,
  loadSettings,
  saveAiKey,
  saveEngineState,
  saveSettings,
} from '@/core/storage/settings';
import { makeEngineState, makeJob } from '@/test/factories';
import { createFakeBrowser } from './helpers/fakeBrowser';

beforeEach(async () => {
  await resetDb();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ui.data.reset — P1-7 clears every piece of local state', () => {
  it('stops the engine, clears the alarm and AI key, resets storage, and broadcasts', async () => {
    const { fake, storage } = createFakeBrowser();
    vi.stubGlobal('browser', fake);

    await saveSettings(mergeSettings(DEFAULT_SETTINGS, { onboardingComplete: true }));
    await saveAiKey('test-openRouter-key-value');
    await saveEngineState(makeEngineState({ status: 'running', mode: 'autopilot' }));
    await putJob(makeJob({ id: '900001' }, 1));

    const result = await handleUi({ type: 'ui.data.reset', requestId: 'reset-1', confirm: true });

    expect(result.ok).toBe(true);
    // Engine stopped, reset to defaults, and its scheduled alarm cleared.
    expect(engine.getState()).toMatchObject({
      status: 'idle',
      mode: DEFAULT_SETTINGS.mode,
      host: DEFAULT_SETTINGS.host,
    });
    expect(fake.alarms.clear).toHaveBeenCalledWith('handshook.tick');
    // AI key removed from chrome.storage.local (outside IndexedDB).
    expect(await loadAiKeys()).toEqual({});
    expect(storage.has('handshook.ai.keys.v1')).toBe(false);
    // Settings and onboarding reset; IndexedDB content gone.
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect((await loadOnboarding()).step).toBe('welcome');
    expect(await getJob('900001')).toBeUndefined();
    // Panel is told about the fresh state and queue.
    const broadcasts = fake.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'state.changed' }),
        expect.objectContaining({ type: 'queue.changed' }),
      ]),
    );
  });

  it('rejects an unconfirmed reset without touching storage', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    await saveAiKey('keep-me');

    const result = await handleUi({
      type: 'ui.data.reset',
      requestId: 'reset-2',
      // Intentionally invalid: the contract only accepts `true`.
      confirm: false as never,
    });

    expect(result.ok).toBe(false);
    expect(await loadAiKeys()).toEqual({ openRouterApiKey: 'keep-me' });
  });
});

describe('M13 — reset cannot claim success while data survives', () => {
  it('rejects when deleteDatabase is blocked by another context', async () => {
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        (request as unknown as { onblocked?: (event: Event) => void }).onblocked?.(
          new Event('blocked'),
        );
      });
      return request;
    });
    try {
      await expect(resetDb()).rejects.toThrow(/another Handshook tab/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses database access while a reset is in flight', async () => {
    let request: IDBOpenDBRequest | undefined;
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      request = {} as IDBOpenDBRequest;
      return request;
    });
    try {
      const resetting = resetDb();
      await expect(getDb()).rejects.toThrow(/being reset/i);
      (request as unknown as { onsuccess?: (event: Event) => void } | undefined)?.onsuccess?.(
        new Event('success'),
      );
      await resetting;
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the reset failure to the panel instead of a false success', async () => {
    const { fake } = createFakeBrowser();
    vi.stubGlobal('browser', fake);
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        (request as unknown as { onblocked?: (event: Event) => void }).onblocked?.(
          new Event('blocked'),
        );
      });
      return request;
    });
    try {
      await expect(
        handleUi({ type: 'ui.data.reset', requestId: 'reset-blocked', confirm: true }),
      ).rejects.toThrow(/another Handshook tab/i);
    } finally {
      spy.mockRestore();
    }
  });
});
