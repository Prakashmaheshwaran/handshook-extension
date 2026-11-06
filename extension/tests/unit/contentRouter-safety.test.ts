import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyOptions, ApplyResult, ContentRequest, Job } from '@/core/contracts';
import { PROTOCOL_VERSION } from '@/core/contracts';
import { PAGE_ASSIST_ATTRIBUTES, type PageAssistCandidate } from '@/core/contracts/pageAssist';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { CancelledError } from '@/handshake/dom';
import { resetSelectorHealth } from '@/handshake/health';

const mocks = vi.hoisted(() => ({
  handler: undefined as
    | ((
        request: ContentRequest,
      ) => Promise<{ requestId: string; ok: boolean; data?: unknown; error?: unknown }>)
    | undefined,
  applyToJob: vi.fn(),
}));

vi.mock('@/content/bridge', () => ({
  registerContentCommand: vi.fn(),
  registerContentBridge: (handler: typeof mocks.handler) => {
    mocks.handler = handler;
  },
  responseOk: (requestId: string, data: unknown) => ({ requestId, ok: true, data }),
  sendContentEvent: vi.fn(async () => undefined),
}));

vi.mock('@/content/lifecycle', () => ({ watchRoute: vi.fn() }));

vi.mock('@/handshake/applyFlow', () => ({ applyToJob: mocks.applyToJob }));

import {
  detectSessionStatus,
  isJobPath,
  registerContentRouter,
  SESSION_SETTLE_MS,
} from '@/content/router';
import { sendContentEvent } from '@/content/bridge';

const job: Job = {
  id: '900001',
  host: 'app.joinhandshake.com',
  title: 'Engineer',
  employer: 'Acme',
  url: 'https://app.joinhandshake.com/jobs/900001',
  description: '',
  applyType: 'quick_apply',
  requiredDocumentTypes: [],
  source: 'search',
  discoveredAt: 1,
};

const options: ApplyOptions = {
  mode: 'autopilot',
  documents: {},
  answers: [],
  allowSensitiveAutoSubmit: false,
  allowEeoAutoFill: false,
  allowFreeTextAutoFill: false,
  reviewBeforeSubmit: false,
  stopOnUnknownQuestion: true,
  verifySubmissions: true,
  timeoutMs: 1_000,
};

function applyRequest(requestId: string): ContentRequest {
  return { type: 'content.apply', requestId, job, options };
}

const applied: ApplyResult = { jobId: job.id, outcome: 'applied', submittedAt: 1 };

beforeEach(() => {
  vi.stubGlobal('location', new URL(job.url));
  mocks.applyToJob.mockReset();
  mocks.applyToJob.mockResolvedValue(applied);
  resetSelectorHealth();
  registerContentRouter();
  document.body.innerHTML = '';
});
afterEach(() => vi.unstubAllGlobals());

describe('review watcher job identity — M6', () => {
  it('matches exact path segments so job 1234 never matches /jobs/12345', () => {
    expect(isJobPath('/jobs/1234', '1234')).toBe(true);
    expect(isJobPath('/jobs/12345', '1234')).toBe(false);
    expect(isJobPath('/stu/jobs/1234/apply', '1234')).toBe(false);
    expect(isJobPath('/job-search/12345', '1234')).toBe(false);
    expect(isJobPath('/job-search/1234', '1234')).toBe(false);
  });
});

describe('content.apply idempotency — H2', () => {
  it('refuses to apply on a different job page or host', async () => {
    for (const url of [job.url + '1', 'https://school.joinhandshake.com/jobs/900001']) {
      vi.stubGlobal('location', new URL(url));
      expect(await mocks.handler!(applyRequest(`wrong-page-${url}`))).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
    }
    expect(mocks.applyToJob).not.toHaveBeenCalled();
  });

  it('refuses to verify another job even when its page has positive confirmation', async () => {
    vi.stubGlobal('location', new URL(job.url + '1'));
    document.body.innerHTML = '<p role="status">Application submitted</p>';
    expect(
      await mocks.handler!({
        type: 'content.verifySubmission',
        requestId: 'wrong-verify',
        jobId: job.id,
        attemptId: 'old-attempt',
        timeoutMs: 1000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });
  it('returns the first result when the background repeats a requestId', async () => {
    const request = applyRequest('apply-dedupe');

    const first = await mocks.handler!(request);
    const second = await mocks.handler!(request);

    expect(mocks.applyToJob).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('awaits the same in-flight apply for concurrent duplicates', async () => {
    let resolveApply: ((result: ApplyResult) => void) | undefined;
    mocks.applyToJob.mockImplementationOnce(
      () => new Promise<ApplyResult>((resolve) => (resolveApply = resolve)),
    );
    const request = applyRequest('apply-concurrent');

    const first = mocks.handler!(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = mocks.handler!(request);
    resolveApply?.(applied);

    const [left, right] = await Promise.all([first, second]);
    expect(mocks.applyToJob).toHaveBeenCalledTimes(1);
    expect(right).toEqual(left);
  });
});

describe('content.apply page assist binding', () => {
  it('binds page assist to the exact job and apply request', async () => {
    const sendMessage = vi.fn(async (message: Record<string, unknown>) => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: true,
      data: { index: 0, source: 'ai', confidence: 0.8 },
    }));
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    let captured: ApplyControl | undefined;
    mocks.applyToJob.mockImplementationOnce(
      async (
        _doc: Document,
        _job: Job,
        _options: ApplyOptions,
        _signal: AbortSignal | undefined,
        control: ApplyControl,
      ) => {
        captured = control;
        return applied;
      },
    );

    const response = await mocks.handler!(applyRequest('assist-attempt'));
    expect(response).toMatchObject({ ok: true });

    const candidate: PageAssistCandidate = {
      index: 0,
      tag: 'button',
      role: 'button',
      name: 'Apply',
      attributes: Object.fromEntries(
        PAGE_ASSIST_ATTRIBUTES.map((name) => [name, '']),
      ) as PageAssistCandidate['attributes'],
      inDialog: false,
      disabled: false,
    };
    const answer = await captured?.pageAssist?.({
      target: 'applyButton',
      scope: 'job',
      candidates: [candidate],
    });

    expect(answer).toEqual({ index: 0, source: 'ai', confidence: 0.8 });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'engine.pageAssist',
        jobId: job.id,
        applyRequestId: 'assist-attempt',
        target: 'applyButton',
        scope: 'job',
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
  });
});

describe('content.inspectJob readiness', () => {
  it('records the safe action outline when a ready page still has unreadable job details', async () => {
    document.body.innerHTML =
      '<main data-hook="job-details-page"><button aria-label="Quick apply">Quick apply</button></main>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    vi.mocked(sendContentEvent).mockClear();
    expect(
      await mocks.handler!({
        type: 'content.inspectJob',
        requestId: 'inspect-missing-title',
        jobId: job.id,
      }),
    ).toMatchObject({ ok: false, error: { code: 'UI_CHANGED' } });
    expect(sendContentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'content.event.selectorHealth',
        health: expect.arrayContaining([
          expect.objectContaining({
            selector: 'job.readiness',
            strategy: 'dom:action-area',
            ok: false,
            detail: expect.stringContaining('quick apply'),
          }),
        ]),
      }),
    );
  });

  it('waits for late job actions before reading details or enriching them', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<main data-hook="job-details-page"><h1>Loading</h1></main>';
      const fetcher = vi.fn(async () => new Response('', { status: 403 }));
      vi.stubGlobal('fetch', fetcher);
      let settled = false;
      const pending = mocks.handler!({
        type: 'content.inspectJob',
        requestId: 'inspect-late',
        jobId: job.id,
      }).then((response) => {
        settled = true;
        return response;
      });
      setTimeout(() => {
        document.querySelector('main')?.replaceChildren();
        const heading = document.createElement('h1');
        heading.textContent = 'Synthetic rendered role';
        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Quick apply');
        document.querySelector('main')?.append(heading, button);
      }, 2_000);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({
        ok: true,
        data: { title: 'Synthetic rendered role', applyType: 'quick_apply' },
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports UI_CHANGED and selector evidence after the bounded wait without reading a partial page', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML =
        '<main data-hook="job-details-page"><h1>Loading</h1><button aria-label="Save">Save</button></main>';
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      vi.mocked(sendContentEvent).mockClear();
      let settled = false;
      const pending = mocks.handler!({
        type: 'content.inspectJob',
        requestId: 'inspect-timeout',
        jobId: job.id,
      }).then((response) => {
        settled = true;
        return response;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: false, error: { code: 'UI_CHANGED' } });
      expect(fetcher).not.toHaveBeenCalled();
      expect(sendContentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'content.event.selectorHealth',
          health: [
            expect.objectContaining({
              selector: 'job.readiness',
              ok: false,
              detail: expect.stringContaining('ariaLabel'),
            }),
          ],
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels inspection during readiness through the existing cancel command', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const pending = mocks.handler!({
        type: 'content.inspectJob',
        requestId: 'inspect-cancel',
        jobId: job.id,
      });
      await vi.advanceTimersByTimeAsync(500);
      await mocks.handler!({ type: 'content.cancel', requestId: 'cancel-inspect', jobId: job.id });
      expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects navigation to another job while readiness is pending', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const pending = mocks.handler!({
        type: 'content.inspectJob',
        requestId: 'inspect-navigation',
        jobId: job.id,
      });
      vi.stubGlobal('location', new URL(job.url + '1'));
      document.body.innerHTML =
        '<main data-hook="job-details-page"><h1>Other role</h1><button>Apply</button></main>';
      expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('manual confirmation delivery', () => {
  it('keeps the last-moment submission baseline for late-result observation', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendContentEvent).mockResolvedValue(true);
      mocks.applyToJob.mockImplementationOnce(
        async (
          _doc: Document,
          _job: Job,
          _options: ApplyOptions,
          _signal: AbortSignal | undefined,
          control: ApplyControl,
        ) => {
          document.body.innerHTML = '<div role="alert">Application submitted</div>';
          control.beforeSubmit?.(['application submitted']);
          return {
            jobId: job.id,
            outcome: 'verifying',
            documentsUsed: 'handshake_profile_defaults',
          };
        },
      );
      await mocks.handler!(applyRequest('pre-submit-baseline'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        vi
          .mocked(sendContentEvent)
          .mock.calls.filter(([event]) => event.type === 'content.event.result'),
      ).toHaveLength(0);
      document.body.innerHTML =
        '<div class="rosetta-banner" role="alert"><h2>Applied on October 27, 2026</h2><button>Withdraw application</button></div>';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendContentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'content.event.result',
          result: expect.objectContaining({
            outcome: 'applied',
            confirmationText: expect.stringMatching(/^applied on /),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ready_for_review', 'needs_input', 'verifying'] as const)(
    'observes an early manual confirmation for %s and retries until acknowledged',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        vi.mocked(sendContentEvent).mockImplementation(async (event) => {
          if (event.type !== 'content.event.result') return true;
          attempts += 1;
          return attempts > 1;
        });
        mocks.applyToJob.mockImplementationOnce(async () => {
          document.body.innerHTML = '<p role="status">Application submitted</p>';
          return { jobId: job.id, outcome };
        });
        await mocks.handler!(applyRequest(`manual-observe-${outcome}`));
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts).toBe(1);
        document.body.innerHTML = '';
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(5000);
        expect(attempts).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('content.cancel — H1', () => {
  it('aborts the in-flight apply and reports CANCELLED', async () => {
    mocks.applyToJob.mockImplementationOnce(
      (_doc: Document, _job: Job, _options: ApplyOptions, signal?: AbortSignal) =>
        new Promise<ApplyResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new CancelledError()));
        }),
    );

    const pending = mocks.handler!(applyRequest('apply-cancel'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mocks.handler!({
      type: 'content.cancel',
      requestId: 'cancel-1',
      jobId: job.id,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
  });
});

describe('content.detectSession', () => {
  const detect = (): ContentRequest => ({ type: 'content.detectSession', requestId: 'session' });

  it('waits for a redirecting page to render the signed-in app', async () => {
    document.body.innerHTML = '<main data-testid="redirect-page">Redirecting…</main>';
    const pending = mocks.handler!(detect());
    setTimeout(() => {
      document.body.innerHTML = '<a href="/profile">Profile</a>';
    }, 50);
    await expect(pending).resolves.toMatchObject({ ok: true, data: { status: 'logged_in' } });
  });

  it('answers a logged-out page at once', async () => {
    vi.stubGlobal('location', new URL('https://app.joinhandshake.com/login'));
    await expect(mocks.handler!(detect())).resolves.toMatchObject({
      data: { status: 'logged_out' },
    });
  });

  it('reports unknown once the page never shows session evidence', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<p>Something else</p>';
      const pending = mocks.handler!(detect());
      await vi.advanceTimersByTimeAsync(SESSION_SETTLE_MS + 100);
      await expect(pending).resolves.toMatchObject({ ok: true, data: { status: 'unknown' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads account chrome and dashboard links as signed in', () => {
    document.body.innerHTML =
      '<header><a href="/dashboard">Dashboard</a><button data-testid="avatar-menu">PM</button></header>';
    expect(detectSessionStatus(document)).toBe('logged_in');
  });

  it('reads a current /stu/ navigation link as signed in', () => {
    document.body.innerHTML = '<nav><a href="/stu/dashboard">Home</a></nav>';
    expect(detectSessionStatus(document)).toBe('logged_in');
  });

  it('reports a sign-in redirect as signed out', () => {
    vi.stubGlobal('location', new URL('https://app.joinhandshake.com/login'));
    document.body.innerHTML = '<form>Sign in to Handshake</form>';
    expect(detectSessionStatus(document)).toBe('logged_out');
  });

  it('keeps an unrecognized page unknown instead of guessing signed in', () => {
    document.body.innerHTML = '<main>Loading</main>';
    expect(detectSessionStatus(document)).toBe('unknown');
  });

  it('does not call a page signed in while its document is still loading', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
    try {
      document.body.innerHTML = '<a href="/profile">Profile</a>';
      const pending = mocks.handler!(detect());
      await vi.advanceTimersByTimeAsync(SESSION_SETTLE_MS + 100);
      await expect(pending).resolves.toMatchObject({ ok: true, data: { status: 'unknown' } });
    } finally {
      delete (document as unknown as Record<string, unknown>).readyState;
      vi.useRealTimers();
    }
  });
});
