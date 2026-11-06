import { browser } from 'wxt/browser';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  PROTOCOL_VERSION,
  appError,
  appErrorSchema,
  broadcastSchema,
  isRecord,
  mergeSettings,
  ok,
  err,
  parseSettings,
  validateProtocolEnvelope,
  type AiStatusPayload,
  type AiTestResult,
  type OpenRouterKeyInfo,
  type OpenRouterModelsPayload,
  type Answer,
  type InboxQuestion,
  type AppError,
  type Broadcast,
  type DocumentSelection,
  type DocumentType,
  type EngineState,
  type Job,
  type JobEvent,
  type JobStatus,
  type OnboardingState,
  type QueueItem,
  type QueueSummary,
  type QuestionDescriptor,
  type Result,
  type RunMode,
  type SelectorHealth,
  type Settings,
  type UiRequest,
} from '@/core/contracts';
import { parseLegacyFile, summarizePlan } from '@/core/migration/parse';
import {
  configuredDocuments,
  DOCUMENT_TYPES,
  documentChoiceError,
  documentSelectionForJob,
  findDocumentForType,
  idForType,
} from '@/core/documents/selection';
import { buildApplicationsCsv, buildBackupJson } from '@/core/migration/serialize';
import type { MigrationExportPayload, MigrationImportSummary } from '@/core/migration/types';

/* -------------------------------------------------------------------------- */
/* Response payloads                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A pending "Needs You" request. The background aggregates these from the
 * queue; the UI never derives them from storage itself.
 */
export interface NeedsRequest {
  jobId: string;
  jobTitle: string;
  employer: string;
  questions: QuestionDescriptor[];
  missingDocumentTypes: DocumentType[];
  documentSelection?: DocumentSelection;
  reason: 'questions' | 'documents' | 'auth' | 'challenge' | 'ui_changed' | 'review';
  message?: string;
  createdAt: number;
}

export interface QueuePayload {
  items: QueueItem[];
  jobs: Job[];
  summary: QueueSummary;
  needs: NeedsRequest[];
}

export interface SessionPayload {
  status: 'unknown' | 'logged_in' | 'logged_out';
  host: string;
  /** When the check finished, so a stale result is obvious in the UI. */
  checkedAt: number;
  /** Where the check ran. Only the extension-owned runner tab is ever read. */
  checkedIn: 'runner';
  /** Why the check could not verify the session; shown only as a last resort. */
  detail?: string;
}

export type { AiStatusPayload } from '@/core/contracts';
export type AiTestPayload = AiTestResult;

export interface DiagnosticsPayload {
  generatedAt: number;
  version: string;
  protocolVersion: number;
  host: string;
  mode: RunMode;
  storage: { ok: boolean; name: string; detail: string };
  selectors: SelectorHealth[];
  recentErrors: JobEvent[];
  queue: QueueSummary;
  counts: { events: number; answers: number; documents: number };
}

export interface ExportPayload {
  filename: string;
  json: string;
}

export interface ClearPayload {
  cleared: number;
}

export interface JobAnswerResult {
  jobId: string;
  jobStatus: JobStatus;
  remainingQuestionIds: string[];
}

export interface FocusPayload {
  focused: boolean;
}

/**
 * Requests the UI needs that are not (yet) in the frozen `UiRequest` contract.
 * Documented as change requests in `.handoffs/UI.md`; the background may reply
 * with `UNSUPPORTED_MESSAGE` until they are wired.
 */
export type UiExtraRequest =
  | { type: 'ui.events.list'; requestId: string; limit?: number }
  | { type: 'ui.needs.list'; requestId: string }
  | { type: 'ui.diagnostics.get'; requestId: string };

type AnyRequest = UiRequest | UiExtraRequest;

/** Response payload per request type, so callers never cast. */
export interface UiResponseMap {
  'ui.engine.start': EngineState;
  'ui.engine.pause': EngineState;
  'ui.engine.resume': EngineState;
  'ui.engine.stop': EngineState;
  'ui.engine.getState': EngineState;
  'ui.queue.list': QueuePayload;
  'ui.queue.retry': { jobId: string; status: JobStatus };
  'ui.queue.skip': { jobId: string; status: JobStatus };
  'ui.queue.applyNow': { jobId: string; status: JobStatus };
  'ui.answer.list': Answer[];
  'ui.answer.save': Answer;
  'ui.answer.delete': { deleted: boolean };
  'ui.questions.list': InboxQuestion[];
  'ui.questions.dismiss': { dismissed: true };
  'ui.job.answer': JobAnswerResult;
  'ui.settings.get': Settings;
  'ui.settings.update': Settings;
  'ui.onboarding.get': OnboardingState;
  'ui.onboarding.update': OnboardingState;
  'ui.session.check': SessionPayload;
  'ui.runner.focus': FocusPayload;
  'ui.ai.status': AiStatusPayload;
  'ui.ai.setKey': { saved: boolean };
  'ui.ai.clearKey': { cleared: boolean };
  'ui.ai.test': AiTestPayload;
  'ui.ai.openrouter.models': OpenRouterModelsPayload;
  'ui.ai.openrouter.keyInfo': OpenRouterKeyInfo;
  'ui.ai.dismissMigrationNotice': { dismissed: true };
  'ui.diagnostics.export': ExportPayload;
  'ui.diagnostics.clear': ClearPayload;
  'ui.data.reset': { reset: boolean };
  'ui.events.list': JobEvent[];
  'ui.needs.list': NeedsRequest[];
  'ui.needs.documentsResolved': {
    jobId: string;
    status: JobStatus;
    missingDocumentTypes: DocumentType[];
    remainingQuestionIds?: string[];
  };
  'ui.diagnostics.get': DiagnosticsPayload;
  'ui.queue.documents': { jobId: string; status: JobStatus };
  'ui.migration.import': MigrationImportSummary;
  'ui.migration.export': MigrationExportPayload;
}

/**
 * Request types the mock bridge can answer. Migration requests exist in the frozen
 * contract but have no demo/mock screen yet, so callers cannot select them here.
 */
export type UiRequestType = keyof UiResponseMap;

type RequestFor<K extends UiRequestType> = { type: K } & Omit<
  Extract<AnyRequest, { type: K }>,
  'type' | 'requestId'
>;

export type BridgeMode = 'live' | 'mock' | 'unavailable';

/** Shown when a production build cannot reach its background service worker. */
export const BACKGROUND_UNAVAILABLE_MESSAGE =
  'Background not responding — reload the extension, then try again.';

/* -------------------------------------------------------------------------- */
/* Runtime plumbing                                                           */
/* -------------------------------------------------------------------------- */

interface RuntimePort {
  id?: string;
  sendMessage?: (message: unknown) => Promise<unknown>;
  getManifest?: () => { version?: string };
  onMessage?: {
    addListener: (listener: (message: unknown, sender: unknown) => void) => void;
    removeListener: (listener: (message: unknown, sender: unknown) => void) => void;
  };
}

function getRuntime(): RuntimePort | null {
  try {
    // `browser` is WXT's cross-browser runtime handle. Outside an extension
    // page (unit tests, plain web pages) it resolves to `undefined`.
    const runtime = (browser as unknown as { runtime?: RuntimePort } | undefined)?.runtime;
    if (!runtime || !runtime.id) return null;
    return runtime;
  } catch {
    return null;
  }
}

export function isExtensionRuntime(): boolean {
  return getRuntime() !== null;
}

export function getExtensionVersion(): string {
  const runtime = getRuntime();
  try {
    return runtime?.getManifest?.().version ?? '1.1.4';
  } catch {
    return '1.1.4';
  }
}

let modePromise: Promise<BridgeMode> | null = null;

/**
 * Mock data is a development/test convenience. A packaged (production) build
 * must never silently show seeded jobs — it blocks with a reload prompt instead.
 * `import.meta.env` is replaced by Vite/WXT at build time.
 */
export function isMockBridgeAllowed(): boolean {
  const env = import.meta.env;
  return env.DEV === true || env.MODE === 'test';
}

/** Pure fallback decision, exported so the production gate can be unit-tested. */
export function resolveFallbackMode(options: {
  hasRuntime: boolean;
  answered: boolean;
  allowMock: boolean;
}): BridgeMode {
  if (options.hasRuntime && options.answered) return 'live';
  return options.allowMock ? 'mock' : 'unavailable';
}

/**
 * Live mode requires a background that answers the liveness ping. In dev and
 * tests (and only there) a missing background falls back to the seeded mock
 * store. A production build reports `unavailable` so the panel can block.
 */
export function getBridgeMode(): Promise<BridgeMode> {
  modePromise ??= detectMode().then((mode) => {
    // A cold/unavailable worker must be probed again instead of cached forever.
    if (mode !== 'live') modePromise = null;
    return mode;
  });
  return modePromise;
}

async function detectMode(): Promise<BridgeMode> {
  const runtime = getRuntime();
  const allowMock = isMockBridgeAllowed();
  if (!runtime?.sendMessage) {
    return resolveFallbackMode({ hasRuntime: false, answered: false, allowMock });
  }
  // Probe a request the panel genuinely needs. A background that only answers
  // `ping` cannot serve the panel. One retry covers a cold service-worker start.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await withTimeout(
        runtime.sendMessage({
          type: 'ui.engine.getState',
          requestId: newMockId(),
          protocolVersion: PROTOCOL_VERSION,
        }),
        1_500,
      );
      if (isRecord(response) && response.ok === true && isRecord(response.data)) {
        return resolveFallbackMode({ hasRuntime: true, answered: true, allowMock });
      }
    } catch {
      // Retry once, then fall back.
    }
    await delay(300);
  }
  return resolveFallbackMode({ hasRuntime: true, answered: false, allowMock });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Bridge request timed out'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Bridge request failed'));
      },
    );
  });
}

function newMockId(): string {
  return crypto.randomUUID();
}

/** Broadcasts from the background. Mock mode has no emitter, so this is a no-op. */
export function subscribeToBroadcasts(handler: (message: unknown) => void): () => void {
  const runtime = getRuntime();
  if (!runtime?.onMessage) return () => {};
  const listener = (message: unknown, sender: unknown): void => {
    if (!isRecord(sender) || sender.id !== runtime.id || sender.tab) return;
    const parsed = broadcastSchema.safeParse(message);
    if (parsed.success) handler(parsed.data);
  };
  runtime.onMessage.addListener(listener);
  return () => {
    runtime.onMessage?.removeListener(listener);
  };
}

/** Validate the whole wire payload before React consumes it. */
export function isBroadcast(value: unknown): value is Broadcast {
  return broadcastSchema.safeParse(value).success;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function sendRequest<K extends UiRequestType>(
  request: RequestFor<K>,
  options: { timeoutMs?: number } = {},
): Promise<Result<UiResponseMap[K]>> {
  const full = {
    ...request,
    requestId: newMockId(),
    protocolVersion: PROTOCOL_VERSION,
  } as AnyRequest;
  const mode = await getBridgeMode();
  if (mode === 'unavailable') {
    return err(appError('NETWORK', BACKGROUND_UNAVAILABLE_MESSAGE, { retryable: true }));
  }
  if (mode === 'live') {
    return sendLive<UiResponseMap[K]>(full, options.timeoutMs);
  }
  await delay(mockLatency());
  return handleMock(full) as Result<UiResponseMap[K]>;
}

async function sendLive<T>(request: AnyRequest, timeoutMs?: number): Promise<Result<T>> {
  const runtime = getRuntime();
  if (!runtime?.sendMessage) {
    return err(
      appError('NETWORK', 'The extension background is not reachable.', { retryable: true }),
    );
  }

  let raw: unknown;
  try {
    raw = await withTimeout(
      runtime.sendMessage(request),
      timeoutMs ?? LIMITS.defaultRequestTimeoutMs,
    );
  } catch (cause) {
    return err(
      appError('NETWORK', 'Could not reach the extension background.', {
        retryable: true,
        cause,
      }),
    );
  }

  if (!isRecord(raw)) {
    return err(
      appError('UNKNOWN', 'The extension returned an empty response. Reload the panel.', {
        retryable: true,
      }),
    );
  }
  const protocol = validateProtocolEnvelope(raw);
  if (!protocol.ok) return protocol;
  if (raw.requestId !== request.requestId) {
    return err(appError('PROTOCOL_MISMATCH', 'Reload the extension to sync versions.'));
  }
  if (raw.ok === true) {
    return ok(raw.data as T);
  }
  const parsed = appErrorSchema.safeParse(raw.error);
  if (parsed.success) return err(parsed.data as AppError);
  return err(
    appError('UNKNOWN', 'The extension returned an unrecognised error.', { retryable: true }),
  );
}

/* -------------------------------------------------------------------------- */
/* Mock store                                                                 */
/* -------------------------------------------------------------------------- */

const MOCK_KEY = 'handshook.ui.mock.v1';
const MOCK_LATENCY_MS = 130;

const MOCK_OPENROUTER_MODELS: OpenRouterModelsPayload['models'] = [
  {
    id: 'demo-labs/sprout:free',
    name: 'Demo Sprout (free)',
    contextLength: 32768,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    supportsStructuredOutputs: true,
    supportsResponseFormat: true,
    expirationDate: null,
  },
  {
    id: 'fictional-ai/cedar-mini',
    name: 'Demo Cedar Mini',
    contextLength: 128000,
    promptPricePerMillion: 0.2,
    completionPricePerMillion: 0.5,
    isFree: false,
    supportsStructuredOutputs: true,
    supportsResponseFormat: true,
    expirationDate: null,
  },
  {
    id: 'example-research/atlas',
    name: 'Demo Atlas',
    contextLength: 1000000,
    promptPricePerMillion: 2,
    completionPricePerMillion: 8,
    isFree: false,
    supportsStructuredOutputs: true,
    supportsResponseFormat: true,
    expirationDate: '2027-12-31',
  },
  {
    id: 'demo-labs/fern:free',
    name: 'Demo Fern (free, plain text)',
    contextLength: 8192,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    supportsStructuredOutputs: false,
    supportsResponseFormat: false,
    expirationDate: null,
  },
];

/** In-memory mirror so the demo works even when localStorage is unavailable. */
let memoryDb: MockDb | null = null;

interface MockDb {
  settings: Settings;
  onboarding: OnboardingState;
  engine: EngineState;
  items: QueueItem[];
  jobs: Job[];
  events: JobEvent[];
  answers: Answer[];
  needs: NeedsRequest[];
  selectors: SelectorHealth[];
  openRouterConfigured: boolean;
}

function mockLatency(): number {
  return MOCK_LATENCY_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageAvailable(): boolean {
  try {
    const probe = '__handshook_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readRaw(key: string): string | null {
  if (!storageAvailable()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota or private mode: the in-memory seed still serves the session.
  }
}

function readMock(): MockDb {
  if (memoryDb) return memoryDb;
  const raw = readRaw(MOCK_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isMockDb(parsed)) {
        const settings = parseSettings(parsed.settings);
        if (settings.ok) parsed.settings = settings.value;
        parsed.openRouterConfigured = parsed.openRouterConfigured === true;
        memoryDb = parsed;
        return parsed;
      }
    } catch {
      // Corrupt demo data: fall through and reseed.
    }
  }
  const seeded = seedMock();
  writeMock(seeded);
  return seeded;
}

function writeMock(db: MockDb): void {
  memoryDb = db;
  writeRaw(MOCK_KEY, JSON.stringify(db));
}

function isMockDb(value: unknown): value is MockDb {
  if (!isRecord(value)) return false;
  if (!isRecord(value.engine) || !isRecord(value.onboarding)) return false;
  if (!Array.isArray(value.items) || !Array.isArray(value.jobs)) return false;
  if (!Array.isArray(value.events) || !Array.isArray(value.answers)) return false;
  if (!Array.isArray(value.needs)) return false;
  if (!Array.isArray(value.selectors)) return false;
  const settings = parseSettings(value.settings);
  return settings.ok;
}

const SEED_NOW = 1_759_000_000_000;

function seedMock(): MockDb {
  const now = Date.now();
  const jobs: Job[] = [
    {
      id: '8451201',
      host: 'app.joinhandshake.com',
      title: 'Data Analyst Intern',
      employer: 'Northwind Analytics',
      url: 'https://app.joinhandshake.com/jobs/8451201',
      description: 'Summer internship supporting the analytics team with reporting and dashboards.',
      location: 'New York, NY',
      employmentType: 'Internship',
      remote: false,
      salary: '$28/hour',
      postedAt: new Date(now - 3 * 86_400_000).toISOString(),
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      source: 'search',
      discoveredAt: now - 3 * 3_600_000,
      fitScore: 0.86,
      fitReasons: ['Matches “data analyst” keyword', 'Internship', 'Location: New York'],
    },
    {
      id: '8453344',
      host: 'app.joinhandshake.com',
      title: 'Software Engineer Intern',
      employer: 'Lumen Robotics',
      url: 'https://app.joinhandshake.com/jobs/8453344',
      description: 'Work on internal tooling for a small robotics team.',
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      salary: '$32/hour',
      postedAt: new Date(now - 5 * 86_400_000).toISOString(),
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'transcript'],
      source: 'search',
      discoveredAt: now - 2 * 3_600_000,
      fitScore: 0.74,
      fitReasons: ['Matches “software engineer” keyword', 'Remote'],
    },
    {
      id: '8452910',
      host: 'app.joinhandshake.com',
      title: 'Marketing Associate',
      employer: 'Cedar & Co.',
      url: 'https://app.joinhandshake.com/jobs/8452910',
      description: 'Entry-level marketing role with a focus on lifecycle campaigns.',
      location: 'Chicago, IL',
      employmentType: 'Job',
      applyType: 'external',
      requiredDocumentTypes: ['resume', 'cover_letter'],
      source: 'search',
      discoveredAt: now - 6 * 3_600_000,
      fitScore: 0.42,
      fitReasons: ['Employer applies on their own site', 'Below your fit threshold'],
    },
    {
      id: '8454477',
      host: 'app.joinhandshake.com',
      title: 'Product Design Intern',
      employer: 'Brightpath Learning',
      url: 'https://app.joinhandshake.com/jobs/8454477',
      description: 'Partner with senior designers on learning tools for students.',
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume', 'cover_letter'],
      source: 'search',
      discoveredAt: now - 50 * 60_000,
      fitScore: 0.68,
      fitReasons: ['Remote', 'Matches “design” keyword'],
    },
    {
      id: '8450982',
      host: 'app.joinhandshake.com',
      title: 'Research Assistant',
      employer: 'Harbor Health',
      url: 'https://app.joinhandshake.com/jobs/8450982',
      description: 'Support a clinical research study with data collection and literature review.',
      location: 'Boston, MA',
      employmentType: 'Job',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume'],
      source: 'search',
      discoveredAt: now - 26 * 3_600_000,
      fitScore: 0.61,
      fitReasons: ['Matches “research” keyword', 'Requires a screening question'],
    },
    {
      id: '8449770',
      host: 'app.joinhandshake.com',
      title: 'Finance Analyst',
      employer: 'Riverstone Capital',
      url: 'https://app.joinhandshake.com/jobs/8449770',
      description: 'Analyst role covering forecasting and portfolio reporting.',
      location: 'New York, NY',
      employmentType: 'Job',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      source: 'search',
      discoveredAt: now - 30 * 3_600_000,
      fitScore: 0.57,
      fitReasons: ['Location: New York', 'Matches “finance” keyword'],
    },
  ];

  const items: QueueItem[] = [
    {
      jobId: '8451201',
      status: 'queued',
      priority: 90,
      attempts: 0,
      addedAt: now - 3 * 3_600_000,
      updatedAt: now - 3 * 3_600_000,
    },
    {
      jobId: '8453344',
      status: 'ready_for_review',
      priority: 80,
      attempts: 1,
      addedAt: now - 2 * 3_600_000,
      updatedAt: now - 40 * 60_000,
    },
    {
      jobId: '8454477',
      status: 'needs_input',
      priority: 70,
      attempts: 1,
      addedAt: now - 50 * 60_000,
      updatedAt: now - 20 * 60_000,
      pendingQuestionIds: ['q-auth', 'q-why'],
      missingDocumentTypes: ['cover_letter'],
    },
    {
      jobId: '8450982',
      status: 'needs_input',
      priority: 60,
      attempts: 1,
      addedAt: now - 26 * 3_600_000,
      updatedAt: now - 2 * 3_600_000,
      pendingQuestionIds: ['q-auth'],
    },
    {
      jobId: '8452910',
      status: 'external',
      priority: 50,
      attempts: 1,
      addedAt: now - 6 * 3_600_000,
      updatedAt: now - 5 * 3_600_000,
    },
    {
      jobId: '8450970',
      status: 'applied',
      priority: 40,
      attempts: 1,
      addedAt: now - 9 * 3_600_000,
      updatedAt: now - 8 * 3_600_000,
    },
    {
      jobId: '8449770',
      status: 'blocked',
      priority: 30,
      attempts: 2,
      addedAt: now - 30 * 3_600_000,
      updatedAt: now - 7 * 3_600_000,
      lastError: appError('UI_CHANGED', 'The application form changed and could not be read.', {
        retryable: false,
      }),
    },
  ];

  const events: JobEvent[] = [
    {
      id: 'ev-1',
      at: now - 7 * 3_600_000,
      level: 'error',
      type: 'selector.miss',
      jobId: '8449770',
      message: 'Application form changed: could not find the submit button',
      data: { page: 'modal' },
    },
    {
      id: 'ev-2',
      at: now - 8 * 3_600_000,
      level: 'info',
      type: 'job.applied',
      jobId: '8450970',
      message: 'Applied to “Operations Intern” at Stonebridge Logistics',
    },
    {
      id: 'ev-3',
      at: now - 9 * 3_600_000,
      level: 'info',
      type: 'job.discovered',
      message: 'Found 14 jobs matching your saved search',
    },
    {
      id: 'ev-4',
      at: now - 26 * 3_600_000,
      level: 'warn',
      type: 'engine.paused',
      message: 'Paused at a screening question that needs your answer',
    },
    {
      id: 'ev-5',
      at: now - 28 * 3_600_000,
      level: 'info',
      type: 'job.ready_for_review',
      jobId: '8453344',
      message: 'Filled the application for review before submitting',
    },
    {
      id: 'ev-6',
      at: now - 30 * 3_600_000,
      level: 'info',
      type: 'engine.started',
      message: 'Started a review-mode run',
    },
  ];

  const answers: Answer[] = [
    {
      id: 'work_authorization',
      label: 'Are you legally authorized to work in the United States?',
      aliases: ['work authorization', 'legally authorized', 'right to work'],
      type: 'radio',
      value: 'yes',
      options: { Yes: 'yes', No: 'no' },
      category: 'work',
      autoSubmitAllowed: false,
      sensitive: true,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'sponsorship',
      label: 'Will you now or in the future require sponsorship?',
      aliases: ['sponsorship', 'visa sponsorship'],
      type: 'radio',
      value: 'no',
      options: { Yes: 'yes', No: 'no' },
      category: 'work',
      autoSubmitAllowed: false,
      sensitive: true,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'gpa',
      label: 'Cumulative GPA',
      aliases: ['gpa', 'grade point average'],
      type: 'text',
      value: '3.6',
      category: 'education',
      autoSubmitAllowed: true,
      sensitive: false,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'graduation_date',
      label: 'Expected graduation date',
      aliases: ['graduation date', 'grad date'],
      type: 'date',
      value: '2027-05-15',
      category: 'education',
      autoSubmitAllowed: true,
      sensitive: false,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'preferred_location',
      label: 'Preferred work location',
      aliases: ['location preference', 'preferred location'],
      type: 'text',
      value: 'Remote or New York, NY',
      category: 'preferences',
      autoSubmitAllowed: true,
      sensitive: false,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'salary_expectation',
      label: 'Salary expectations',
      aliases: ['salary', 'compensation', 'hourly rate'],
      type: 'text',
      value: '$28/hour',
      category: 'preferences',
      autoSubmitAllowed: false,
      sensitive: true,
      updatedAt: now - 4 * 86_400_000,
    },
    {
      id: 'eeo_preference',
      label: 'Voluntary self-identification preference',
      aliases: ['eeo', 'veteran status', 'disability status', 'gender', 'race'],
      type: 'select',
      value: 'decline',
      options: { 'Prefer not to say': 'decline' },
      category: 'eeo',
      autoSubmitAllowed: false,
      sensitive: true,
      updatedAt: now - 4 * 86_400_000,
    },
  ];

  const needs: NeedsRequest[] = [
    {
      jobId: '8454477',
      jobTitle: 'Product Design Intern',
      employer: 'Brightpath Learning',
      reason: 'questions',
      createdAt: now - 20 * 60_000,
      missingDocumentTypes: ['cover_letter'],
      questions: [
        {
          id: 'q-auth',
          label: 'Are you legally authorized to work in the United States?',
          type: 'radio',
          required: true,
          fingerprint: 'fp-auth',
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
          answerSource: 'bank',
          confidence: 0.98,
          suggestedAnswer: 'yes',
        },
        {
          id: 'q-why',
          label: 'Why are you interested in this role?',
          helpText: 'Two or three sentences is plenty.',
          type: 'textarea',
          required: true,
          fingerprint: 'fp-why',
          answerSource: 'none',
        },
      ],
    },
    {
      jobId: '8450982',
      jobTitle: 'Research Assistant',
      employer: 'Harbor Health',
      reason: 'questions',
      createdAt: now - 2 * 3_600_000,
      missingDocumentTypes: [],
      questions: [
        {
          id: 'q-auth-2',
          label: 'Are you legally authorized to work in the United States?',
          type: 'radio',
          required: true,
          fingerprint: 'fp-auth',
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
          answerSource: 'bank',
          confidence: 0.98,
          suggestedAnswer: 'yes',
        },
      ],
    },
  ];

  const selectors: SelectorHealth[] = [
    {
      at: now - 7 * 3_600_000,
      page: 'modal',
      selector: 'apply.submit',
      strategy: 'role=button',
      ok: false,
      detail: 'No matching button',
    },
    { at: now - 8 * 3_600_000, page: 'job', selector: 'apply.button', strategy: 'css', ok: true },
    {
      at: now - 8 * 3_600_000,
      page: 'search',
      selector: 'search.resultCard',
      strategy: 'css',
      ok: true,
    },
    {
      at: now - 9 * 3_600_000,
      page: 'documents',
      selector: 'documents.list',
      strategy: 'role=list',
      ok: true,
    },
  ];

  const engine: EngineState = {
    version: 1,
    status: 'idle',
    mode: DEFAULT_SETTINGS.mode,
    host: 'app.joinhandshake.com',
    todayCount: 4,
    dailyCap: DEFAULT_SETTINGS.pacing.dailyCap,
    consecutiveFailures: 0,
    message: 'Ready when you are. Nothing runs until you press Start.',
    updatedAt: now - 25 * 60_000,
  };

  return {
    settings: {
      ...DEFAULT_SETTINGS,
      search: {
        ...DEFAULT_SETTINGS.search,
        savedSearches: [
          {
            id: 'search-1',
            name: 'Data & analytics internships',
            url: 'https://app.joinhandshake.com/jobs?query=data%20analyst&jobType=internship',
            enabled: true,
            createdAt: SEED_NOW,
            updatedAt: SEED_NOW,
          },
        ],
        activeSearchId: 'search-1',
        includeKeywords: ['analyst', 'data'],
        excludeKeywords: ['unpaid'],
        locations: ['New York, NY', 'Remote'],
        remoteOnly: false,
        employmentTypes: ['Internship'],
      },
      documents: {
        defaultResumeId: 'doc-resume-general',
        defaultResumeName: 'General Resume',
        additionalResumes: [
          { id: 'doc-resume-data', name: 'Data & Analytics Resume' },
          { id: 'doc-resume-product', name: 'Product Resume' },
        ],
        coverLetterId: 'doc-cover-letter',
        coverLetterName: 'General Cover Letter',
        transcriptId: 'doc-transcript',
        transcriptName: 'Unofficial Transcript',
        autoSelectResume: true,
      },
    },
    onboarding: {
      version: 1,
      step: 'welcome',
      host: 'app.joinhandshake.com',
      sessionStatus: 'unknown',
    },
    engine,
    items,
    jobs,
    events,
    answers,
    needs,
    selectors,
    openRouterConfigured: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock request handling                                                      */
/* -------------------------------------------------------------------------- */

function countByStatus(db: MockDb): Partial<Record<JobStatus, number>> {
  const counts: Partial<Record<JobStatus, number>> = {};
  for (const item of db.items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
}

function buildSummary(db: MockDb): QueueSummary {
  const counts = countByStatus(db);
  const total = db.items.length;
  return {
    counts,
    total,
    todayCount: db.engine.todayCount,
    dailyCap: db.engine.dailyCap,
    remainingToday: Math.max(0, db.engine.dailyCap - db.engine.todayCount),
    currentJobId: db.engine.currentJobId,
    pauseReason: db.engine.pauseReason,
  };
}

function pushEvent(db: MockDb, event: Omit<JobEvent, 'id' | 'at'>): void {
  db.events.unshift({ ...event, id: crypto.randomUUID(), at: Date.now() });
  db.events = db.events.slice(0, LIMITS.maxEvents);
}

function jobTitle(db: MockDb, jobId: string): string {
  return db.jobs.find((job) => job.id === jobId)?.title ?? 'this job';
}

function isSensitiveLabel(label: string): boolean {
  return /authoriz|sponsor|felony|background|veteran|disab|gender|race|ethnic|birth|ssn|salary|compensation/i.test(
    label,
  );
}

function saveDb(db: MockDb): MockDb {
  writeMock(db);
  return db;
}

function handleMock(request: AnyRequest): Result<unknown> {
  const db = readMock();
  const now = Date.now();

  switch (request.type) {
    case 'ui.engine.getState':
      return ok(db.engine);

    case 'ui.engine.start': {
      const mode = request.mode ?? db.settings.mode;
      if (db.engine.todayCount >= db.engine.dailyCap) {
        return err(
          appError('CAP_REACHED', `Daily cap reached (${db.engine.dailyCap}). Resume tomorrow.`),
        );
      }
      const queued = db.items.find((item) => item.status === 'queued' || item.status === 'waiting');
      db.engine = {
        ...db.engine,
        status: 'running',
        mode,
        startedAt: now,
        pausedAt: undefined,
        pauseReason: undefined,
        currentJobId: queued?.jobId,
        currentPhase: queued ? 'Opening the application' : 'Scanning your saved search',
        message: undefined,
        lastError: undefined,
        updatedAt: now,
      };
      pushEvent(db, {
        level: 'info',
        type: 'engine.started',
        message: mode === 'autopilot' ? 'Started an autopilot run' : 'Started a review-mode run',
      });
      saveDb(db);
      return ok(db.engine);
    }

    case 'ui.engine.pause': {
      db.engine = {
        ...db.engine,
        status: 'paused',
        pauseReason: request.reason ?? 'user',
        pausedAt: now,
        currentPhase: undefined,
        message: 'Paused by you. Nothing is running.',
        updatedAt: now,
      };
      pushEvent(db, { level: 'info', type: 'engine.paused', message: 'Paused by you' });
      saveDb(db);
      return ok(db.engine);
    }

    case 'ui.engine.resume': {
      if (db.engine.todayCount >= db.engine.dailyCap) {
        return err(
          appError('CAP_REACHED', `Daily cap reached (${db.engine.dailyCap}). Resume tomorrow.`),
        );
      }
      db.engine = {
        ...db.engine,
        status: 'running',
        pausedAt: undefined,
        pauseReason: undefined,
        currentPhase: 'Resuming the queue',
        message: undefined,
        lastError: undefined,
        updatedAt: now,
      };
      pushEvent(db, { level: 'info', type: 'engine.resumed', message: 'Resumed the run' });
      saveDb(db);
      return ok(db.engine);
    }

    case 'ui.engine.stop': {
      db.engine = {
        ...db.engine,
        status: 'idle',
        pausedAt: undefined,
        pauseReason: undefined,
        currentJobId: undefined,
        currentPhase: undefined,
        message: 'Stopped. Nothing will run until you start again.',
        updatedAt: now,
      };
      pushEvent(db, { level: 'info', type: 'engine.stopped', message: 'Stopped the run' });
      saveDb(db);
      return ok(db.engine);
    }

    case 'ui.queue.list': {
      const items = [...db.items].sort(
        (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt,
      );
      const filtered = request.status?.length
        ? items.filter((item) => request.status?.includes(item.status))
        : items;
      const offset = request.offset ?? 0;
      const limit = request.limit ?? 100;
      return ok({
        items: filtered.slice(offset, offset + limit),
        jobs: db.jobs,
        summary: buildSummary(db),
        needs: db.needs,
      } satisfies QueuePayload);
    }

    case 'ui.queue.retry': {
      const item = db.items.find((entry) => entry.jobId === request.jobId);
      if (!item) return err(appError('INVALID_INPUT', 'That job is no longer in the queue.'));
      item.status = 'queued';
      item.lastError = undefined;
      item.updatedAt = now;
      item.nextAttemptAt = now;
      pushEvent(db, {
        level: 'info',
        type: 'job.retry',
        jobId: item.jobId,
        message: `Queued “${jobTitle(db, item.jobId)}” to retry`,
      });
      saveDb(db);
      return ok({ jobId: item.jobId, status: item.status });
    }

    case 'ui.queue.skip': {
      const item = db.items.find((entry) => entry.jobId === request.jobId);
      if (!item) return err(appError('INVALID_INPUT', 'That job is no longer in the queue.'));
      item.status = 'skipped';
      item.updatedAt = now;
      db.needs = db.needs.filter((need) => need.jobId !== item.jobId);
      pushEvent(db, {
        level: 'info',
        type: 'job.skipped',
        jobId: item.jobId,
        message: `Skipped “${jobTitle(db, item.jobId)}”`,
        data: { reason: request.reason.slice(0, 120) },
      });
      saveDb(db);
      return ok({ jobId: item.jobId, status: item.status });
    }

    case 'ui.queue.applyNow': {
      const item = db.items.find((entry) => entry.jobId === request.jobId);
      if (!item) return err(appError('INVALID_INPUT', 'That job is no longer in the queue.'));
      item.status = 'queued';
      item.priority = 999;
      item.updatedAt = now;
      item.nextAttemptAt = now;
      pushEvent(db, {
        level: 'info',
        type: 'job.review_requested',
        jobId: item.jobId,
        message: `Queued “${jobTitle(db, item.jobId)}” for review now`,
      });
      saveDb(db);
      return ok({ jobId: item.jobId, status: item.status });
    }

    case 'ui.answer.list':
      return ok(db.answers);

    // The preview has no application history, so its question inbox is empty.
    case 'ui.questions.list':
      return ok([]);

    case 'ui.questions.dismiss':
      return ok({ dismissed: true as const });

    case 'ui.answer.save': {
      const answer = request.answer;
      const index = db.answers.findIndex((entry) => entry.id === answer.id);
      if (index >= 0) {
        db.answers[index] = answer;
      } else {
        db.answers.push(answer);
      }
      db.answers = db.answers.map((entry) =>
        entry.id === answer.id ? { ...entry, updatedAt: now } : entry,
      );
      pushEvent(db, {
        level: 'info',
        type: 'answer.saved',
        message: `Saved the reusable answer “${answer.label.slice(0, 80)}”`,
      });
      saveDb(db);
      return ok(db.answers.find((entry) => entry.id === answer.id) ?? answer);
    }

    case 'ui.answer.delete': {
      const before = db.answers.length;
      db.answers = db.answers.filter((entry) => entry.id !== request.answerId);
      if (db.answers.length === before) {
        return err(appError('INVALID_INPUT', 'That answer no longer exists.'));
      }
      saveDb(db);
      return ok({ deleted: true });
    }

    case 'ui.job.answer': {
      const need = db.needs.find((entry) => entry.jobId === request.jobId);
      if (!need) return err(appError('INVALID_INPUT', 'That job no longer needs an answer.'));
      const question = need.questions.find((entry) => entry.id === request.questionId);
      if (!question) return err(appError('INVALID_INPUT', 'That question is no longer pending.'));

      if (request.remember) {
        const sensitive = isSensitiveLabel(question.label);
        const existing = db.answers.find((entry) => entry.label === question.label);
        const answer: Answer = {
          id: existing?.id ?? `custom_${question.fingerprint.slice(0, 24) || crypto.randomUUID()}`,
          label: question.label,
          aliases: existing?.aliases ?? [],
          type: question.type,
          value: request.value,
          options: question.options
            ? Object.fromEntries(question.options.map((option) => [option.label, option.value]))
            : existing?.options,
          category: existing?.category ?? 'custom',
          autoSubmitAllowed: existing?.autoSubmitAllowed ?? false,
          sensitive: existing?.sensitive ?? sensitive,
          updatedAt: now,
        };
        const index = db.answers.findIndex((entry) => entry.id === answer.id);
        if (index >= 0) db.answers[index] = answer;
        else db.answers.push(answer);
      }

      need.questions = need.questions.filter((entry) => entry.id !== request.questionId);
      const item = db.items.find((entry) => entry.jobId === request.jobId);
      const complete = need.questions.length === 0 && need.missingDocumentTypes.length === 0;
      if (complete) {
        db.needs = db.needs.filter((entry) => entry.jobId !== request.jobId);
        if (item) {
          item.status = 'ready_for_review';
          item.pendingQuestionIds = [];
          item.updatedAt = now;
        }
      } else if (item) {
        item.pendingQuestionIds = need.questions.map((entry) => entry.id);
        item.updatedAt = now;
      }

      pushEvent(db, {
        level: 'info',
        type: 'job.answered',
        jobId: request.jobId,
        message: `Answered “${question.label.slice(0, 80)}” for ${jobTitle(db, request.jobId)}`,
      });
      saveDb(db);
      return ok({
        jobId: request.jobId,
        jobStatus: item?.status ?? 'needs_input',
        remainingQuestionIds: need.questions.map((entry) => entry.id),
      } satisfies JobAnswerResult);
    }

    case 'ui.settings.get':
      return ok(db.settings);

    case 'ui.settings.update': {
      const merged = mergeSettings(db.settings, request.patch);
      const parsed = parseSettings(merged);
      if (!parsed.ok) return parsed;
      db.settings = parsed.value;
      db.engine = {
        ...db.engine,
        mode: db.settings.mode,
        dailyCap: db.settings.pacing.dailyCap,
        updatedAt: now,
      };
      saveDb(db);
      return ok(db.settings);
    }

    case 'ui.onboarding.get':
      return ok(db.onboarding);

    case 'ui.onboarding.update': {
      db.onboarding = { ...db.onboarding, ...request.patch, version: 1 };
      if (request.patch.step === 'done') {
        db.onboarding.completedAt = now;
        db.settings = { ...db.settings, onboardingComplete: true };
        pushEvent(db, {
          level: 'info',
          type: 'onboarding.complete',
          message: 'Setup complete. Nothing runs until you press Start.',
        });
      }
      saveDb(db);
      return ok(db.onboarding);
    }

    case 'ui.session.check':
      return ok({
        status: 'unknown',
        host: db.settings.host,
        checkedAt: Date.now(),
        checkedIn: 'runner',
      } satisfies SessionPayload);

    case 'ui.runner.focus':
      return ok({ focused: false } satisfies FocusPayload);

    case 'ui.ai.status':
      return ok({
        enabled: db.settings.ai.enabled,
        provider: db.settings.ai.provider,
        openRouterConfigured: db.openRouterConfigured,
        openRouterPermission: 'granted',
        geminiReplacedNotice: false,
      } satisfies AiStatusPayload);

    case 'ui.ai.setKey': {
      if (!request.apiKey.trim() || /\s/.test(request.apiKey.trim())) {
        return err(
          appError('INVALID_INPUT', 'Paste a complete OpenRouter API key without spaces.'),
        );
      }
      db.openRouterConfigured = true;
      saveDb(db);
      return ok({ saved: true });
    }

    case 'ui.ai.clearKey': {
      db.openRouterConfigured = false;
      saveDb(db);
      return ok({ cleared: true });
    }

    case 'ui.ai.test': {
      if (
        request.provider === 'openrouter' &&
        (!db.openRouterConfigured || !db.settings.ai.openRouter.model)
      ) {
        return ok({
          provider: request.provider,
          ok: false,
          message: 'Add an OpenRouter API key and choose a model before testing.',
        } satisfies AiTestPayload);
      }
      const model = MOCK_OPENROUTER_MODELS.find(
        (entry) => entry.id === db.settings.ai.openRouter.model,
      );
      const costUsd = model
        ? ((model.promptPricePerMillion ?? 0) * 1500 +
            (model.completionPricePerMillion ?? 0) * 200) /
          1_000_000
        : undefined;
      return ok({
        provider: request.provider,
        ok: true,
        message: 'Mock mode: no network request was made.',
        ...(request.provider === 'openrouter'
          ? { model: db.settings.ai.openRouter.model ?? undefined, costUsd }
          : {}),
      } satisfies AiTestPayload);
    }

    case 'ui.ai.openrouter.models':
      return ok({
        models: MOCK_OPENROUTER_MODELS,
        fetchedAt: now,
      } satisfies OpenRouterModelsPayload);

    case 'ui.ai.openrouter.keyInfo':
      if (!db.openRouterConfigured)
        return err(appError('INVALID_INPUT', 'Save an OpenRouter key first.'));
      return ok({
        label: 'Demo key',
        limit: 10,
        limitRemaining: 9.5,
        usage: 0.5,
        isFreeTier: false,
        freeDailyRemaining: 42,
      } satisfies OpenRouterKeyInfo);

    case 'ui.ai.dismissMigrationNotice':
      return ok({ dismissed: true });

    case 'ui.diagnostics.export':
      return ok({
        filename: `handshook-diagnostics-${new Date(now).toISOString().slice(0, 10)}.json`,
        json: JSON.stringify(
          {
            demo: true,
            generatedAt: now,
            version: getExtensionVersion(),
            protocolVersion: PROTOCOL_VERSION,
            host: db.settings.host,
            engine: db.engine,
            queue: buildSummary(db),
            settings: db.settings,
            events: db.events.slice(0, 200),
          },
          null,
          2,
        ),
      } satisfies ExportPayload);

    case 'ui.diagnostics.clear': {
      const cleared = db.events.length + db.selectors.length;
      db.events = [];
      db.selectors = [];
      saveDb(db);
      return ok({ cleared } satisfies ClearPayload);
    }

    case 'ui.data.reset': {
      const fresh = seedMock();
      saveDb(fresh);
      return ok({ reset: true });
    }

    case 'ui.migration.import': {
      const parsed = parseLegacyFile(request.kind, request.content);
      if (!parsed.ok) return parsed;
      return ok(
        summarizePlan(parsed.value, [
          'Demo mode: the file was validated, but nothing was written to storage.',
        ]),
      );
    }

    case 'ui.migration.export': {
      const date = new Date(now).toISOString().slice(0, 10);
      if (request.format === 'csv') {
        return ok({
          filename: `handshook-applications-${date}.csv`,
          text: buildApplicationsCsv({ items: db.items, jobs: db.jobs }),
          mimeType: 'text/csv',
        } satisfies MigrationExportPayload);
      }
      return ok({
        filename: `handshook-backup-${date}.json`,
        text: buildBackupJson({
          settings: db.settings,
          answers: db.answers,
          tracker: db.items,
          jobs: db.jobs,
          exportedAt: now,
        }),
        mimeType: 'application/json',
      } satisfies MigrationExportPayload);
    }

    case 'ui.events.list':
      return ok(db.events.slice(0, request.limit ?? 200));

    case 'ui.needs.list':
      return ok(db.needs);

    case 'ui.diagnostics.get':
      return ok({
        generatedAt: now,
        version: getExtensionVersion(),
        protocolVersion: PROTOCOL_VERSION,
        host: db.settings.host,
        mode: db.settings.mode,
        storage: {
          ok: true,
          name: 'Demo store (localStorage)',
          detail: 'Mock bridge — no extension storage is used.',
        },
        selectors: db.selectors,
        recentErrors: db.events.filter((event) => event.level === 'error').slice(0, 20),
        queue: buildSummary(db),
        counts: {
          events: db.events.length,
          answers: db.answers.length,
          documents: configuredDocuments(db.settings.documents).length,
        },
      } satisfies DiagnosticsPayload);

    case 'ui.queue.documents':
    case 'ui.needs.documentsResolved': {
      const need = db.needs.find((entry) => entry.jobId === request.jobId);
      const item = db.items.find((entry) => entry.jobId === request.jobId);
      if (!item) return err(appError('INVALID_INPUT', 'That job is no longer in the queue.'));
      const selection = documentSelectionForJob(db.settings.documents, {
        ...item.documentSelection,
        ...request.documents,
      });
      const required = new Set([
        ...(need?.missingDocumentTypes ?? []),
        ...DOCUMENT_TYPES.filter((type) => Boolean(idForType(selection, type))),
      ]);
      const available = configuredDocuments(db.settings.documents, selection);
      const missing = [...required].filter(
        (type) => !findDocumentForType(selection, type, available),
      );
      if (missing.length > 0)
        return err(
          appError(
            'MISSING_DOCUMENT',
            missing.map((type) => documentChoiceError(selection, type, available)).join('; '),
          ),
        );
      item.documentSelection = selection;
      if (request.type === 'ui.queue.documents') {
        saveDb(db);
        return ok({ jobId: request.jobId, status: item.status });
      }
      if (!need) return err(appError('INVALID_INPUT', 'That job no longer needs a document.'));
      need.missingDocumentTypes = [];
      if (item) {
        item.missingDocumentTypes = [];
        if (need.questions.length === 0) {
          item.status = 'queued';
          item.updatedAt = now;
        }
      }
      pushEvent(db, {
        level: 'info',
        type: 'documents.resolved',
        jobId: request.jobId,
        message: `Documents checked for ${jobTitle(db, request.jobId)}`,
      });
      saveDb(db);
      return ok({
        jobId: request.jobId,
        status: item?.status ?? 'needs_input',
        missingDocumentTypes: [],
        remainingQuestionIds: need.questions.map((entry) => entry.id),
      });
    }

    default: {
      void request;
      return err(
        appError('UNSUPPORTED_MESSAGE', `This version of the panel does not support that request.`),
      );
    }
  }
}

/** Test/help hook: wipes the demo store so a screen can start from first run. */
export function resetMockStore(): void {
  writeMock(seedMock());
}
