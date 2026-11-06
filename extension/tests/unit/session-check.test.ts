import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUi } from '@/background/router';
import { engine } from '@/core/orchestrator/engine';
import { RunnerTabManager, runnerTabs } from '@/core/orchestrator/tabs';
import { resetDb } from '@/core/storage/db';
import { makeEngineState } from '@/test/factories';
import type { SessionPayload } from '@/ui/bridge';
import { createFakeBrowser, type FakeBrowser } from './helpers/fakeBrowser';

let fake: FakeBrowser;

beforeEach(async () => {
  ({ fake } = createFakeBrowser());
  vi.stubGlobal('browser', fake);
  window.localStorage.clear();
  await resetDb();
  vi.spyOn(engine, 'load').mockResolvedValue(makeEngineState({ status: 'needs_user' }));
  vi.spyOn(engine, 'isRunnerBusy').mockReturnValue(false);
  vi.spyOn(runnerTabs, 'allowRecreate').mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function probeResponse(status: string, host = 'app.joinhandshake.com') {
  return { requestId: 'session', ok: true as const, data: { status, host } };
}

function sendFailure(message: string) {
  return {
    requestId: 'session',
    ok: false as const,
    error: { code: 'TIMEOUT' as const, message, retryable: true },
  };
}

/** Only the owned runner tab is ever read; tab id 7 is the fake runner. */
function runnerPresent(existingTabId: number | null): void {
  vi.spyOn(runnerTabs, 'withForeground').mockImplementation(async (run) => run(existingTabId));
}

async function checkSession(): Promise<SessionPayload> {
  const result = await handleUi({ type: 'ui.session.check', requestId: 'session' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a successful check');
  return result.data as SessionPayload;
}

describe('session check reports what actually happened', () => {
  it('reads the loaded runner page before reloading anything', async () => {
    runnerPresent(7);
    const send = vi.spyOn(runnerTabs, 'send').mockResolvedValue(probeResponse('logged_in'));
    const ensure = vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);

    const payload = await checkSession();

    expect(send).toHaveBeenCalledTimes(1);
    expect(ensure).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      status: 'logged_in',
      host: 'app.joinhandshake.com',
      checkedIn: 'runner',
    });
    expect(payload.checkedAt).toBeGreaterThan(0);
  });

  it('reloads only after an unknown answer and reports the fresh page', async () => {
    runnerPresent(7);
    const send = vi
      .spyOn(runnerTabs, 'send')
      .mockResolvedValueOnce(probeResponse('unknown'))
      .mockResolvedValueOnce(probeResponse('logged_in'));
    const ensure = vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);

    const payload = await checkSession();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('https://app.joinhandshake.com/', true, { fresh: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(payload.status).toBe('logged_in');
  });

  it('reloads after a signed-out answer and reports signed out only when the fresh page agrees', async () => {
    runnerPresent(7);
    const send = vi
      .spyOn(runnerTabs, 'send')
      .mockResolvedValueOnce(probeResponse('logged_out'))
      .mockResolvedValueOnce(probeResponse('logged_out'));
    vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);

    const payload = await checkSession();

    expect(send).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({ status: 'logged_out', host: 'app.joinhandshake.com' });
  });

  it('opens the runner once when no tab exists yet', async () => {
    runnerPresent(null);
    vi.spyOn(runnerTabs, 'send').mockResolvedValue(probeResponse('logged_in'));
    const ensure = vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);

    const payload = await checkSession();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(payload.status).toBe('logged_in');
  });

  it('never turns a silent content script into "not signed in"', async () => {
    runnerPresent(7);
    const send = vi
      .spyOn(runnerTabs, 'send')
      .mockResolvedValue(sendFailure('Content script did not respond'));
    vi.spyOn(runnerTabs, 'ensure').mockResolvedValue(7);

    const payload = await checkSession();

    expect(send).toHaveBeenCalledTimes(2);
    expect(payload.status).toBe('unknown');
    expect(payload.status).not.toBe('logged_out');
    expect(payload.detail).toContain('did not respond');
  });

  it('reports a runner that cannot load as unknown with a reason', async () => {
    runnerPresent(7);
    vi.spyOn(runnerTabs, 'send').mockResolvedValue(probeResponse('unknown'));
    vi.spyOn(runnerTabs, 'ensure').mockRejectedValue(new Error('Runner tab did not load'));

    const payload = await checkSession();

    expect(payload.status).toBe('unknown');
    expect(payload.detail).toContain('did not load');
  });
});

describe('RunnerTabManager.withForeground', () => {
  async function manager(): Promise<RunnerTabManager> {
    const created = createFakeBrowser();
    vi.stubGlobal('browser', created.fake);
    fake = created.fake;
    const instance = new RunnerTabManager();
    await instance.ensure('https://app.joinhandshake.com/', false);
    return instance;
  }

  it('activates the owned runner and restores the previously active tab', async () => {
    const instance = await manager();
    fake.tabs.query.mockResolvedValue([{ id: 3, windowId: 1, active: true }]);
    vi.mocked(fake.tabs.update).mockClear();

    const seen = await instance.withForeground(async (tabId) => tabId);

    expect(seen).toBe(7);
    expect(fake.tabs.update).toHaveBeenNthCalledWith(1, 7, { active: true });
    expect(fake.tabs.update).toHaveBeenNthCalledWith(2, 3, { active: true });
  });

  it('leaves an already active runner alone', async () => {
    const instance = await manager();
    const activeTab = {
      id: 7,
      windowId: 1,
      active: true,
      status: 'complete',
      url: 'https://app.joinhandshake.com/',
    };
    fake.tabs.get.mockResolvedValue(
      activeTab as unknown as Awaited<ReturnType<typeof fake.tabs.get>>,
    );
    fake.tabs.query.mockResolvedValue([{ id: 7, windowId: 1, active: true }]);
    vi.mocked(fake.tabs.update).mockClear();

    await instance.withForeground(async (tabId) => tabId);

    expect(fake.tabs.update).not.toHaveBeenCalled();
  });

  it('does not create or steal a tab when no runner exists', async () => {
    const created = createFakeBrowser();
    vi.stubGlobal('browser', created.fake);
    const instance = new RunnerTabManager();
    vi.mocked(created.fake.tabs.create).mockClear();

    const seen = await instance.withForeground(async (tabId) => tabId);

    expect(seen).toBeNull();
    expect(created.fake.tabs.create).not.toHaveBeenCalled();
  });
});
