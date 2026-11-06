import { expect, type Page } from '@playwright/test';
import { SAMPLE_ANSWERS, SAMPLE_SETTINGS } from '../../../src/test/mockData';
import {
  PROTOCOL_VERSION,
  type Answer,
  type EngineState,
  type Job,
  type QueueItem,
  type QueuePayload,
  type Settings,
  type SubmissionAttempt,
} from '../../../src/core/contracts';

type SettingsOverrides = Omit<
  Partial<Settings>,
  'search' | 'pacing' | 'safety' | 'documents' | 'ai'
> & {
  search?: Partial<Settings['search']>;
  pacing?: Partial<Settings['pacing']>;
  safety?: Partial<Settings['safety']>;
  documents?: Partial<Settings['documents']>;
  ai?: Partial<Settings['ai']>;
};

export interface SeedOptions {
  settings?: SettingsOverrides;
  answers?: readonly Answer[];
}

export function baseSettings(overrides: SeedOptions['settings'] = {}): Settings {
  return {
    ...SAMPLE_SETTINGS,
    ...overrides,
    search: {
      ...SAMPLE_SETTINGS.search,
      includeKeywords: [],
      excludeKeywords: [],
      locations: [],
      remoteOnly: false,
      employmentTypes: [],
      minFitScore: 0,
      ...(overrides.search ?? {}),
    },
    pacing: {
      ...SAMPLE_SETTINGS.pacing,
      // Explicit advanced settings accelerate mocks; production has no test switch.
      useAdvanced: true,
      scanDelayMinMs: 0,
      scanDelayMaxMs: 0,
      humanDelayMinMs: 0,
      humanDelayMaxMs: 0,
      activeHours: null,
      minDelayMs: 10_000,
      maxDelayMs: 10_000,
      ...(overrides.pacing ?? {}),
    },
    safety: {
      ...SAMPLE_SETTINGS.safety,
      // Autopilot scenarios that expect a submission opt out explicitly; review
      // and dry-run scenarios keep the safe default. Individual tests can still
      // override `safety.reviewBeforeSubmit`.
      reviewBeforeSubmit: overrides.mode !== 'autopilot',
      allowSensitiveAutoSubmit: true,
      allowFreeTextAutoFill: false,
      ...(overrides.safety ?? {}),
    },
    documents: {
      ...SAMPLE_SETTINGS.documents,
      ...(overrides.documents ?? {}),
    },
    ai: {
      ...SAMPLE_SETTINGS.ai,
      enabled: false,
      ...(overrides.ai ?? {}),
    },
  };
}

export async function initExtension(sidePanel: Page): Promise<void> {
  await sidePanel.evaluate(async (protocolVersion) => {
    await chrome.runtime.sendMessage({
      type: 'ui.engine.getState',
      requestId: 'seed-init',
      protocolVersion,
    });
  }, PROTOCOL_VERSION);
}

/** Accelerate only mocked UI walkthroughs after asserting real onboarding defaults. */
export async function useMockPacing(sidePanel: Page): Promise<void> {
  await sendUi(sidePanel, {
    type: 'ui.settings.update',
    requestId: 'mock-pacing',
    patch: {
      pacing: {
        useAdvanced: true,
        minDelayMs: 10_000,
        maxDelayMs: 10_000,
        jitterPercent: 0,
        scanDelayMinMs: 0,
        scanDelayMaxMs: 0,
        humanDelayMinMs: 0,
        humanDelayMaxMs: 0,
      },
    },
  });
}

export async function seedExtension(sidePanel: Page, options: SeedOptions = {}): Promise<void> {
  await initExtension(sidePanel);
  const settings = baseSettings(options.settings);
  const answers = options.answers ?? SAMPLE_ANSWERS;
  await sidePanel.evaluate(
    async ({ settings, answers }) => {
      await chrome.storage.local.set({
        'handshook.settings.v1': settings,
        'handshook.onboarding.v1': {
          version: 1,
          step: 'done',
          sessionStatus: 'logged_in',
          completedAt: Date.now(),
        },
      });
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('handshook');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('answers', 'readwrite');
          tx.objectStore('answers').clear();
          for (const answer of answers) tx.objectStore('answers').put(answer);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { settings, answers },
  );
}

export async function getState(sidePanel: Page): Promise<EngineState> {
  const response = await sidePanel.evaluate(async (protocolVersion) => {
    return chrome.runtime.sendMessage({
      type: 'ui.engine.getState',
      requestId: 'seed-state',
      protocolVersion,
    });
  }, PROTOCOL_VERSION);
  expect(response.ok).toBe(true);
  return response.data as EngineState;
}

export async function getQueue(sidePanel: Page): Promise<QueuePayload> {
  const response = await sidePanel.evaluate(async (protocolVersion) => {
    return chrome.runtime.sendMessage({
      type: 'ui.queue.list',
      protocolVersion,
      requestId: 'seed-queue',
      limit: 100,
    });
  }, PROTOCOL_VERSION);
  expect(response.ok).toBe(true);
  return response.data as QueuePayload;
}

export async function startEngine(sidePanel: Page): Promise<EngineState> {
  const response = await sidePanel.evaluate(async (protocolVersion) => {
    return chrome.runtime.sendMessage({
      type: 'ui.engine.start',
      requestId: 'seed-start',
      protocolVersion,
    });
  }, PROTOCOL_VERSION);
  expect(response.ok).toBe(true);
  return response.data as EngineState;
}

export async function resumeEngine(sidePanel: Page): Promise<EngineState> {
  const response = await sidePanel.evaluate(async (protocolVersion) => {
    return chrome.runtime.sendMessage({
      type: 'ui.engine.resume',
      requestId: 'seed-resume',
      protocolVersion,
    });
  }, PROTOCOL_VERSION);
  expect(response.ok).toBe(true);
  return response.data as EngineState;
}

export async function pauseEngine(sidePanel: Page): Promise<void> {
  await sidePanel.evaluate(async (protocolVersion) => {
    await chrome.runtime.sendMessage({
      type: 'ui.engine.pause',
      requestId: 'seed-pause',
      protocolVersion,
    });
  }, PROTOCOL_VERSION);
}

export async function waitForState(
  sidePanel: Page,
  predicate: (state: EngineState, queue: QueuePayload) => boolean,
  timeoutMs = 25_000,
): Promise<{ state: EngineState; queue: QueuePayload }> {
  const deadline = Date.now() + timeoutMs;
  let lastState = await getState(sidePanel);
  let lastQueue = await getQueue(sidePanel);
  while (Date.now() < deadline) {
    lastState = await getState(sidePanel);
    lastQueue = await getQueue(sidePanel);
    if (predicate(lastState, lastQueue)) return { state: lastState, queue: lastQueue };
    await sidePanel.waitForTimeout(300);
  }
  return { state: lastState, queue: lastQueue };
}

export function runnerPage(context: { pages(): Page[] }, jobId?: string): Page {
  const page = context.pages().find((candidate) => {
    const url = candidate.url();
    return jobId ? url.includes(`/jobs/${jobId}`) : /\/jobs\/\d+/.test(url);
  });
  if (!page) throw new Error('Runner job page is not open');
  return page;
}

/** Merge a patch into the persisted engine state (`handshook.engine.v1`). */
export async function saveEngineState(sidePanel: Page, patch: Partial<EngineState>): Promise<void> {
  await sidePanel.evaluate(async (next) => {
    const key = 'handshook.engine.v1';
    const stored = (await chrome.storage.local.get(key))[key] as
      Record<string, unknown> | undefined;
    await chrome.storage.local.set({
      [key]: { version: 1, todayCount: 0, ...stored, ...next, updatedAt: Date.now() },
    });
  }, patch);
}

export interface SeedRecordOptions {
  job?: Job;
  queueItem?: QueueItem;
  submission?: SubmissionAttempt;
}

/**
 * Seed IndexedDB records that a crash/restart would have left behind. Use this
 * only to reproduce a state the engine cannot reach deterministically from the
 * UI (for example, a write-ahead submission without its final update).
 */
export async function seedRecords(sidePanel: Page, records: SeedRecordOptions): Promise<void> {
  await initExtension(sidePanel);
  await sidePanel.evaluate(
    async ({ records: value }) => {
      const stores: string[] = [];
      if (value.job) stores.push('jobs');
      if (value.queueItem) stores.push('queue');
      if (value.submission) stores.push('submissions');
      if (stores.length === 0) return;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('handshook');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        if (value.job) tx.objectStore('jobs').put(value.job);
        if (value.queueItem) tx.objectStore('queue').put(value.queueItem);
        if (value.submission) tx.objectStore('submissions').put(value.submission);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { records },
  );
}

export async function listSubmissions(sidePanel: Page): Promise<SubmissionAttempt[]> {
  return sidePanel.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('handshook');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const submissions = await new Promise<SubmissionAttempt[]>((resolve, reject) => {
      const tx = db.transaction('submissions', 'readonly');
      const request = tx.objectStore('submissions').getAll();
      request.onsuccess = () => resolve(request.result as SubmissionAttempt[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return submissions;
  });
}

/** Poll `read` until `predicate` holds, then return the value. Throws on timeout. */
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);
  const intervalMs = options.intervalMs ?? 200;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${options.description ?? 'condition'} was not met within ${String(options.timeoutMs ?? 25_000)}ms. ` +
      `Last value: ${JSON.stringify(last)}`,
  );
}

/** Send a UI request and return the response data, throwing on failure. */
export async function sendUi<T>(page: Page, request: Record<string, unknown>): Promise<T> {
  const response = await page.evaluate(
    (message) => {
      return chrome.runtime.sendMessage(message as Record<string, unknown>);
    },
    { ...request, protocolVersion: PROTOCOL_VERSION },
  );
  const parsed = response as { ok: boolean; data?: T; error?: { message: string } };
  if (!parsed?.ok) throw new Error(parsed?.error?.message ?? 'UI request failed');
  return parsed.data as T;
}
