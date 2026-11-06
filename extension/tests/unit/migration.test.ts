import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { ImportExportSection } from '@/ui/screens/Settings/ImportExportSection';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Answer,
  type Job,
  type LegacyFileKindInput,
  type QueueItem,
  type Settings,
  type SettingsPatch,
} from '@/core/contracts';
import { applyLegacyImport } from '@/core/migration/apply';
import { exportBackupJson } from '@/core/migration/export';
import { parseLegacyFile, previewPlan, summarizePlan } from '@/core/migration/parse';
import { detectLegacyKind } from '@/core/migration/parse';
import { buildApplicationsCsv } from '@/core/migration/serialize';
import { MAX_IMPORT_BYTES, type MigrationPlan } from '@/core/migration/types';
import { listAnswers, saveAnswer } from '@/core/storage/answers';
import { getMeta, resetDb, setMeta } from '@/core/storage/db';
import { getJob, putJob } from '@/core/storage/jobs';
import { loadSettings, saveAiKey, saveSettings } from '@/core/storage/settings';
import { getQueueItem, isTerminalStatus, listQueue, upsertQueueItem } from '@/core/storage/tracker';
import { todayKey } from '@/core/util/time';

const TEMPLATE_SHAPE = {
  _comment: 'Copy this file to conf.json and fill in your settings.',
  COOKIES: {},
  RESUMES: [
    {
      id: null,
      title: 'Your Resume Title',
      description: 'Software Engineering resume with Python, JavaScript, React, AWS',
    },
  ],
  USER_NAME: '',
  COVER_LETTER_ID: null,
  TRANSCRIPT_ID: null,
  URL_LIST: [],
  SKIP_KEYWORDS: ['senior', 'lead', 'manager'],
  JOB_KEYWORDS: ['software', 'engineer', 'intern'],
  RATE_LIMIT_CONFIG: {
    min_delay_seconds: 60,
    max_delay_seconds: 120,
    daily_limit: 50,
    session_batch_size: 10,
    session_break_min: 300,
    session_break_max: 600,
    jitter_percent: 10,
    enabled: true,
  },
  CHROME_PROFILE: 'Default',
  PREFERRED_BROWSER: null,
  PROFILES: null,
  DATE: '0',
  URL: '',
};

function mustParse(kind: LegacyFileKindInput, value: unknown): MigrationPlan {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  const parsed = parseLegacyFile(kind, content);
  if (!parsed.ok) throw new Error(`Expected a parsed plan: ${parsed.error.message}`);
  return parsed.value;
}

async function mustApply(plan: MigrationPlan) {
  const result = await applyLegacyImport(plan);
  if (!result.ok) throw new Error(`Expected a successful import: ${result.error.message}`);
  return result.value;
}

function makeSettings(patch: SettingsPatch = {}): Settings {
  return mergeSettings(structuredClone(DEFAULT_SETTINGS), patch);
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '5001',
    host: 'app.joinhandshake.com',
    title: 'Sample Engineering Intern',
    employer: 'Sample Employer',
    url: 'https://app.joinhandshake.com/jobs/5001',
    description: 'Sanitized fixture text.',
    applyType: 'quick_apply',
    requiredDocumentTypes: ['resume'],
    source: 'search',
    discoveredAt: 1_000,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    jobId: '5001',
    status: 'applied',
    priority: 0,
    attempts: 1,
    addedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 'work_authorization',
    label: 'Are you authorized to work?',
    aliases: ['work authorization'],
    type: 'radio',
    value: 'yes',
    options: { Yes: 'yes', No: 'no' },
    category: 'work',
    autoSubmitAllowed: false,
    sensitive: true,
    updatedAt: 123,
    ...overrides,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderImportExport(): Promise<{
  container: HTMLDivElement;
  unmount: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const noop = async (): Promise<null> => null;
  const context: AppContextValue = {
    engine: null,
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: noop,
    start: noop,
    pause: noop,
    resume: noop,
    stop: noop,
    settings: null,
    settingsLoading: false,
    settingsError: null,
    refreshSettings: noop,
    saveSettings: async () => null,
    applySettings: () => undefined,
    view: 'settings',
    navigate: () => undefined,
    notify: () => undefined,
    bridgeMode: 'mock',
    version: 'test',
  };
  await act(async () => {
    root.render(
      createElement(AppContext.Provider, { value: context }, createElement(ImportExportSection)),
    );
  });
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

beforeEach(async () => {
  await resetDb();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('legacy conf.json import', () => {
  const conf = {
    COOKIES: { session: 'sentinel-cookie-value' },
    RESUMES: [
      { id: 111, title: 'Data Resume', description: 'SQL and Python' },
      { id: '222', title: 'Full Stack Resume' },
    ],
    COVER_LETTER_ID: 333,
    TRANSCRIPT_ID: '444',
    URL_LIST: [
      'https://app.joinhandshake.com/jobs?query=data%20analyst',
      'https://app.joinhandshake.com/jobs?query=software',
    ],
    SKIP_KEYWORDS: ['senior', 'manager', 'senior'],
    JOB_KEYWORDS: ['data', 'analyst'],
    RATE_LIMIT_CONFIG: {
      min_delay_seconds: 45,
      max_delay_seconds: 90,
      daily_limit: 30,
      session_batch_size: 5,
      session_break_min: 120,
      session_break_max: 240,
      jitter_percent: 15,
      enabled: true,
    },
    CHROME_PROFILE: 'Default',
    PREFERRED_BROWSER: 'chrome',
    USER_NAME: 'Sample User',
    API_KEY: 'sentinel-api-key-value',
  };

  it('maps resumes, document IDs, searches, keywords, and pacing', async () => {
    const plan = mustParse('conf', conf);
    expect(plan.kind).toBe('conf');
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.defaultResumeId).toBe('111');
    expect(plan.defaultResumeName).toBe('Data Resume');
    expect(plan.additionalResumes).toEqual([{ id: '222', name: 'Full Stack Resume' }]);
    expect(plan.searches).toHaveLength(2);
    expect(plan.includeKeywords).toEqual(['data', 'analyst']);
    expect(plan.excludeKeywords).toEqual(['senior', 'manager']);

    const summary = await mustApply(plan);
    expect(summary.documentsConfigured).toBe(4); // default, extra resume, cover, transcript
    expect(summary.searchesAdded).toBe(2);
    expect(summary.settingsUpdated).toBe(true);

    const settings = await loadSettings();
    expect(settings.documents.defaultResumeId).toBe('111');
    expect(settings.documents.defaultResumeName).toBe('Data Resume');
    expect(settings.documents.additionalResumes).toEqual([
      { id: '222', name: 'Full Stack Resume' },
    ]);
    expect(settings.documents.coverLetterId).toBe('333');
    expect(settings.documents.transcriptId).toBe('444');
    expect(settings.search.includeKeywords).toEqual(['data', 'analyst']);
    expect(settings.search.excludeKeywords).toEqual(['senior', 'manager']);
    expect(settings.search.savedSearches).toHaveLength(2);
    expect(settings.search.activeSearchId).toBe(settings.search.savedSearches[0]?.id);
    expect(settings.pacing).toMatchObject({
      minDelayMs: 45_000,
      maxDelayMs: 90_000,
      dailyCap: 30,
      hardCap: 100,
      sessionBatchSize: 5,
      sessionBreakMinMs: 120_000,
      sessionBreakMaxMs: 240_000,
      jitterPercent: 15,
    });
  });

  it('imports one default plus at most five additional resumes and reports the rest', async () => {
    const plan = mustParse('conf', {
      RESUMES: Array.from({ length: 7 }, (_, index) => ({
        id: String(100 + index),
        title: `Resume ${index + 1}`,
      })),
    });
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.defaultResumeId).toBe('100');
    expect(plan.defaultResumeName).toBe('Resume 1');
    expect(plan.additionalResumes).toHaveLength(5);
    expect(plan.additionalResumes.map((resume) => resume.id)).toEqual([
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
    expect(plan.warnings.join(' ')).toMatch(/1 resume beyond the 5 additional-resume limit/);

    const summary = await mustApply(plan);
    expect(summary.documentsConfigured).toBe(6);
    const settings = await loadSettings();
    expect(settings.documents.additionalResumes).toHaveLength(5);
  });

  it('skips and reports document IDs that are not valid', async () => {
    const plan = mustParse('conf', {
      RESUMES: [
        { id: '123', title: 'Kept' },
        { id: 'not a valid id!', title: 'Junk' },
        { id: '', title: 'Empty' },
      ],
      COVER_LETTER_ID: 'https://evil.example.com/docs/999',
      TRANSCRIPT_ID: 'https://app.joinhandshake.com/docs/456',
    });
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.defaultResumeId).toBe('123');
    expect(plan.coverLetterId).toBeUndefined();
    expect(plan.transcriptId).toBe('456');
    const warnings = plan.warnings.join(' ');
    expect(warnings).toMatch(/Skipped 2 resume entries/);
    expect(warnings).toMatch(/COVER_LETTER_ID/);
  });

  it('does not replace document IDs the user already set', async () => {
    await saveSettings(
      makeSettings({
        documents: {
          defaultResumeId: 'mine',
          defaultResumeName: 'My resume',
          coverLetterId: 'my-cover',
        },
      }),
    );

    const summary = await mustApply(mustParse('conf', conf));

    // Nothing was replaced: the preferred resume joins the additional list, the
    // second resume is added, and the free transcript slot is filled.
    expect(summary.documentsConfigured).toBe(3);
    const settings = await loadSettings();
    expect(settings.documents.defaultResumeId).toBe('mine');
    expect(settings.documents.defaultResumeName).toBe('My resume');
    expect(settings.documents.coverLetterId).toBe('my-cover');
    expect(settings.documents.transcriptId).toBe('444');
    // The imported preferred resume is kept as an additional resume.
    expect(settings.documents.additionalResumes).toEqual([
      { id: '111', name: 'Data Resume' },
      { id: '222', name: 'Full Stack Resume' },
    ]);
  });

  it('does not keep the default resume duplicated in the additional list', async () => {
    await saveSettings(
      makeSettings({
        documents: { additionalResumes: [{ id: '111', name: 'Old label' }] },
      }),
    );

    const summary = await mustApply(mustParse('conf', conf));

    const settings = await loadSettings();
    expect(settings.documents.defaultResumeId).toBe('111');
    expect(settings.documents.defaultResumeName).toBe('Data Resume');
    expect(settings.documents.additionalResumes).toEqual([
      { id: '222', name: 'Full Stack Resume' },
    ]);
    expect(summary.documentsConfigured).toBe(4);
  });

  it('never carries cookies or API-key values into the parsed plan', () => {
    const plan = mustParse('conf', conf);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('sentinel-cookie-value');
    expect(serialized).not.toContain('sentinel-api-key-value');
    expect(serialized).toContain('COOKIES');
    expect(serialized).toContain('API_KEY');
  });

  it('is idempotent: a second import adds no documents or searches', async () => {
    await mustApply(mustParse('conf', conf));
    const before = await loadSettings();
    const second = await mustApply(mustParse('conf', conf));

    expect(second.documentsConfigured).toBe(0);
    expect(second.searchesAdded).toBe(0);
    const after = await loadSettings();
    expect(after.search.savedSearches.map((entry) => entry.id)).toEqual(
      before.search.savedSearches.map((entry) => entry.id),
    );
    expect(after.documents).toEqual(before.documents);
  });

  it('accepts the real template shape (null resume ID, empty lists)', async () => {
    const plan = mustParse('conf', TEMPLATE_SHAPE);
    expect(plan.kind).toBe('conf');
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.defaultResumeId).toBeUndefined();
    expect(plan.additionalResumes).toHaveLength(0);
    expect(plan.searches).toHaveLength(0);
    expect(plan.warnings.join(' ')).toMatch(/Skipped 1 resume entry/);

    const summary = await mustApply(plan);
    expect(summary.documentsConfigured).toBe(0);
    const settings = await loadSettings();
    expect(settings.pacing.dailyCap).toBe(50);
    expect(settings.pacing.minDelayMs).toBe(60_000);
    expect(settings.pacing.useAdvanced).toBe(true);
    expect(settings.pacing.maxDelayMs).toBe(120_000);
  });

  it('imports the first active profile and its own keywords and URL', async () => {
    const plan = mustParse('conf', {
      RESUMES: [{ id: '55', title: 'Data Resume' }],
      PROFILES: [
        {
          id: 1,
          name: 'Disabled Profile',
          enabled: false,
          url: 'https://app.joinhandshake.com/jobs?query=ignored',
          job_keywords: ['ignored'],
        },
        {
          id: 2,
          name: 'Active Profile',
          resume: '55',
          cover: '56',
          transcript: '57',
          other: '58',
          url: 'https://app.joinhandshake.com/jobs?query=ml',
          job_keywords: ['ml'],
          skip_keywords: ['phd'],
          cookies: { session: 'sentinel-profile-cookie' },
        },
        { id: 3, name: 'Second Profile', url: 'https://app.joinhandshake.com/jobs?query=x' },
      ],
    });
    expect(plan.kind).toBe('conf');
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.profileName).toBe('Active Profile');
    expect(plan.defaultResumeId).toBe('55');
    expect(plan.defaultResumeName).toBe('Data Resume');
    expect(plan.coverLetterId).toBe('56');
    expect(plan.transcriptId).toBe('57');
    expect(plan.otherDocumentId).toBe('58');
    expect(plan.includeKeywords).toEqual(['ml']);
    expect(plan.excludeKeywords).toEqual(['phd']);
    expect(plan.searches).toHaveLength(1);
    expect(plan.searches[0]?.url).toContain('query=ml');
    expect(plan.warnings.join(' ')).toMatch(/Only the first active profile/);
    expect(plan.warnings.join(' ')).toMatch(/Per-profile cookies were ignored/);
    expect(JSON.stringify(plan)).not.toContain('sentinel-profile-cookie');

    await mustApply(plan);
    const settings = await loadSettings();
    expect(settings.documents.defaultResumeId).toBe('55');
    expect(settings.documents.coverLetterId).toBe('56');
    expect(settings.documents.transcriptId).toBe('57');
    expect(settings.documents.otherDocumentId).toBe('58');
  });

  it('clamps pacing values to the extension limits', async () => {
    const plan = mustParse('conf', {
      RATE_LIMIT_CONFIG: {
        min_delay_seconds: 10,
        max_delay_seconds: 20,
        daily_limit: 500,
        session_batch_size: 0,
        session_break_min: 1,
        session_break_max: 0,
        jitter_percent: 80,
      },
    });
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.pacing).toMatchObject({
      minDelayMs: 30_000,
      maxDelayMs: 30_000,
      dailyCap: 100,
      hardCap: 100,
      sessionBatchSize: 1,
      sessionBreakMinMs: 1_000,
      sessionBreakMaxMs: 1_000,
      jitterPercent: 50,
    });
    expect(plan.warnings.join(' ')).toMatch(/clamped/);
  });

  it('handles partial data and reports what was skipped', async () => {
    const plan = mustParse('conf', {
      RESUMES: [{ id: '77', title: 'Valid' }, { title: 'No ID' }, 'junk'],
      URL_LIST: ['https://app.joinhandshake.com/jobs?query=one', 42, null],
      RATE_LIMIT_CONFIG: 'not an object',
      JOB_KEYWORDS: 'not a list',
    });
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.defaultResumeId).toBe('77');
    expect(plan.additionalResumes).toHaveLength(0);
    expect(plan.searches).toHaveLength(1);
    expect(plan.includeKeywords).toBeUndefined();
    expect(plan.pacing).toEqual({});
    expect(plan.warnings.join(' ')).toMatch(/Skipped 2 resume entries/);
    expect(plan.warnings.join(' ')).toMatch(/URL_LIST entry/);
    expect(plan.warnings.join(' ')).toMatch(/RATE_LIMIT_CONFIG is not an object/);
    expect(plan.warnings.join(' ')).toMatch(/JOB_KEYWORDS is not a list/);
  });
});

describe('legacy job_tracker.json import', () => {
  const appliedAt = '2026-01-02T03:04:05';
  const recordedAt = '2026-01-03T04:05:06';

  const tracker = {
    applied: {
      '1001': { name: 'Backend Intern', employer: 'Sample Employer', applied_at: appliedAt },
    },
    external: {
      '1002': { name: 'External Role', employer: 'Sample Employer', recorded_at: recordedAt },
    },
    skipped: { '1003': { name: 'Skipped Role', reason: 'senior', recorded_at: recordedAt } },
    unsupported: {
      '1004': { name: 'Unsupported Role', reason: 'missing transcript', recorded_at: recordedAt },
    },
    failed: { '1005': { name: 'Failed Role', error: 'temporary error', recorded_at: recordedAt } },
    waiting: { '1006': { name: 'Waiting Role', open_date: '2026-02-01', recorded_at: recordedAt } },
    metadata: { version: '1.0' },
  };

  it('maps every Python category and preserves timestamps', async () => {
    const plan = mustParse('tracker', tracker);
    expect(plan.kind).toBe('tracker');
    if (plan.kind !== 'tracker') throw new Error('wrong plan');
    expect(plan.entries).toHaveLength(6);

    const summary = await mustApply(plan);
    expect(summary.trackerImported).toBe(6);
    expect(summary.jobsImported).toBe(6);

    await expect(getQueueItem('1001')).resolves.toMatchObject({
      status: 'applied',
      updatedAt: Date.parse(appliedAt),
      attempts: 1,
    });
    await expect(getQueueItem('1002')).resolves.toMatchObject({
      status: 'external',
      updatedAt: Date.parse(recordedAt),
    });
    await expect(getQueueItem('1003')).resolves.toMatchObject({ status: 'skipped' });
    await expect(getQueueItem('1004')).resolves.toMatchObject({
      status: 'blocked',
      lastError: { code: 'MISSING_DOCUMENT', retryable: false },
    });
    await expect(getQueueItem('1005')).resolves.toMatchObject({
      status: 'failed',
      lastError: { code: 'UNKNOWN', retryable: true },
    });
    await expect(getQueueItem('1006')).resolves.toMatchObject({
      status: 'waiting',
      nextAttemptAt: Date.parse('2026-02-01'),
    });

    expect(isTerminalStatus('blocked')).toBe(true);
    await expect(getJob('1001')).resolves.toMatchObject({
      title: 'Backend Intern',
      employer: 'Sample Employer',
      source: 'import',
      applyType: 'unknown',
    });
    await expect(getJob('1002')).resolves.toMatchObject({ applyType: 'external' });
    await expect(listQueue()).resolves.toHaveLength(6);
  });

  it('is idempotent and keeps terminal statuses terminal', async () => {
    await mustApply(mustParse('tracker', tracker));
    const second = await mustApply(mustParse('tracker', tracker));
    expect(second.trackerImported).toBe(0);
    expect(second.trackerKept).toBe(6);
    await expect(listQueue()).resolves.toHaveLength(6);

    // A stale file claiming the applied job failed must not make it retryable.
    await mustApply(
      mustParse('tracker', {
        failed: {
          '1001': { name: 'Backend Intern', error: 'late failure', recorded_at: '2026-03-01' },
        },
      }),
    );
    await expect(getQueueItem('1001')).resolves.toMatchObject({ status: 'applied' });
    await expect(isTrackedResult('1001')).resolves.toBe('applied');
  });

  it('upgrades a retryable extension entry when the import is terminal', async () => {
    await upsertQueueItem(
      makeQueueItem({ jobId: '2000', status: 'failed', updatedAt: Date.parse('2025-12-01') }),
    );
    await mustApply(
      mustParse('tracker', {
        applied: { '2000': { name: 'Now Applied', applied_at: '2026-01-05T00:00:00' } },
      }),
    );
    await expect(getQueueItem('2000')).resolves.toMatchObject({
      status: 'applied',
      updatedAt: Date.parse('2026-01-05T00:00:00'),
    });
  });

  it('does not overwrite newer extension state with an older retryable entry', async () => {
    const newer = Date.parse('2026-05-01T00:00:00');
    await upsertQueueItem(
      makeQueueItem({ jobId: '3000', status: 'waiting', updatedAt: newer, nextAttemptAt: newer }),
    );
    await mustApply(
      mustParse('tracker', {
        failed: { '3000': { name: 'Old Failure', recorded_at: '2026-01-01' } },
      }),
    );
    await expect(getQueueItem('3000')).resolves.toMatchObject({
      status: 'waiting',
      updatedAt: newer,
    });
  });

  it('lets applied win when the same ID appears in two categories', async () => {
    const plan = mustParse('tracker', {
      applied: { '4000': { name: 'Applied Role', applied_at: '2026-01-01T00:00:00' } },
      failed: { '4000': { name: 'Applied Role', error: 'boom', recorded_at: '2026-01-02' } },
    });
    if (plan.kind !== 'tracker') throw new Error('wrong plan');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.status).toBe('applied');
    expect(plan.warnings.join(' ')).toMatch(/more than one category/);
  });

  it('skips non-numeric IDs and reports the unsupported → blocked mapping', () => {
    const plan = mustParse('tracker', {
      applied: { 'not-a-job': { name: 'Junk' } },
      unsupported: { '9001': { name: 'Blocked Role', reason: 'doc' } },
    });
    if (plan.kind !== 'tracker') throw new Error('wrong plan');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ jobId: '9001', status: 'blocked' });
    expect(plan.warnings.join(' ')).toMatch(/non-numeric job ID/);
    expect(plan.warnings.join(' ')).toMatch(/imported as blocked/);
  });
});

describe('legacy rate_stats import', () => {
  it("imports only today's count and never lowers the existing counter", async () => {
    const today = todayKey();
    const plan = mustParse('rate_stats', {
      daily_counts: { [today]: 7, '2000-01-01': 99 },
      total_applications: 40,
      history: [],
    });
    expect(plan.kind).toBe('rate_stats');
    if (plan.kind !== 'rate_stats') throw new Error('wrong plan');
    expect(plan.todayCount).toBe(7);
    expect(plan.totalApplications).toBe(40);
    expect(plan.warnings.join(' ')).toMatch(/Only today's application count/);

    const first = await mustApply(plan);
    expect(first.todayCount).toBe(7);
    await expect(getMeta(`dailyCount:${today}`)).resolves.toBe(7);
    await expect(getMeta('legacyTotalApplications')).resolves.toBe(40);

    await setMeta(`dailyCount:${today}`, 9);
    const second = await mustApply(plan);
    expect(second.todayCount).toBe(9);
    await expect(getMeta(`dailyCount:${today}`)).resolves.toBe(9);
  });

  it('imports nothing when today has no count', async () => {
    const plan = mustParse('rate_stats', { daily_counts: { '2000-01-01': 3 } });
    if (plan.kind !== 'rate_stats') throw new Error('wrong plan');
    expect(plan.todayCount).toBe(0);
    expect(plan.warnings.join(' ')).toMatch(/No application count was found for today/);
    const summary = await mustApply(plan);
    expect(summary.todayCount).toBe(0);
  });

  it('rejects a JSON file without a daily_counts object', () => {
    const parsed = parseLegacyFile('rate_stats', JSON.stringify({ daily_counts: [] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('INVALID_INPUT');
  });
});

describe('Handshook backup export and restore', () => {
  it('round-trips settings, answers, jobs, and tracker without keys or a document inventory', async () => {
    const settings = makeSettings({
      onboardingComplete: true,
      search: { includeKeywords: ['data'], excludeKeywords: ['senior'] },
      documents: {
        defaultResumeId: 'doc-1',
        defaultResumeName: 'Main Resume',
        coverLetterId: 'doc-2',
      },
      pacing: { dailyCap: 12 },
    });
    await saveSettings(settings);
    const answer = makeAnswer();
    await saveAnswer(answer);
    await putJob(makeJob());
    await upsertQueueItem(makeQueueItem());
    await saveAiKey('AIzaSySENTINELKEYVALUE');

    const exported = await exportBackupJson();
    expect(exported.filename).toMatch(/^handshook-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(exported.mimeType).toBe('application/json');
    expect(exported.text).not.toContain('AIzaSySENTINELKEYVALUE');
    expect(exported.text).not.toContain('openRouterApiKey');
    expect(JSON.parse(exported.text)).toMatchObject({
      format: 'handshook-backup',
      version: 1,
    });
    // The scraped inventory is gone; settings carry the IDs and names.
    expect(JSON.parse(exported.text)).not.toHaveProperty('documents');

    const plan = mustParse('auto', exported.text);
    expect(plan.kind).toBe('backup');

    await resetDb();
    window.localStorage.clear();
    const summary = await mustApply(plan);
    expect(summary.settingsUpdated).toBe(true);
    expect(summary.answersImported).toBe(1);
    expect(summary.documentsConfigured).toBe(2);
    expect(summary.trackerImported).toBe(1);

    const restored = await loadSettings();
    expect(restored.search.includeKeywords).toEqual(['data']);
    expect(restored.documents.defaultResumeId).toBe('doc-1');
    expect(restored.documents.defaultResumeName).toBe('Main Resume');
    expect(restored.pacing.dailyCap).toBe(12);
    await expect(listAnswers()).resolves.toMatchObject([
      { id: 'work_authorization', value: 'yes' },
    ]);
    await expect(getJob('5001')).resolves.toMatchObject({ title: 'Sample Engineering Intern' });
    await expect(getQueueItem('5001')).resolves.toMatchObject({ status: 'applied' });

    const second = await mustApply(mustParse('auto', exported.text));
    expect(second.trackerImported).toBe(0);
    expect(second.trackerKept).toBe(1);
    await expect(listQueue()).resolves.toHaveLength(1);
  });

  it('imports an older backup whose scraped documents and AI allow-list predate settings IDs', async () => {
    const raw = {
      format: 'handshook-backup',
      version: 1,
      exportedAt: 1,
      settings: {
        ...DEFAULT_SETTINGS,
        documents: {
          defaultResumeId: 'doc-1',
          coverLetterId: 'cl-1',
          aiResumeIds: [
            'doc-2',
            'doc-3',
            'doc-1',
            'not valid!',
            'doc-4',
            'doc-5',
            'doc-6',
            'doc-7',
          ],
        },
      },
      answers: [],
      documents: [
        { id: 'doc-1', type: 'resume', title: 'Main Resume' },
        { id: 'doc-2', type: 'resume', title: 'Data Resume' },
        { id: 'doc-3', type: 'resume', title: '' },
        { id: 'doc-4', type: 'resume', title: 'Backend Resume' },
        { id: 'cl-1', type: 'cover_letter', title: 'My Cover Letter' },
      ],
      tracker: [],
      jobs: [],
    };

    const plan = mustParse('backup', raw);
    if (plan.kind !== 'backup') throw new Error('wrong plan');
    // The inventory itself is not restored; it only supplied the names.
    expect(plan).not.toHaveProperty('documents');
    expect(plan.settings?.documents.defaultResumeName).toBe('Main Resume');
    expect(plan.settings?.documents.coverLetterName).toBe('My Cover Letter');
    expect(plan.settings?.documents.additionalResumes).toEqual([
      { id: 'doc-2', name: 'Data Resume' },
      { id: 'doc-3', name: 'Resume doc-3' },
      { id: 'doc-4', name: 'Backend Resume' },
      { id: 'doc-5', name: 'Resume doc-5' },
      { id: 'doc-6', name: 'Resume doc-6' },
    ]);
    const warnings = plan.warnings.join(' ');
    expect(warnings).toMatch(/not valid/);
    expect(warnings).toMatch(/additional-resume limit/);

    await mustApply(plan);
    const restored = await loadSettings();
    expect(restored.documents.defaultResumeId).toBe('doc-1');
    expect(restored.documents.defaultResumeName).toBe('Main Resume');
    expect(restored.documents.additionalResumes).toHaveLength(5);
  });

  it('does not add AI resume IDs that the user already saved as additional resumes', () => {
    const plan = mustParse('backup', {
      format: 'handshook-backup',
      version: 1,
      exportedAt: 1,
      settings: {
        ...DEFAULT_SETTINGS,
        documents: {
          defaultResumeId: 'doc-1',
          additionalResumes: [{ id: 'doc-2', name: 'Chosen name' }],
          aiResumeIds: ['doc-2', 'doc-3'],
        },
      },
      answers: [],
      documents: [{ id: 'doc-2', type: 'resume', title: 'Scraped name' }],
      tracker: [],
      jobs: [],
    });
    if (plan.kind !== 'backup') throw new Error('wrong plan');
    expect(plan.settings?.documents.additionalResumes).toEqual([
      { id: 'doc-2', name: 'Chosen name' },
    ]);
  });

  it('warns that secrets in a backup are never restored', () => {
    const raw = {
      format: 'handshook-backup',
      version: 1,
      exportedAt: 1,
      settings: DEFAULT_SETTINGS,
      answers: [],
      documents: [],
      tracker: [],
      jobs: [],
      aiKeys: { openRouterApiKey: 'sentinel' },
    };
    const plan = mustParse('backup', raw);
    if (plan.kind !== 'backup') throw new Error('wrong plan');
    expect(plan.warnings.join(' ')).toMatch(/never restored/);
    expect(JSON.stringify(plan)).not.toContain('sentinel');
  });

  it('resets autopilot and unsafe safety flags from a backup and warns', () => {
    const raw = {
      format: 'handshook-backup',
      version: 1,
      exportedAt: 1,
      settings: {
        ...DEFAULT_SETTINGS,
        mode: 'autopilot',
        onboardingComplete: true,
        safety: {
          ...DEFAULT_SETTINGS.safety,
          allowSensitiveAutoSubmit: true,
          allowEeoAutoFill: true,
          allowFreeTextAutoFill: true,
          reviewBeforeSubmit: false,
          stopOnUnknownQuestion: false,
        },
      },
      answers: [],
      documents: [],
      tracker: [],
      jobs: [],
    };

    const plan = mustParse('backup', raw);
    if (plan.kind !== 'backup') throw new Error('wrong plan');
    expect(plan.settings?.mode).toBe('review');
    expect(plan.settings?.safety).toMatchObject({
      allowSensitiveAutoSubmit: false,
      allowEeoAutoFill: false,
      allowFreeTextAutoFill: false,
      reviewBeforeSubmit: true,
      stopOnUnknownQuestion: true,
    });
    const warnings = plan.warnings.join(' ');
    expect(warnings).toMatch(/reset to safe defaults/i);
    expect(warnings).toMatch(/run mode/i);
  });

  it('rejects unsupported backup versions and foreign JSON', () => {
    const version = parseLegacyFile(
      'backup',
      JSON.stringify({ format: 'handshook-backup', version: 99 }),
    );
    expect(version.ok).toBe(false);
    if (!version.ok) expect(version.error.code).toBe('INVALID_INPUT');

    const foreign = parseLegacyFile('backup', JSON.stringify({ hello: 'world' }));
    expect(foreign.ok).toBe(false);
  });
});

describe('applications CSV', () => {
  it('exports only application outcomes, newest first, with CSV escaping', () => {
    const items: QueueItem[] = [
      makeQueueItem({ jobId: '1', status: 'applied', updatedAt: 2_000 }),
      makeQueueItem({ jobId: '2', status: 'external', updatedAt: 3_000 }),
      makeQueueItem({ jobId: '3', status: 'failed', updatedAt: 4_000 }),
      makeQueueItem({ jobId: '4', status: 'already_applied', updatedAt: 5_000 }),
    ];
    const jobs: Job[] = [
      makeJob({ id: '2', title: 'Role, Senior', employer: 'Acme, Inc. "Division"' }),
    ];

    const csv = buildApplicationsCsv({ items, jobs });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('job_id,status,title,employer,url,host,applied_at,attempts');
    expect(csv).not.toContain('3,failed');
    expect(csv).toContain('4,already_applied');
    expect(csv).toContain('2,external');
    expect(csv).toContain('1,applied');
    expect(csv).toContain('"Role, Senior"');
    expect(csv).toContain('"Acme, Inc. ""Division"""');
    // Newest first: 4 (5000), 2 (3000), 1 (2000).
    expect(lines[1]?.startsWith('4,already_applied')).toBe(true);
    expect(lines[2]?.startsWith('2,external')).toBe(true);
    expect(lines[3]?.startsWith('1,applied')).toBe(true);
  });

  it('returns only the header when there are no applications', () => {
    const csv = buildApplicationsCsv({
      items: [makeQueueItem({ status: 'queued' })],
      jobs: [],
    });
    expect(csv.trimEnd().split('\n')).toEqual([
      'job_id,status,title,employer,url,host,applied_at,attempts',
    ]);
  });
});

describe('validation and detection', () => {
  it('detects each supported file shape', () => {
    expect(detectLegacyKind({ applied: {} })).toBe('tracker');
    expect(detectLegacyKind({ daily_counts: {} })).toBe('rate_stats');
    expect(detectLegacyKind({ RESUMES: [] })).toBe('conf');
    expect(detectLegacyKind({ format: 'handshook-backup', version: 1 })).toBe('backup');
    expect(detectLegacyKind({ nope: true })).toBeNull();
  });

  it('rejects malformed, empty, oversized, and foreign JSON', () => {
    expect(parseLegacyFile('auto', '{bad json').ok).toBe(false);
    expect(parseLegacyFile('auto', '').ok).toBe(false);
    expect(parseLegacyFile('auto', '[]').ok).toBe(false);
    expect(parseLegacyFile('auto', 'x'.repeat(MAX_IMPORT_BYTES + 1)).ok).toBe(false);
    expect(parseLegacyFile('auto', JSON.stringify({ nope: true })).ok).toBe(false);
  });

  it('rejects an explicit kind that contradicts the detected shape', () => {
    const parsed = parseLegacyFile('conf', JSON.stringify({ applied: {} }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/job_tracker/);
  });

  it('builds a preview and a summary without touching storage', () => {
    const plan = mustParse('tracker', {
      applied: { '1': { name: 'One' } },
      failed: { '2': { name: 'Two' } },
    });
    const preview = previewPlan(plan);
    expect(preview.kind).toBe('tracker');
    expect(preview.counts).toEqual(
      expect.arrayContaining([
        { label: 'Total jobs', value: 2 },
        { label: 'Status: applied', value: 1 },
        { label: 'Status: failed', value: 1 },
      ]),
    );
    const summary = summarizePlan(plan, ['demo']);
    expect(summary.trackerImported).toBe(2);
    expect(summary.warnings).toContain('demo');
  });
});

describe('import/export UI', () => {
  it('labels the picker, explains exclusions, previews a file, and confirms', async () => {
    const { container, unmount } = await renderImportExport();
    try {
      expect(container.textContent).toContain('Import & export');
      expect(container.textContent).toContain('Never imported:');
      expect(container.textContent).toContain('cookies, passwords, API keys');

      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      if (!input) throw new Error('file input not rendered');
      const inputId = input.getAttribute('id');
      expect(inputId).toBeTruthy();
      const label = container.querySelector(`label[for="${inputId}"]`);
      expect(label?.textContent).toContain('Legacy or backup file');

      const file = new File(
        [
          JSON.stringify({
            COOKIES: { session: 'sentinel-cookie-value' },
            RESUMES: [{ id: '111', title: 'Sample Resume' }],
            URL_LIST: ['https://app.joinhandshake.com/jobs?query=data'],
          }),
        ],
        'conf.json',
        { type: 'application/json' },
      );
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain('Preview: conf.json');
      expect(container.textContent).toContain('Resumes');
      expect(container.textContent).toContain('Saved searches');
      expect(container.textContent).toContain('Cookies were not imported');
      expect(container.textContent).not.toContain('sentinel-cookie-value');

      const importButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Import this file'),
      );
      expect(importButton).toBeDefined();
      await act(async () => {
        importButton?.click();
      });
      expect(container.textContent).toContain('Import this file?');
      expect(container.textContent).toContain('Existing final statuses are kept');

      // The commit must use the bytes captured for the preview, not re-read the
      // input at confirmation time. Replace the file after previewing.
      const replacement = new File(
        [JSON.stringify({ applied: { '1': { name: 'One' }, '2': { name: 'Two' } } })],
        'job_tracker.json',
        { type: 'application/json' },
      );
      Object.defineProperty(input, 'files', { configurable: true, value: [replacement] });
      const confirmButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Import',
      );
      expect(confirmButton).toBeDefined();
      await act(async () => {
        confirmButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain('saved search');
      expect(container.textContent).not.toContain('tracker entr');
    } finally {
      unmount();
    }
  });
});

/** Small local wrapper so the terminal assertion reads naturally. */
async function isTrackedResult(jobId: string): Promise<string | null> {
  const item = await getQueueItem(jobId);
  if (!item) return null;
  return isTerminalStatus(item.status) ? item.status : null;
}

describe('M12 — imported destinations stay on Handshake', () => {
  it('drops off-Handshake saved searches from conf.json', () => {
    const plan = mustParse('conf', {
      ...TEMPLATE_SHAPE,
      URL_LIST: ['https://evil.example.com/jobs', 'https://app.joinhandshake.com/job-search'],
    });
    if (plan.kind !== 'conf') throw new Error('wrong plan');
    expect(plan.searches.map((search) => search.url)).toEqual([
      'https://app.joinhandshake.com/job-search',
    ]);
    expect(plan.warnings.join(' ')).toMatch(/HTTPS Handshake URL/);
  });

  it('drops off-Handshake backup jobs and saved searches', async () => {
    const backup = {
      format: 'handshook-backup',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      settings: makeSettings({
        search: {
          savedSearches: [
            {
              id: 'evil',
              name: 'Evil',
              url: 'https://evil.example.com/job-search',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      }),
      answers: [],
      documents: [],
      tracker: [],
      jobs: [makeJob(), makeJob({ id: '5002', url: 'https://evil.example.com/jobs/5002' })],
    };

    const plan = mustParse('backup', backup);
    if (plan.kind !== 'backup') throw new Error('wrong plan');
    expect(plan.jobs.map((job) => job.id)).toEqual(['5001']);
    expect(plan.warnings.join(' ')).toMatch(/not an HTTPS Handshake URL/);

    const summary = await mustApply(plan);
    expect(summary.settingsUpdated).toBe(true);
    const restored = await loadSettings();
    expect(restored.search.savedSearches).toEqual([]);
    await expect(getJob('5002')).resolves.toBeUndefined();
  });
});
