import {
  LIMITS,
  PROTOCOL_VERSION,
  PROTOCOL_RELOAD_MESSAGE,
  validateProtocolEnvelope,
  type ContentRequest,
  type MessageResponse,
} from '@/core/contracts';
import { isAllowedHandshakeUrl } from '@/core/util/urls';
import { sleep } from '@/core/util/time';
import { readSession, RUNNER_SESSION_KEY, runnerSessionSchema, writeSession } from './session';

export class RunnerTabClosedError extends Error {
  constructor() {
    super('The Handshook runner tab was closed. Resume to open a new runner.');
  }
}

/** Requests that are safe to retry after a lost response. */
const IDEMPOTENT_REQUESTS: ReadonlySet<ContentRequest['type']> = new Set([
  'content.ping',
  'content.detectSession',
  'content.scan',
  'content.inspectJob',
  'content.verifySubmission',
]);

/**
 * M12: the runner must never navigate anywhere except a Handshake host. Imported
 * searches/jobs and settings are validated separately; this is the last gate.
 */
function assertAllowedRunnerUrl(url: string): void {
  if (!isAllowedHandshakeUrl(url)) {
    throw new Error('Refusing to open a non-Handshake URL in the runner tab');
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export class RunnerTabManager {
  private tabId: number | null = null;
  private restored: Promise<void> | null = null;
  private closed = false;
  private operation: Promise<unknown> = Promise.resolve();

  async restore(): Promise<void> {
    this.restored ??= (async () => {
      const stored = await readSession(RUNNER_SESSION_KEY, runnerSessionSchema);
      this.tabId = stored?.tabId ?? null;
      if (this.tabId !== null) {
        try {
          const tab = await browser.tabs.get(this.tabId);
          if (tab.id === undefined) throw new RunnerTabClosedError();
        } catch {
          await this.forget(true);
        }
      }
    })();
    await this.restored;
  }

  get wasClosed(): boolean {
    return this.closed;
  }

  async allowRecreate(): Promise<void> {
    await this.restore();
    this.closed = false;
  }

  private async forget(closed: boolean): Promise<void> {
    this.tabId = null;
    this.closed = closed;
    await writeSession(RUNNER_SESSION_KEY, { tabId: null });
  }

  async onRemoved(tabId: number): Promise<boolean> {
    // A removal event can itself wake a fresh worker. Read ownership before
    // validating the (now missing) tab, so that event still pauses the run.
    const stored = await readSession(RUNNER_SESSION_KEY, runnerSessionSchema);
    if (tabId !== this.tabId && tabId !== stored?.tabId) return false;
    await this.forget(true);
    return true;
  }

  async ensure(url: string, active = true, options: { fresh?: boolean } = {}): Promise<number> {
    assertAllowedRunnerUrl(url);
    // Session/document reads and engine navigation share this manager. Serialize
    // creation so concurrent cold-start requests cannot allocate two runners.
    const operation = this.operation.then(() => this.ensureOwned(url, active, options.fresh));
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  private async ensureOwned(url: string, active: boolean, fresh = false): Promise<number> {
    await this.restore();
    if (this.closed) throw new RunnerTabClosedError();
    if (this.tabId !== null) {
      const existing = await browser.tabs.get(this.tabId).catch(() => undefined);
      if (existing?.id === undefined) {
        await this.forget(true);
        throw new RunnerTabClosedError();
      }
      const existingId = existing.id;
      try {
        if (existing.url === url && fresh) {
          if (active) await browser.tabs.update(existingId, { active: true });
          await this.loadUntilReady(existingId, () => browser.tabs.reload(existingId));
        } else if (existing.url !== url) {
          if (fresh) {
            await this.loadUntilReady(existingId, () =>
              browser.tabs.update(existingId, { url, active }),
            );
          } else {
            await browser.tabs.update(existing.id, { url, active });
            await this.waitUntilReady(existing.id);
          }
        } else if (active) {
          await browser.tabs.update(existing.id, { active: true });
        }
      } catch (error) {
        if (!(await this.isAlive())) throw new RunnerTabClosedError();
        throw error;
      }
      return existing.id;
    }

    // Never reuse or navigate a tab the user opened: the runner only owns the
    // tab it created itself, including ownership restored from session storage.
    const tab = await browser.tabs.create({ url, active });
    if (tab.id === undefined) throw new Error('Could not create runner tab');
    this.tabId = tab.id;
    await writeSession(RUNNER_SESSION_KEY, { tabId: tab.id });
    try {
      await browser.tabs.update(tab.id, { pinned: true, autoDiscardable: false });
    } catch {
      // Older Chromium versions may not support autoDiscardable.
    }
    await this.waitUntilReady(tab.id);
    return tab.id;
  }

  private async loadUntilReady(tabId: number, load: () => Promise<unknown>): Promise<void> {
    // A ping immediately after reload can still be answered by the old content
    // script. Observe completion of the new load before asking it for readiness.
    let completed = (): void => {};
    const loaded = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const onUpdated = (id: number, change: { status?: string }): void => {
      if (id === tabId && change.status === 'complete') completed();
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    try {
      await withTimeout(
        Promise.all([load(), loaded]),
        20_000,
        'Runner tab reload did not complete',
      );
      await this.waitUntilReady(tabId);
    } finally {
      browser.tabs.onUpdated.removeListener(onUpdated);
    }
  }

  get id(): number | null {
    return this.tabId;
  }

  /**
   * Runs `run` with the owned runner tab visible. Chromium throttles timers in
   * background tabs, and a cold page is exactly when the session check needs to
   * keep observing. The extension only ever activates the tab it created, and
   * it puts the tab the user was looking at back afterwards. `run` receives
   * `null` when no runner exists yet so it can create one with `ensure`.
   */
  async withForeground<T>(run: (tabId: number | null) => Promise<T>): Promise<T> {
    await this.restore();
    const existing =
      this.tabId === null ? undefined : await browser.tabs.get(this.tabId).catch(() => undefined);
    const existingId = existing?.id ?? null;
    const previousActiveId = await this.activeTabId(existing?.windowId);
    if (existingId !== null && existing?.active !== true) {
      // Foregrounding is best-effort: a throttled tab can still answer.
      await browser.tabs.update(existingId, { active: true }).catch(() => undefined);
    }
    try {
      return await run(existingId);
    } finally {
      if (previousActiveId !== undefined && previousActiveId !== existingId) {
        await browser.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
      }
    }
  }

  /** The tab the user was looking at, before the runner takes focus. */
  private async activeTabId(windowId: number | undefined): Promise<number | undefined> {
    try {
      const active =
        windowId === undefined
          ? await browser.tabs.query({ active: true, lastFocusedWindow: true })
          : await browser.tabs.query({ active: true, windowId });
      return active.find((tab) => tab.id !== undefined)?.id;
    } catch {
      return undefined;
    }
  }

  /** Focuses the runner tab. Returns false when no extension-owned tab exists. */
  async focus(): Promise<boolean> {
    await this.restore();
    if (this.tabId === null) return false;
    const tab = await browser.tabs.get(this.tabId).catch(() => undefined);
    if (tab?.id === undefined) {
      await this.forget(true);
      return false;
    }
    try {
      await browser.tabs.update(this.tabId, { active: true });
      if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
      return true;
    } catch {
      // A focus/window error does not prove the owned tab was closed.
      if (!(await this.isAlive())) await this.forget(true);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.restore();
    if (this.tabId === null) return;
    const tabId = this.tabId;
    await this.forget(false);
    try {
      await browser.tabs.remove(tabId);
    } catch {
      // Already gone.
    }
  }

  /**
   * H1: aborts an in-flight content operation (the content router tracks
   * `content.apply` per job id). Best-effort: a closed tab is already safe.
   */
  async cancel(jobId: string): Promise<void> {
    if (this.tabId === null) return;
    try {
      await withTimeout(
        browser.tabs.sendMessage(this.tabId, {
          protocolVersion: PROTOCOL_VERSION,
          type: 'content.cancel',
          requestId: `cancel-${Date.now()}`,
          jobId,
        } satisfies ContentRequest & { protocolVersion: number }),
        2_000,
        'Cancel did not respond',
      );
    } catch {
      // The tab may already be gone.
    }
  }

  async isAlive(): Promise<boolean> {
    await this.restore();
    if (this.tabId === null) return false;
    try {
      const tab = await browser.tabs.get(this.tabId);
      if (tab?.id !== undefined) return true;
      await this.forget(true);
      return false;
    } catch {
      await this.forget(true);
      return false;
    }
  }

  async send<T>(
    request: ContentRequest,
    timeoutMs: number = LIMITS.defaultRequestTimeoutMs,
  ): Promise<MessageResponse<T>> {
    if (this.tabId === null) {
      return {
        requestId: request.requestId,
        ok: false,
        error: { code: 'UNKNOWN', message: 'Runner tab is not open', retryable: false },
      };
    }
    const sendOnce = async (): Promise<MessageResponse<T>> => {
      const result = await withTimeout(
        browser.tabs.sendMessage(this.tabId as number, {
          ...request,
          protocolVersion: PROTOCOL_VERSION,
        }),
        timeoutMs,
        'Content script did not respond',
      );
      const protocol = validateProtocolEnvelope(result);
      if (!protocol.ok) return { requestId: request.requestId, ok: false, error: protocol.error };
      return result as MessageResponse<T>;
    };
    try {
      return await sendOnce();
    } catch (error) {
      // H2: only reads may be retried. Retrying `content.apply` after a lost
      // response could submit the same application twice.
      if (!IDEMPOTENT_REQUESTS.has(request.type)) {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: 'The page did not confirm the action. Check the job page before retrying.',
            retryable: false,
          },
        };
      }
      // The tab may still be loading after a navigation. Wait and retry once.
      try {
        await this.waitUntilReady(this.tabId);
        return await sendOnce();
      } catch {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: error instanceof Error ? error.message : 'Content script did not respond',
            retryable: true,
          },
        };
      }
    }
  }

  private async waitUntilReady(tabId: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      let mismatch = false;
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.status === 'complete') {
          const requestId = `ping-${Date.now()}`;
          const response = (await withTimeout(
            browser.tabs.sendMessage(tabId, {
              type: 'content.ping',
              requestId,
              protocolVersion: PROTOCOL_VERSION,
            }),
            2_000,
            'ping',
          )) as MessageResponse<{ pong: boolean }>;
          mismatch =
            !validateProtocolEnvelope(response).ok ||
            (!response.ok && response.error.code === 'PROTOCOL_MISMATCH');
          if (!mismatch && response?.ok) return;
        }
      } catch {
        // Keep polling.
      }
      if (mismatch) throw new Error(PROTOCOL_RELOAD_MESSAGE);
      await sleep(350);
    }
    throw new Error('Runner tab did not become ready');
  }
}

/** The router and production engine must own exactly the same pinned runner. */
export const runnerTabs = new RunnerTabManager();
