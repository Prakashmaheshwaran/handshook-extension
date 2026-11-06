/**
 * Minimal fake WebExtension surface for background unit tests.
 *
 * Only the APIs the worker touches are implemented. `tabs.get` always returns
 * the single runner tab after `tabs.create`; tests that need failures override
 * the individual `vi.fn` implementations.
 */

import { vi } from 'vitest';
import { PROTOCOL_VERSION } from '@/core/contracts';

export interface FakeBrowserOptions {
  extensionId?: string;
  openRouterPermission?: boolean;
}

export function createFakeBrowser(options: FakeBrowserOptions = {}) {
  const storage = new Map<string, unknown>();
  let currentUrl = '';
  const runnerTabId = 7;
  const updatedListeners = new Set<(id: number, change: { status?: string }) => void>();

  const fake = {
    runtime: {
      id: options.extensionId ?? 'test-extension',
      sendMessage: vi.fn(async (_message: unknown): Promise<unknown> => undefined),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn(async (): Promise<boolean> => true),
      create: vi.fn(async (): Promise<void> => undefined),
      onAlarm: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (tabId !== runnerTabId) throw new Error('No tab with that id');
        return { id: runnerTabId, windowId: 1, status: 'complete', url: currentUrl };
      }),
      create: vi.fn(async (properties: { url?: string }) => {
        currentUrl = properties?.url ?? 'about:blank';
        return { id: runnerTabId, windowId: 1 };
      }),
      update: vi.fn(async (tabId: number, properties: { url?: string }) => {
        if (tabId !== runnerTabId) throw new Error('No tab with that id');
        if (properties?.url) {
          currentUrl = properties.url;
          for (const listener of updatedListeners) listener(tabId, { status: 'complete' });
        }
        return { id: runnerTabId, windowId: 1, url: currentUrl };
      }),
      query: vi.fn(async (): Promise<unknown[]> => []),
      reload: vi.fn(async (tabId: number): Promise<void> => {
        for (const listener of updatedListeners) listener(tabId, { status: 'complete' });
      }),
      onUpdated: {
        addListener: vi.fn((listener: (id: number, change: { status?: string }) => void) => {
          updatedListeners.add(listener);
        }),
        removeListener: vi.fn((listener: (id: number, change: { status?: string }) => void) => {
          updatedListeners.delete(listener);
        }),
      },
      remove: vi.fn(async (): Promise<void> => undefined),
      sendMessage: vi.fn(async (_tabId: number, request: { type?: string }): Promise<unknown> => {
        if (request?.type === 'content.ping')
          return { protocolVersion: PROTOCOL_VERSION, ok: true, data: { pong: true } };
        return { protocolVersion: PROTOCOL_VERSION, ok: true, data: [] };
      }),
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      update: vi.fn(async (): Promise<void> => undefined),
    },
    storage: {
      local: {
        setAccessLevel: vi.fn(async (): Promise<void> => undefined),
        get: vi.fn(async (keys?: string | string[] | null) => {
          const wanted = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of wanted) {
            if (storage.has(key)) result[key] = storage.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        }),
      },
    },
    permissions: {
      contains: vi.fn(async (): Promise<boolean> => options.openRouterPermission === true),
      request: vi.fn(async (): Promise<boolean> => true),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async (): Promise<void> => undefined),
    },
  };

  return {
    fake,
    storage,
    getCurrentUrl: () => currentUrl,
    runnerTabId,
  };
}

export type FakeBrowser = ReturnType<typeof createFakeBrowser>['fake'];
