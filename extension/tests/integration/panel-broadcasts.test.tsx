import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ContentRequest, type QueuePayload } from '@/core/contracts';
import { makeEngineState, makeEvent, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { createFakeBrowser, type FakeBrowser } from '../unit/helpers/fakeBrowser';

const panelRuntime = vi.hoisted(() => ({
  id: 'test-extension',
  sendMessage: vi.fn(),
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: { runtime: panelRuntime } }));

import { broadcast, registerBackground } from '@/background/router';
import { Engine, engine } from '@/core/orchestrator/engine';
import type { RunnerTabManager } from '@/core/orchestrator/tabs';
import { putJob, putQueueItem } from '@/core/orchestrator/queue';
import { resetDb } from '@/core/storage/db';
import { listEvents } from '@/core/logging/eventStore';
import { saveEngineState, saveSettings } from '@/core/storage/settings';
import { resetMockStore } from '@/ui/bridge';
import { useEngineState } from '@/ui/hooks/useEngineState';
import { useQueue } from '@/ui/hooks/useQueue';
import { useEvents } from '@/ui/hooks/useEvents';
import { useToasts } from '@/ui/hooks/useToasts';
import { ToastViewport } from '@/ui/components/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Listener = (message: unknown, sender: unknown) => void;
let listeners: Set<Listener>;
let fake: FakeBrowser;
let container: HTMLDivElement;
let root: Root;
let payload: QueuePayload;

function Harness() {
  const state = useEngineState();
  const queue = useQueue();
  const events = useEvents();
  const toasts = useToasts();
  return (
    <>
      <div data-testid="state">{state.state?.message}</div>
      <div data-testid="count">{queue.summary?.total}</div>
      <div data-testid="needs">{queue.needs.map((need) => need.message).join(', ')}</div>
      <div data-testid="events">{events.events.map((event) => event.message).join(', ')}</div>
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

async function mount() {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(async () => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
  await resetDb();
  resetMockStore();
  listeners = new Set();
  panelRuntime.onMessage.addListener.mockImplementation((listener: Listener) =>
    listeners.add(listener),
  );
  panelRuntime.onMessage.removeListener.mockImplementation((listener: Listener) =>
    listeners.delete(listener),
  );
  payload = {
    jobs: [],
    items: [],
    needs: [],
    summary: { counts: {}, total: 0, todayCount: 0, dailyCap: 25, remainingToday: 25 },
  };
  panelRuntime.sendMessage.mockImplementation(
    async (message: { type: string; requestId: string }) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: true,
      data:
        message.type === 'ui.queue.list'
          ? payload
          : message.type === 'ui.events.list'
            ? []
            : makeEngineState({ message: 'Initial state' }),
    }),
  );
  fake.runtime.sendMessage.mockImplementation(async (message: unknown) => {
    for (const listener of listeners) listener(message, { id: fake.runtime.id });
  });
  registerBackground();
  await engine.resetForDataClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('live side-panel broadcasts', () => {
  it('wires the production engine to a registered panel listener without waiting for polling', async () => {
    await mount();
    panelRuntime.sendMessage.mockClear();
    await act(async () => {
      await engine.stop();
    });
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('Stopped');
    expect(
      panelRuntime.sendMessage.mock.calls.filter(
        ([message]) => message.type === 'ui.engine.getState',
      ),
    ).toHaveLength(0);
  });

  it('updates queue summaries, Needs You and activity as soon as a broadcast arrives', async () => {
    await mount();
    const job = makeJob();
    payload = {
      jobs: [job],
      items: [makeQueueItem({ jobId: job.id, status: 'ready_for_review' })],
      summary: { ...payload.summary, total: 1 },
      needs: [
        {
          jobId: job.id,
          jobTitle: job.title,
          employer: job.employer,
          questions: [],
          missingDocumentTypes: [],
          reason: 'review',
          message: 'Ready for your review',
          createdAt: Date.now(),
        },
      ],
    };
    await act(async () => {
      broadcast({ type: 'queue.changed', summary: payload.summary });
      broadcast({ type: 'needs.you', jobId: job.id });
      broadcast({ type: 'event.appended', event: makeEvent({ message: 'Application ready' }) });
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="needs"]')?.textContent).toContain(
      'Ready for your review',
    );
    expect(container.querySelector('[data-testid="events"]')?.textContent).toContain(
      'Application ready',
    );
  });

  it('keeps external jobs out of runner navigation, toast broadcasts and Activity', async () => {
    await mount();
    const job = makeJob({ applyType: 'external' });
    await putJob(job);
    await putQueueItem(makeQueueItem({ jobId: job.id, status: 'queued' }));
    await saveSettings(makeSettings({ pacing: { activeHours: null } }));
    await saveEngineState(makeEngineState({ status: 'running', scanComplete: true }));
    const tabs = {
      ensure: vi.fn(async () => 7),
      send: vi.fn(async (request: ContentRequest) => ({
        requestId: request.requestId,
        ok: true,
        data: job,
      })),
    } as unknown as RunnerTabManager;
    const running = new Engine({ tabs, broadcast });
    await act(async () => {
      await running.load();
      await running.tick();
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(tabs.ensure).not.toHaveBeenCalled();
    expect(tabs.send).not.toHaveBeenCalled();
    const stored = await listEvents(50);
    expect(stored.some((event) => event.jobId === job.id)).toBe(false);
    expect(fake.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toast' }),
    );
    expect(running.getState().todayCount).toBe(0);
  });

  it('does not fail when the panel is closed and runtime messaging has no receiver', async () => {
    fake.runtime.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    await expect(engine.stop()).resolves.toMatchObject({ status: 'idle' });
    await Promise.resolve();
  });

  it('ignores malformed broadcasts and forged pushes from a content tab', async () => {
    await mount();
    await act(async () => {
      for (const listener of listeners) {
        listener(
          { type: 'state.changed', protocolVersion: PROTOCOL_VERSION, state: null },
          { id: fake.runtime.id },
        );
        listener(
          { type: 'toast', protocolVersion: PROTOCOL_VERSION, level: 'error', message: 'Forged' },
          { id: fake.runtime.id, tab: { id: 7 } },
        );
      }
    });
    expect(container.textContent).not.toContain('Forged');
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('Initial state');
  });

  it('keeps newer pushed state when an older poll response arrives later', async () => {
    await mount();
    let release: ((value: unknown) => void) | undefined;
    panelRuntime.sendMessage.mockImplementation((message: { requestId: string; type: string }) => {
      if (message.type === 'ui.engine.getState')
        return new Promise((resolve) => {
          release = (data) =>
            resolve({
              protocolVersion: PROTOCOL_VERSION,
              requestId: message.requestId,
              ok: true,
              data,
            });
        });
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        ok: true,
        data: payload,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(release).toBeTypeOf('function');
    await act(async () => {
      broadcast({ type: 'state.changed', state: makeEngineState({ message: 'Newest state' }) });
      release?.(makeEngineState({ message: 'Stale poll' }));
    });
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('Newest state');
  });

  it('keeps its listener and accepts pushes after the background is registered again', async () => {
    await mount();
    registerBackground();
    await act(async () => {
      await engine.stop();
    });
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('Stopped');
  });
});
