import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_STORES, STORAGE_KEYS, type SelectorHealth } from '@/core/contracts';
import { handleContentEvent, handleUi } from '@/background/router';
import { buildDiagnosticsBundle } from '@/core/diagnostics/export';
import {
  MAX_SELECTOR_HEALTH_ENTRIES,
  recordSelectorHealthEntries,
  summarizeSelectorHealth,
} from '@/core/diagnostics/selectorHealth';
import { exportApplicationsCsv, exportBackupJson } from '@/core/migration/export';
import { buildApplicationsCsv, buildBackupJson } from '@/core/migration/serialize';
import { parseLegacyFile } from '@/core/migration/parse';
import { appendEvent } from '@/core/logging/eventStore';
import { getDb, resetDb, setMeta } from '@/core/storage/db';
import { saveAiKey, saveSettings } from '@/core/storage/settings';
import { todayKey } from '@/core/util/time';
import {
  FIXED_NOW,
  makeAnswer,
  makeEngineState,
  makeEvent,
  makeJob,
  makeQueueItem,
  makeSettings,
} from '@/test/factories';
import { discoverySelectors } from '@/handshake/selectors/discovery';
import { describeJobActionArea, jobSelectors } from '@/handshake/selectors/job';
import { createFakeBrowser } from './helpers/fakeBrowser';

// Fictional sentinels only. These are deliberately spread across old raw state,
// free text and credentials, rather than tested only through the new logger.
const PII = {
  name: 'Fictional Morgan Quill',
  email: 'synthetic.student+privacy@example.test',
  phone: '+1 (202) 555-0199',
  internationalPhone: '+44 1632 960321',
  employer: 'Example Aurora Works',
  title: 'Synthetic Research Internship',
  description: 'Fictional private job description for an export test',
  answer: 'Synthetic personal statement never intended for diagnostics',
  document: 'Fictional Morgan private resume',
  filename: 'synthetic-private-resume.pdf',
  documentId: 'synthetic-document-id-42',
  jobId: '123456789',
  userId: 'synthetic-user-id-73',
  tenant: 'synthetic-college.joinhandshake.com',
  keyword: 'synthetic-private-keyword',
  location: 'Synthetic Private City',
  run: 'synthetic-private-run',
  cookie: 'synthetic-cookie-material',
  auth: 'synthetic-authorization-material',
};
const OPENROUTER_KEY = `sk-or-v1-${'SyntheticNonWorkingKey'.repeat(2)}`;
let storage: Map<string, unknown>;

beforeEach(async () => {
  const browser = createFakeBrowser();
  storage = browser.storage;
  vi.stubGlobal('browser', browser.fake);
  await resetDb();
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedPrivateStorage(key = OPENROUTER_KEY) {
  const settings = makeSettings({
    host: PII.tenant,
    mode: 'review',
    onboardingComplete: true,
    search: {
      savedSearches: [
        {
          id: PII.userId,
          name: PII.name,
          url: `https://${PII.tenant}/job-search?query=${encodeURIComponent(PII.keyword)}&token=${key}`,
          enabled: true,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      ],
      activeSearchId: PII.userId,
      includeKeywords: [PII.keyword, PII.name, key],
      excludeKeywords: [PII.employer],
      locations: [PII.location],
      employmentTypes: [PII.answer],
    },
    documents: { defaultResumeId: PII.documentId },
    ai: { enabled: true, provider: 'openrouter' },
  });
  await saveSettings(settings);
  await saveAiKey(key);
  storage.set('unrelated-auth', { cookie: PII.cookie, authorization: PII.auth });
  storage.set(STORAGE_KEYS.engine, {
    ...makeEngineState({
      status: 'paused',
      mode: 'review',
      currentPhase: 'filling',
      pauseReason: 'ui_changed',
      host: PII.tenant,
      runId: PII.run,
      currentJobId: PII.jobId,
      consecutiveFailures: 2,
      message: Object.values(PII).join(' '),
      lastError: {
        code: 'UI_CHANGED',
        message: PII.name,
        retryable: false,
        cause: key,
        details: { email: PII.email, employer: PII.employer, cookie: PII.cookie },
      },
    }),
    futurePrivateField: PII.name,
  });
  storage.set(STORAGE_KEYS.onboarding, {
    version: 1,
    step: 'documents',
    host: PII.tenant,
    sessionStatus: 'logged_in',
    name: PII.name,
    email: PII.email,
    userId: PII.userId,
    cookie: PII.cookie,
    openRouterApiKey: key,
  });
  await setMeta(`dailyCount:${todayKey()}`, 2);

  const answer = makeAnswer({
    label: PII.name,
    value: `${PII.answer} ${key}`,
    aliases: [PII.email],
  });
  const job = makeJob({
    id: PII.jobId,
    title: `${PII.title} ${key}`,
    employer: PII.employer,
    description: `${PII.description} Bearer ${PII.auth}`,
    url: `https://app.joinhandshake.com/jobs/${PII.jobId}?token=${key}`,
    location: PII.location,
  });
  const item = makeQueueItem({
    jobId: PII.jobId,
    status: 'applied',
    lastError: {
      code: 'UI_CHANGED',
      message: `Cookie: sid=${PII.cookie}`,
      retryable: false,
      details: { session: { unrelated: PII.auth }, email: PII.email },
    },
  });
  const db = await getDb();
  await db.put(DB_STORES.answers, answer);
  await db.put(DB_STORES.jobs, job);
  await db.put(DB_STORES.queue, item);
  await appendEvent(
    makeEvent({
      type: 'job.opening',
      jobId: PII.jobId,
      id: PII.userId,
      message: `${Object.values(PII).join(' ')} ${key}`,
      data: {
        count: 3,
        retryable: false,
        provider: 'openrouter',
        code: 'UI_CHANGED',
        [PII.email]: PII.answer,
        employer: PII.employer,
        description: PII.description,
        token: PII.auth,
      },
    }),
  );
  await appendEvent(
    makeEvent(
      { type: PII.name, data: { count: PII.name, provider: key, status: PII.employer } },
      2,
    ),
  );
  await setMeta('selectorHealth', [
    {
      at: FIXED_NOW,
      page: 'job',
      selector: 'job.applyButton',
      strategy: 'text:apply',
      ok: true,
      detail: PII.name,
    },
    {
      at: FIXED_NOW + 1,
      page: 'job',
      selector: 'job.applyButton',
      strategy: 'text:apply',
      ok: false,
      detail: PII.description,
    },
    {
      at: FIXED_NOW,
      page: 'job',
      selector: PII.employer,
      strategy: PII.document,
      ok: false,
      detail: key,
    },
  ]);
  return { settings, answers: [answer], jobs: [job], tracker: [item] };
}

describe('shareable diagnostics privacy', () => {
  it('leak-scans raw storage and the actual diagnostics export response', async () => {
    await seedPrivateStorage();
    const bundle = await buildDiagnosticsBundle('1.2.3');
    const response = await handleUi({
      type: 'ui.diagnostics.export',
      requestId: 'privacy-diagnostics',
    });
    expect(response.ok).toBe(true);
    for (const output of [JSON.stringify(bundle), JSON.stringify(response)]) {
      for (const sentinel of [...Object.values(PII), OPENROUTER_KEY])
        expect(output).not.toContain(sentinel);
      expect(output).not.toContain('futurePrivateField');
    }
    expect(bundle).toMatchObject({
      redactionVersion: 4,
      version: '1.2.3',
      protocol: 1,
      engine: {
        status: 'paused',
        currentPhase: 'filling',
        pauseReason: 'ui_changed',
        consecutiveFailures: 2,
        lastError: { code: 'UI_CHANGED' },
      },
      settings: {
        mode: 'review',
        ai: { provider: 'openrouter', enabled: true },
        pacing: { dailyCap: 15 },
        documents: {
          defaultResumeSet: true,
          additionalResumes: 0,
          coverLetterSet: false,
          transcriptSet: false,
          otherDocumentSet: false,
        },
      },
      onboarding: { sessionStatus: 'logged_in' },
      queueSummary: { counts: { applied: 1 }, total: 1, todayCount: 2 },
      counts: { events: 2, selectorChecks: 3 },
    });
    expect(bundle.privacyNotice).toContain('removed');
    expect(bundle.events).toContainEqual(
      expect.objectContaining({
        type: 'job.opening',
        level: 'info',
        at: expect.any(Number),
        data: { count: 3, retryable: false, provider: 'openrouter', code: 'UI_CHANGED' },
      }),
    );
    expect(bundle.selectorHealth).toContainEqual({
      page: 'job',
      selector: 'job.applyButton',
      strategy: 'text:apply',
      successes: 1,
      failures: 1,
      lastAt: FIXED_NOW + 1,
    });
  });

  it('reports document presence and counts without IDs or names', async () => {
    await saveSettings(
      makeSettings({
        documents: {
          defaultResumeId: PII.documentId,
          defaultResumeName: PII.document,
          coverLetterId: PII.documentId,
          coverLetterName: PII.document,
          additionalResumes: [
            { id: PII.documentId, name: PII.document },
            { id: 'synthetic-document-id-43', name: PII.filename },
          ],
        },
      }),
    );
    const bundle = await buildDiagnosticsBundle('1.2.3');
    expect(bundle.settings.documents).toEqual({
      defaultResumeSet: true,
      additionalResumes: 2,
      coverLetterSet: true,
      transcriptSet: false,
      otherDocumentSet: false,
      autoSelectResume: makeSettings().documents.autoSelectResume,
    });
    const output = JSON.stringify(bundle);
    for (const sentinel of [
      PII.documentId,
      PII.document,
      PII.filename,
      'synthetic-document-id-43',
    ]) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('handles empty storage and malformed old diagnostic fields safely', async () => {
    const empty = await buildDiagnosticsBundle('1.1.0');
    expect(empty.queueSummary.total).toBe(0);
    expect(empty.events).toEqual([]);
    storage.set(STORAGE_KEYS.engine, {
      status: PII.name,
      mode: PII.email,
      currentPhase: PII.answer,
      consecutiveFailures: PII.phone,
    });
    storage.set(STORAGE_KEYS.onboarding, { step: PII.name, userId: PII.email });
    await appendEvent(makeEvent({ type: PII.name, data: { count: PII.name } }));
    await appendEvent(makeEvent({ data: null as unknown as Record<string, unknown> }, 2));
    const malformed = JSON.stringify(await buildDiagnosticsBundle(PII.name));
    for (const sentinel of Object.values(PII)) expect(malformed).not.toContain(sentinel);
  });
});

describe('credentials never leave through exports', () => {
  it.each([OPENROUTER_KEY, 'synthetic-short-invalid-key'])(
    'removes stored credentials from every export path',
    async (key) => {
      const input = await seedPrivateStorage(key);
      const outputs = [
        JSON.stringify(await buildDiagnosticsBundle('1.1.0')),
        (await exportBackupJson()).text,
        (await exportApplicationsCsv()).text,
        buildBackupJson(input, [key]),
        buildApplicationsCsv({ items: input.tracker, jobs: input.jobs }, [key]),
      ];
      for (const request of [
        { type: 'ui.diagnostics.export', requestId: 'diagnostic-route' },
        { type: 'ui.migration.export', requestId: 'backup-route', format: 'json' },
        { type: 'ui.migration.export', requestId: 'csv-route', format: 'csv' },
      ] as const) {
        const response = await handleUi(request);
        expect(response.ok).toBe(true);
        outputs.push(JSON.stringify(response));
      }
      for (const output of outputs) {
        for (const secret of [key, PII.cookie, PII.auth]) expect(output).not.toContain(secret);
      }
      expect(storage.get(STORAGE_KEYS.aiKeys)).toEqual({ openRouterApiKey: key });
    },
  );

  it('guards pure serializers even without a stored-key argument', async () => {
    const input = await seedPrivateStorage();
    for (const output of [
      buildBackupJson(input),
      buildApplicationsCsv({ items: input.tracker, jobs: input.jobs }),
    ]) {
      for (const secret of [OPENROUTER_KEY, PII.cookie, PII.auth])
        expect(output).not.toContain(secret);
    }
  });

  it('labels backups private and preserves personal data and import compatibility', async () => {
    await seedPrivateStorage();
    const backup = await exportBackupJson();
    for (const value of [PII.name, PII.answer, PII.documentId, PII.employer, PII.title, PII.email])
      expect(backup.text).toContain(value);
    expect(JSON.parse(backup.text).privacyNotice).toContain(
      'Do not attach this file to bug reports',
    );
    const parsed = parseLegacyFile('backup', backup.text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.kind === 'backup') {
      expect(parsed.value.settings?.pacing.sessionBatchSize).toBe(10);
      expect(parsed.value.answers).toHaveLength(1);
      expect(parsed.value.jobs).toHaveLength(1);
      expect(parsed.value.tracker).toHaveLength(1);
    }
  });
});

describe('selector health privacy', () => {
  it('exports the useful action outline while leak-scanning every DOM attribute and private field', async () => {
    document.body.innerHTML = `
      <main data-hook="job-details-page">
        <h1>${PII.title}</h1><p>${PII.employer}</p><p>${PII.description}</p>
        <div role="group" aria-label="${PII.name}" data-hook="${PII.documentId}">
          <button aria-label="Quick apply" data-kind="button" data-variant="primary">${PII.email}</button>
          <button aria-label="Save" data-kind="button" data-variant="secondary">${PII.name}</button>
          <button aria-label="More actions for this job">${PII.phone}</button>
          <button aria-label="${PII.answer}" data-kind="${PII.cookie}" data-variant="${OPENROUTER_KEY}" data-hook="${PII.jobId}">${PII.document}</button>
          <div style="opacity:0"><button aria-label="Quick apply" data-kind="button" data-variant="primary">${PII.filename}</button></div>
          <a href="https://${PII.tenant}/jobs/${PII.jobId}" aria-label="${PII.auth}">${PII.location}</a>
        </div>
      </main>`;
    const outline = describeJobActionArea(document);
    expect(outline).toMatchObject({ rootPresent: true, buttonCount: 5, hiddenButtonCount: 1 });
    expect(outline.entries).toContainEqual(
      expect.objectContaining({
        tag: 'button',
        ariaLabel: 'quick apply',
        visible: true,
        attributes: { 'data-kind': 'button', 'data-variant': 'primary' },
      }),
    );
    await handleContentEvent({
      type: 'content.event.selectorHealth',
      health: {
        at: FIXED_NOW,
        page: 'job',
        selector: 'job.readiness',
        strategy: 'dom:action-area',
        ok: false,
        detail: JSON.stringify(outline),
      },
    });
    const bundle = await buildDiagnosticsBundle('1.1.0');
    const response = await handleUi({ type: 'ui.diagnostics.export', requestId: 'outline-export' });
    expect(bundle.redactionVersion).toBe(4);
    expect(bundle.privacyNotice).toContain('Safety opt-ins are included as booleans');
    expect(bundle.settings.safety.allowOneClickApply).toBe(true);
    expect(bundle.settings.ai.pageAssist).toBe(true);
    expect(bundle.settings.defaultsRevision).toBe(2);
    expect(bundle.privacyNotice).toContain('sanitized action-area structure');
    expect(bundle.selectorHealth).toContainEqual(expect.objectContaining({ actionArea: outline }));
    expect(response.ok).toBe(true);
    const db = await getDb();
    for (const output of [
      JSON.stringify(outline),
      JSON.stringify(bundle),
      JSON.stringify(response),
      JSON.stringify(await db.get(DB_STORES.meta, 'selectorHealth')),
    ]) {
      for (const value of [...Object.values(PII), OPENROUTER_KEY])
        expect(output).not.toContain(value);
      expect(output).not.toContain('https://');
    }
    document.body.innerHTML = '';
  });

  it('reprojects malicious and old outline payloads before storage and export', async () => {
    const malicious = {
      version: 1,
      rootPresent: true,
      elementCount: PII.phone,
      buttonCount: 1,
      hiddenButtonCount: 0,
      pageText: PII.description,
      url: `https://${PII.tenant}/jobs/${PII.jobId}`,
      entries: [
        {
          tag: PII.name,
          role: PII.email,
          ariaLabel: PII.document,
          visible: true,
          disabled: false,
          count: PII.jobId,
          text: OPENROUTER_KEY,
          attributes: {
            'data-kind': PII.cookie,
            'data-variant': PII.auth,
            'data-hook': PII.userId,
            href: PII.tenant,
          },
        },
        {
          tag: 'div',
          ariaLabel: 'quick apply',
          attributes: {},
          visible: true,
          disabled: false,
          count: 1,
        },
      ],
    };
    const entry = {
      at: FIXED_NOW,
      page: 'job',
      selector: 'job.readiness',
      strategy: 'dom:action-area',
      ok: false,
      detail: JSON.stringify(malicious),
    };
    // Old records must be safe without clearing diagnostic history first.
    await setMeta('selectorHealth', [entry]);
    const initialBundle = await buildDiagnosticsBundle('1.1.0');
    expect(initialBundle.selectorHealth[0]?.actionArea?.entries[1]).not.toHaveProperty('ariaLabel');
    await recordSelectorHealthEntries(entry);
    const db = await getDb();
    for (const output of [
      JSON.stringify(initialBundle),
      JSON.stringify(await db.get(DB_STORES.meta, 'selectorHealth')),
    ]) {
      for (const value of [...Object.values(PII), OPENROUTER_KEY])
        expect(output).not.toContain(value);
      expect(output).not.toContain('pageText');
      expect(output).not.toContain('href');
    }
  });

  it('drops arbitrary detail and malformed, oversized, or misplaced outlines', async () => {
    const base = {
      at: FIXED_NOW,
      page: 'job',
      selector: 'job.readiness',
      strategy: 'dom:action-area',
      ok: false,
    };
    for (const entry of [
      { ...base, detail: PII.email },
      { ...base, detail: JSON.stringify({ version: 1, entries: PII.name }) },
      { ...base, detail: PII.answer.repeat(1_000) },
      {
        ...base,
        detail: JSON.stringify({ ...describeJobActionArea(document), entries: Array(65).fill({}) }),
      },
      { ...base, selector: 'job.title', detail: JSON.stringify(describeJobActionArea(document)) },
    ]) {
      const stored = await recordSelectorHealthEntries(entry);
      expect(stored.at(-1)).not.toHaveProperty('detail');
    }
  });

  it('stores only reviewed keys, never page detail, while retaining the history cap', async () => {
    const raw: SelectorHealth = {
      at: FIXED_NOW,
      page: 'job',
      selector: PII.name,
      strategy: PII.employer,
      ok: false,
      detail: PII.email,
    };
    const stored = await recordSelectorHealthEntries(
      Array.from({ length: MAX_SELECTOR_HEALTH_ENTRIES + 5 }, () => raw),
    );
    expect(stored).toHaveLength(MAX_SELECTOR_HEALTH_ENTRIES);
    expect(stored[0]).toEqual({
      at: FIXED_NOW,
      page: 'job',
      selector: '[REDACTED]',
      strategy: '[REDACTED]',
      ok: false,
    });
    const db = await getDb();
    const text = JSON.stringify(await db.get(DB_STORES.meta, 'selectorHealth'));
    for (const value of [PII.name, PII.employer, PII.email]) expect(text).not.toContain(value);
  });

  it('retains every current production strategy key and rejects malformed entries', () => {
    const strategies = [
      ...Object.values(discoverySelectors),
      ...Object.values(jobSelectors),
    ].flat();
    for (const strategy of strategies) {
      const summary = summarizeSelectorHealth([
        { at: FIXED_NOW, page: 'job', selector: 'job.title', strategy: strategy.name, ok: true },
      ]);
      expect(summary[0]?.strategy).toBe(strategy.name);
    }
    expect(summarizeSelectorHealth([{ page: PII.name } as unknown as SelectorHealth])).toEqual([]);
  });
});
