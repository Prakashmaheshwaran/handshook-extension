import { beforeEach, describe, expect, it } from 'vitest';
import { isMockBridgeAllowed, resetMockStore, resolveFallbackMode, sendRequest } from '@/ui/bridge';
import { DEFAULT_SETTINGS } from '@/core/contracts';

describe('bridge mode fallback', () => {
  it('uses live mode only when a runtime answered the probe', () => {
    expect(resolveFallbackMode({ hasRuntime: true, answered: true, allowMock: false })).toBe(
      'live',
    );
    expect(resolveFallbackMode({ hasRuntime: true, answered: true, allowMock: true })).toBe('live');
  });

  it('serves mock data only where mocks are allowed (dev/tests)', () => {
    expect(resolveFallbackMode({ hasRuntime: false, answered: false, allowMock: true })).toBe(
      'mock',
    );
    expect(resolveFallbackMode({ hasRuntime: true, answered: false, allowMock: true })).toBe(
      'mock',
    );
  });

  it('blocks instead of serving fake data in a packaged build', () => {
    expect(resolveFallbackMode({ hasRuntime: false, answered: false, allowMock: false })).toBe(
      'unavailable',
    );
    expect(resolveFallbackMode({ hasRuntime: true, answered: false, allowMock: false })).toBe(
      'unavailable',
    );
  });

  it('allows mock data in the test environment', () => {
    expect(isMockBridgeAllowed()).toBe(true);
  });
});

describe('bridge requests in test/mock mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMockStore();
  });

  it('still serves the seeded engine state and queue', async () => {
    const state = await sendRequest({ type: 'ui.engine.getState' });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.status).toBe('idle');

    const queue = await sendRequest({ type: 'ui.queue.list', limit: 100, offset: 0 });
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.value.items.length).toBeGreaterThan(0);
  });

  it('seeds full automation as the default, including AI page assist', async () => {
    const settings = await sendRequest({ type: 'ui.settings.get' });
    if (!settings.ok) throw new Error(settings.error.message);
    expect(settings.value.mode).toBe('autopilot');
    expect(settings.value.defaultsRevision).toBe(2);
    expect(settings.value.ai).toMatchObject({ enabled: true, pageAssist: true });
    expect(settings.value.safety.reviewBeforeSubmit).toBe(false);
    expect(settings.value.safety.allowOneClickApply).toBe(true);

    const state = await sendRequest({ type: 'ui.engine.getState' });
    if (!state.ok) throw new Error(state.error.message);
    expect(state.value.mode).toBe('autopilot');
  });

  it('seeds named manual document IDs and persists a cleared choice', async () => {
    const settings = await sendRequest({ type: 'ui.settings.get' });
    if (!settings.ok) throw new Error(settings.error.message);
    expect(settings.value.documents).toMatchObject({
      defaultResumeId: 'doc-resume-general',
      defaultResumeName: 'General Resume',
      additionalResumes: [
        { id: 'doc-resume-data', name: 'Data & Analytics Resume' },
        { id: 'doc-resume-product', name: 'Product Resume' },
      ],
    });

    await sendRequest({
      type: 'ui.settings.update',
      patch: { documents: { defaultResumeId: 'doc-resume-product', transcriptId: '' } },
    });
    expect(await sendRequest({ type: 'ui.settings.get' })).toMatchObject({
      ok: true,
      value: {
        documents: { defaultResumeId: 'doc-resume-product', transcriptId: '' },
      },
    });
  });

  it('validates per-job document choices against the configured documents', async () => {
    expect(
      await sendRequest({
        type: 'ui.queue.documents',
        jobId: '8451201',
        documents: { resumeId: 'doc-resume-data' },
      }),
    ).toMatchObject({ ok: true });

    expect(
      await sendRequest({
        type: 'ui.queue.documents',
        jobId: '8451201',
        documents: { resumeId: 'not a document id' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'MISSING_DOCUMENT' } });
  });

  it('supports the full OpenRouter setup with fictional models and never stores the entered key', async () => {
    const key = 'sk-or-v1-test-demo-only';
    expect((await sendRequest({ type: 'ui.ai.setKey', apiKey: key })).ok).toBe(true);
    const status = await sendRequest({ type: 'ui.ai.status' });
    expect(status).toMatchObject({
      ok: true,
      value: { openRouterConfigured: true, openRouterPermission: 'granted' },
    });
    const catalog = await sendRequest({ type: 'ui.ai.openrouter.models' });
    if (!catalog.ok) throw new Error(catalog.error.message);
    expect(catalog.value.models.some((model) => model.isFree)).toBe(true);
    expect(catalog.value.models.some((model) => !model.supportsStructuredOutputs)).toBe(true);
    const selected = catalog.value.models.find((model) => !model.isFree);
    if (!selected) throw new Error('Missing fictional paid model');
    expect(
      (
        await sendRequest({
          type: 'ui.settings.update',
          patch: { ai: { openRouter: { ...DEFAULT_SETTINGS.ai.openRouter, model: selected.id } } },
        })
      ).ok,
    ).toBe(true);
    expect(await sendRequest({ type: 'ui.ai.openrouter.keyInfo' })).toMatchObject({
      ok: true,
      value: { label: 'Demo key', freeDailyRemaining: 42 },
    });
    expect(await sendRequest({ type: 'ui.ai.test', provider: 'openrouter' })).toMatchObject({
      ok: true,
      value: { ok: true, model: selected.id, costUsd: 0.0004 },
    });
    expect(JSON.stringify(window.localStorage)).not.toContain(key);
    expect((await sendRequest({ type: 'ui.ai.clearKey' })).ok).toBe(true);
    expect(await sendRequest({ type: 'ui.ai.openrouter.keyInfo' })).toMatchObject({ ok: false });
    expect(await sendRequest({ type: 'ui.ai.dismissMigrationNotice' })).toMatchObject({
      ok: true,
      value: { dismissed: true },
    });
  });
});
