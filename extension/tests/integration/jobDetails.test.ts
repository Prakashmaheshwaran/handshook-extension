import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ErrorCode } from '@/core/contracts';
import {
  classifyApplyType,
  detectJobPageState,
  extractJobFromDom,
  fetchJobDetails,
  inspectJob,
  JobInspectionError,
  mapApplyTypeSetting,
  mapDocumentTypeId,
  mapDocumentTypes,
} from '@/handshake/jobDetails';
import { resetSelectorHealth } from '@/handshake/health';

const HOST = 'app.joinhandshake.com';
const JOB_ID = '1001';

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/synthetic/job', name), 'utf8');
}

function load(name: string): void {
  document.body.innerHTML = fixture(name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

describe('DOM extraction', () => {
  it('reads every supported field from a Quick Apply page', () => {
    load('quick-apply.html');
    const job = extractJobFromDom(document, HOST, JOB_ID);

    expect(job).toMatchObject({
      id: JOB_ID,
      host: HOST,
      title: 'Software Engineer Intern',
      employer: 'Acme Robotics',
      url: 'https://app.joinhandshake.com/jobs/1001',
      description: 'Build reliable tools. Work with a small team.',
      location: 'Remote',
      employmentType: 'Internship',
      salary: '$30 / hour',
      applyType: 'quick_apply',
      requiredDocumentTypes: [],
      source: 'search',
    });
  });

  it('falls back to a company link and article text for a form page', () => {
    load('handshake-form.html');
    const job = extractJobFromDom(document, HOST, '2001');

    expect(job.title).toBe('Backend Engineer');
    expect(job.employer).toBe('Epsilon Systems');
    expect(job.location).toBe('Austin, TX');
    expect(job.employmentType).toBe('Full-time');
    expect(job.description).toContain('Design APIs');
    expect(job.applyType).toBe('handshake_form');
  });

  it('classifies an offsite Apply Externally link', () => {
    load('external.html');
    const job = extractJobFromDom(document, HOST, '3001');
    expect(job.employer).toBe('Zeta Studio');
    expect(job.applyType).toBe('external');
  });

  it('returns unknown rather than guessing when no action is present', () => {
    document.body.innerHTML = '<main><h1>Engineer</h1><p>Description</p></main>';
    expect(classifyApplyType(document)).toBe('unknown');
    expect(extractJobFromDom(document, HOST, '4001').applyType).toBe('unknown');
  });
});

describe('apply-type mapping', () => {
  it('maps API settings onto the contract enum', () => {
    expect(mapApplyTypeSetting('handshake')).toBe('handshake_form');
    expect(mapApplyTypeSetting('quick_apply')).toBe('quick_apply');
    expect(mapApplyTypeSetting('external')).toBe('external');
    expect(mapApplyTypeSetting('something_new')).toBe('unknown');
    expect(mapApplyTypeSetting(null)).toBe('unknown');
  });
});

describe('document type mapping', () => {
  it('maps the numeric IDs used by the API', () => {
    expect(mapDocumentTypeId(1)).toBe('resume');
    expect(mapDocumentTypeId(2)).toBe('cover_letter');
    expect(mapDocumentTypeId(3)).toBe('transcript');
    expect(mapDocumentTypeId(5)).toBe('other');
    expect(mapDocumentTypeId(9)).toBeNull();
  });

  it('keeps known types, deduplicates, and skips unsupported ones', () => {
    expect(
      mapDocumentTypes([
        1,
        '2',
        { document_type_id: 3 },
        { documentTypeId: '5' },
        9,
        'resume',
        'unknown-type',
      ]),
    ).toEqual(['resume', 'cover_letter', 'transcript', 'other']);
    expect(mapDocumentTypes(undefined)).toEqual([]);
    expect(mapDocumentTypes(['mystery'])).toEqual([]);
  });
});

describe('job API', () => {
  it('parses a wrapped 200 response and maps every supported field', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        job: {
          title: 'API Title',
          employer: { name: 'API Employer' },
          description: '<p>API <strong>description</strong></p>',
          location: { city: 'Seattle', region: 'WA' },
          employment_type: 'Internship',
          salary: '$40 / hour',
          job_apply_setting: { apply_type: 'handshake' },
          required_job_document_types: [
            { document_type_id: 1 },
            { document_type_id: 2 },
            { document_type_id: 3 },
            { document_type_id: 5 },
            { document_type_id: 9 },
          ],
          apply_start: '2026-11-01T12:00:00Z',
          posted_at: '2026-09-15',
        },
      }),
    );

    const details = await fetchJobDetails(JOB_ID, HOST, impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://app.joinhandshake.com/stu/jobs/1001');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init).toMatchObject({
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
    });
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    });
    expect(details).toMatchObject({
      title: 'API Title',
      employer: 'API Employer',
      description: 'API description',
      location: 'Seattle, WA',
      employmentType: 'Internship',
      salary: '$40 / hour',
      applyType: 'handshake_form',
      applyStartAt: '2026-11-01T12:00:00.000Z',
      postedAt: '2026-09-15T00:00:00.000Z',
      requiredDocumentTypes: ['resume', 'cover_letter', 'transcript', 'other'],
    });
  });

  it('accepts an unwrapped payload and epoch-second apply_start', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse({
        title: 'Plain Title',
        description: 'Plain description',
        apply_type: 'external',
        apply_start: 1_800_000_000,
      }),
    );
    const details = await fetchJobDetails(JOB_ID, HOST, impl);
    expect(details?.title).toBe('Plain Title');
    expect(details?.applyType).toBe('external');
    expect(details?.applyStartAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('stops on 403 and returns null so callers use DOM data', async () => {
    const { impl, calls } = mockFetch(() => new Response('forbidden', { status: 403 }));
    await expect(fetchJobDetails(JOB_ID, HOST, impl)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('tries the /jobs endpoint after a 422 and returns null if both fail', async () => {
    const { impl, calls } = mockFetch(() => new Response('unprocessable', { status: 422 }));
    await expect(fetchJobDetails(JOB_ID, HOST, impl)).resolves.toBeNull();
    expect(calls.map((call) => call.url)).toEqual([
      'https://app.joinhandshake.com/stu/jobs/1001',
      'https://app.joinhandshake.com/jobs/1001',
    ]);
  });

  it('falls back to /jobs when /stu/jobs returns 422', async () => {
    const { impl, calls } = mockFetch((url) =>
      url.includes('/stu/jobs/')
        ? new Response('unprocessable', { status: 422 })
        : jsonResponse({ title: 'Fallback Title', description: 'Fallback description' }),
    );
    const details = await fetchJobDetails(JOB_ID, HOST, impl);
    expect(details?.title).toBe('Fallback Title');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://app.joinhandshake.com/jobs/1001');
  });

  it('survives a network error on the first endpoint', async () => {
    const { impl, calls } = mockFetch((url) => {
      if (url.includes('/stu/jobs/')) throw new Error('network down');
      return jsonResponse({ title: 'Retried Title', description: 'Retried description' });
    });
    const details = await fetchJobDetails(JOB_ID, HOST, impl);
    expect(details?.title).toBe('Retried Title');
    expect(calls).toHaveLength(2);
  });

  it('rejects malformed IDs and hosts without making a request', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({}));
    await expect(fetchJobDetails('abc', HOST, impl)).resolves.toBeNull();
    await expect(fetchJobDetails(JOB_ID, 'evil.com', impl)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('inspectJob', () => {
  it('keeps visible external detection when the API still reports an internal form', async () => {
    load('external.html');
    const { impl } = mockFetch(() =>
      jsonResponse({
        job: { title: 'External role', job_apply_setting: { apply_type: 'handshake' } },
      }),
    );
    const job = await inspectJob(document, HOST, JOB_ID, impl);
    expect(job.applyType).toBe('external');
    expect(job.externalUrl).toMatch(/^https:\/\//);
    expect(job.url).toBe(`https://${HOST}/jobs/${JOB_ID}`);
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [401, 'AUTH_REQUIRED'],
  ] as const)(
    'stops immediately on HTTP %s instead of applying with DOM-only details',
    async (status, code) => {
      load('quick-apply.html');
      const { impl, calls } = mockFetch(() => new Response('', { status }));
      await expect(inspectJob(document, HOST, JOB_ID, impl)).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    },
  );
  it('merges DOM identity with API apply settings and documents', async () => {
    load('quick-apply.html');
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        job: {
          title: 'API Title Should Not Win',
          employer: { name: 'API Employer Should Not Win' },
          description: '<p>API supplied description.</p>',
          job_apply_setting: { apply_type: 'handshake' },
          required_job_document_types: [{ document_type_id: 1 }, { document_type_id: 2 }],
          apply_start: '2026-12-01T09:00:00Z',
        },
      }),
    );

    const job = await inspectJob(document, HOST, JOB_ID, impl);

    expect(job).toMatchObject({
      id: JOB_ID,
      title: 'Software Engineer Intern',
      employer: 'Acme Robotics',
      description: 'API supplied description.',
      location: 'Remote',
      employmentType: 'Internship',
      salary: '$30 / hour',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'cover_letter'],
      applyStartAt: '2026-12-01T09:00:00.000Z',
      source: 'search',
    });
    expect(calls.every((call) => call.init?.method === 'GET')).toBe(true);
  });

  it('continues with DOM data when the API is forbidden', async () => {
    load('quick-apply.html');
    const { impl } = mockFetch(() => new Response('forbidden', { status: 403 }));
    const job = await inspectJob(document, HOST, JOB_ID, impl);
    expect(job.description).toBe('Build reliable tools. Work with a small team.');
    expect(job.applyType).toBe('quick_apply');
    expect(job.requiredDocumentTypes).toEqual([]);
  });

  const blocked: ReadonlyArray<readonly [string, ErrorCode]> = [
    ['applied.html', 'ALREADY_APPLIED'],
    ['closed.html', 'JOB_CLOSED'],
    ['not-open.html', 'NOT_OPEN'],
    ['login.html', 'AUTH_REQUIRED'],
    ['challenge.html', 'CHALLENGE'],
  ];

  for (const [file, code] of blocked) {
    it(`raises ${code} for ${file}`, async () => {
      load(file);
      const { impl, calls } = mockFetch(() => {
        throw new Error('API must not be called for a blocked page');
      });

      const error = await inspectJob(document, HOST, JOB_ID, impl).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(JobInspectionError);
      expect(error).toMatchObject({ code });
      expect((error as JobInspectionError).appError.code).toBe(code);
      expect(calls).toHaveLength(0);
    });
  }

  it('returns a title-only job when the description cannot be read', async () => {
    load('incomplete.html');
    document.querySelector('main')?.setAttribute('data-hook', 'job-details-page');
    document.querySelector('main')?.appendChild(document.createElement('button')).append('Apply');
    const { impl } = mockFetch(() => new Response('forbidden', { status: 403 }));
    const job = await inspectJob(document, HOST, JOB_ID, impl);
    expect(job.title).toBe('Unfinished Page');
    expect(job.description).toBe('');
  });

  it('rejects an invalid host or job ID before touching the page', async () => {
    load('quick-apply.html');
    await expect(inspectJob(document, 'evil.com', JOB_ID)).rejects.toThrow(TypeError);
    await expect(inspectJob(document, HOST, 'nope')).rejects.toThrow(TypeError);
  });
});

describe('page-state detection', () => {
  it('distinguishes challenge, login, applied, closed, and not-open pages', () => {
    load('challenge.html');
    expect(detectJobPageState(document)).toBe('challenge');
    load('login.html');
    expect(detectJobPageState(document)).toBe('login');
    load('applied.html');
    expect(detectJobPageState(document)).toBe('applied');
    load('closed.html');
    expect(detectJobPageState(document)).toBe('closed');
    load('not-open.html');
    expect(detectJobPageState(document)).toBe('not_open');
    load('quick-apply.html');
    expect(detectJobPageState(document)).toBeNull();
  });

  it('does not treat job-description prose as a final page state (H5)', () => {
    document.body.innerHTML = `
      <main data-testid="job-detail">
        <h1>Backend Engineer</h1>
        <section aria-label="Job description">
          <p>You applied on our platform before; this position is closed to new applicants.</p>
          <p>Applications are not open on weekends.</p>
        </section>
        <button type="button">Apply</button>
      </main>`;
    expect(detectJobPageState(document)).toBeNull();
  });

  it('still detects final state inside a status region', () => {
    document.body.innerHTML = `
      <main data-testid="job-detail">
        <h1>Backend Engineer</h1>
        <div data-testid="job-status">
          <p role="status">You applied on January 12, 2026</p>
        </div>
      </main>`;
    expect(detectJobPageState(document)).toBe('applied');
  });
});
