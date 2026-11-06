import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  redactData,
  redactSecretsData,
  redactSecretsText,
  redactText,
} from '@/core/logging/redact';
import { logEvent, makeEvent } from '@/core/logging/logger';
import { listEvents } from '@/core/logging/eventStore';
import { resetDb } from '@/core/storage/db';
import { makeEvent as eventFactory } from '@/test/factories';

afterEach(() => vi.restoreAllMocks());

describe('text redaction', () => {
  it.each([
    'synthetic.student+jobs@example.test',
    'first_last@sub.example.test',
    '+1 (202) 555-0199',
    '(202) 555-0199',
    '+44 1632 960321',
    '+91-98765-43210',
    '020 7946 0999 ext. 204',
    'identifier12345678901234567890',
    `AIza${'SyntheticPrivacyKey'.repeat(2)}`,
    `sk-proj-${'synthetic'.repeat(4)}`,
    'sk-or-v1-synthetic-test-1234567890',
    'sk-or-short',
    `github_pat_${'synthetic'.repeat(4)}`,
    'Bearer syntheticAuth_123+/==',
    'Basic c3ludGhldGljOnBhc3N3b3Jk',
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj',
    'csrf=synthetic-csrf-value',
    'api_key="synthetic key with spaces"',
    'api-key: synthetic-api-value',
  ])('removes the synthetic sensitive value %s', (sensitive) => {
    const output = redactText(`Before ${sensitive} after`);
    expect(output).not.toContain(sensitive);
    expect(output).toContain('REDACTED');
    expect(output).not.toContain('$1');
  });

  it('removes every cookie in a header and preserves the following line', () => {
    const output = redactText('Cookie: sid=fake-session; custom=fake-cookie\nHTTP status 403');
    expect(output).not.toContain('fake-session');
    expect(output).not.toContain('fake-cookie');
    expect(output).toContain('HTTP status 403');
  });

  it.each([
    '42',
    '12345678',
    '123e4567-e89b-42d3-a456-426614174000',
    'abc123SyntheticOpaqueIdentifier',
    '%31%32%33%34%35%36%37%38',
  ])('removes query, fragment, URL credentials and identifier path %s', (id) => {
    const output = redactText(
      `https://fake-user:fake-password@example.test/jobs/${id}?email=private#auth`,
    );
    expect(output).toBe('https://example.test/jobs/[REDACTED_ID]');
  });

  it('preserves useful numeric counts, status codes and ordinary route names', () => {
    expect(
      redactText('UI_CHANGED after 3 attempts: https://example.test/jobs?search=private'),
    ).toBe('UI_CHANGED after 3 attempts: https://example.test/jobs');
    expect(redactData({ count: 3, status: 'UI_CHANGED', retryable: false })).toEqual({
      count: 3,
      status: 'UI_CHANGED',
      retryable: false,
    });
  });

  it('redacts nested private fields and values used as object keys without mutating the input', () => {
    const input = {
      names: ['Synthetic Person'],
      nested: {
        sessionId: 'fake-session',
        email: 'synthetic@example.test',
        answer: 'Private answer',
      },
      'synthetic@example.test': 'Bearer synthetic-secret',
    };
    const output = JSON.stringify(redactData(input));
    for (const value of [
      'Synthetic Person',
      'fake-session',
      'synthetic@example.test',
      'Private answer',
      'synthetic-secret',
    ]) {
      expect(output).not.toContain(value);
    }
    expect(input.nested.sessionId).toBe('fake-session');
  });

  it('handles cycles without leaking or throwing', () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(JSON.stringify(redactData(input))).toContain('[TRUNCATED]');
  });
});

describe('private-backup credential redaction', () => {
  it('preserves personal data, pacing and search preferences while stripping credentials', () => {
    const input = {
      name: 'Synthetic Person',
      email: 'synthetic@example.test',
      phone: '+44 1632 960321',
      answer: 'Personal answer',
      sessionBatchSize: 10,
      sessionBreakMinMs: 300000,
      search: 'https://example.test/jobs?query=research&access_token=fake-token#fake-fragment',
      session: { custom: 'fake-cookie' },
      apiKey: 'fake-key',
    };
    expect(redactSecretsData(input)).toEqual({
      name: input.name,
      email: input.email,
      phone: input.phone,
      answer: input.answer,
      sessionBatchSize: 10,
      sessionBreakMinMs: 300000,
      search: 'https://example.test/jobs?query=research',
      session: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });

  it('removes the exact stored key even when malformed, quoted or URL encoded', () => {
    const key = 'synthetic-short-key+/=';
    const output = redactSecretsText(`${key} ${encodeURIComponent(key)}`, [key]);
    expect(output).not.toContain(key);
    expect(output).not.toContain(encodeURIComponent(key));
  });

  it('strips authentication query parameters while keeping ordinary search terms', () => {
    expect(
      redactSecretsText(
        'https://example.test/jobs?q=research&key=fake-key&code=fake-code&sid=fake-session',
      ),
    ).toBe('https://example.test/jobs?q=research');
  });
});

describe('logger privacy boundary', () => {
  it('preserves valid local identifiers for Activity joins and filtering', async () => {
    await resetDb();
    const event = makeEvent('info', 'job.applied', 'Applied', { jobId: '123456789' });
    event.id = '12345678-1234-4000-a000-123456789012';
    await logEvent(event);
    expect(event.jobId).toBe('123456789');
    expect(await listEvents()).toMatchObject([{ id: event.id, jobId: '123456789' }]);
  });

  it('redacts event strings and structured private data at creation', () => {
    const event = makeEvent('info', 'job.synthetic@example.test', 'Contact +44 1632 960321', {
      jobId: 'synthetic@example.test',
      data: { apiKey: 'fake-key', answer: 'Private answer' },
    });
    const text = JSON.stringify(event);
    for (const value of [
      'synthetic@example.test',
      '+44 1632 960321',
      'fake-key',
      'Private answer',
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it('redacts directly supplied events before persistence', async () => {
    await resetDb();
    const raw = {
      ...eventFactory({
        message: 'Cookie: custom=fake-cookie',
        data: { password: 'fake-password' },
      }),
      extra: 'fake-extra',
    };
    await logEvent(raw);
    const text = JSON.stringify(await listEvents());
    for (const value of ['fake-cookie', 'fake-password', 'fake-extra'])
      expect(text).not.toContain(value);
    expect(raw.message).toContain('fake-cookie');
  });
});
