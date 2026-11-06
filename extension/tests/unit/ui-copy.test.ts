import { describe, expect, it } from 'vitest';
import type { AppError, EngineState, ErrorCode } from '@/core/contracts';
import {
  ERROR_CODE_COPY,
  describeEngineAction,
  describeError,
  friendlyErrorMessage,
  isHandshakeHost,
  isHandshakeJobSearchUrl,
  queuePrimaryAction,
} from '@/ui/components/ui-copy';
import { handshakeLinks } from '@/ui/components/links';

const ALL_CODES: ErrorCode[] = [
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'FORBIDDEN',
  'CHALLENGE',
  'CAP_REACHED',
  'EXTERNAL_APPLY',
  'MISSING_DOCUMENT',
  'UNKNOWN_QUESTION',
  'UI_CHANGED',
  'NETWORK',
  'TIMEOUT',
  'ALREADY_APPLIED',
  'JOB_CLOSED',
  'NOT_OPEN',
  'CANCELLED',
  'STORAGE_MIGRATION_FAILED',
  'PROTOCOL_MISMATCH',
  'UNSUPPORTED_MESSAGE',
  'INVALID_INPUT',
  'UNKNOWN',
];

function error(code: ErrorCode, message: string): AppError {
  return { code, message, retryable: false };
}

function engine(patch: Partial<EngineState>): EngineState {
  return {
    version: 1,
    status: 'idle',
    mode: 'review',
    host: 'app.joinhandshake.com',
    todayCount: 0,
    dailyCap: 50,
    consecutiveFailures: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe('error copy', () => {
  it('maps every error code to plain-language copy', () => {
    for (const code of ALL_CODES) {
      expect(ERROR_CODE_COPY[code]).toBeTruthy();
      expect(ERROR_CODE_COPY[code]).not.toBe(code);
    }
  });

  it('uses mapped copy as the primary message and keeps the raw message for Advanced', () => {
    const description = describeError(error('UI_CHANGED', 'Selector apply.submit missing'));
    expect(description.message).toContain('page changed');
    expect(description.code).toBe('UI_CHANGED');
    expect(description.originalMessage).toBe('Selector apply.submit missing');
  });

  it('does not repeat the message when it equals the mapped copy', () => {
    const description = describeError(error('JOB_CLOSED', ERROR_CODE_COPY.JOB_CLOSED));
    expect(description.originalMessage).toBeUndefined();
  });

  it('preserves actionable runner protection and uncertain-submission guidance', () => {
    expect(
      friendlyErrorMessage(
        error(
          'UNKNOWN',
          'Stop the run and finish any pending review before refreshing the runner.',
        ),
      ),
    ).toContain('finish or skip the pending application in Needs you');
    for (const [code, message] of [
      ['UNKNOWN', 'A previous submission could not be verified. Check My Jobs.'],
      ['INVALID_INPUT', 'A previous submission needs verification before this job can run again.'],
      ['INVALID_INPUT', 'The previous attempt is not a settled non-submission.'],
      [
        'UNKNOWN',
        'The application response was lost. Check the job page or My Jobs before retrying.',
      ],
      [
        'TIMEOUT',
        'The application reply could not be validated. Check this job or My Jobs before retrying.',
      ],
    ] as const) {
      expect(friendlyErrorMessage(error(code, message))).toContain('Check My Jobs');
    }
  });

  it.each(['INTERNAL_CODE apply.submit selector', 'constructor', 'toString'])(
    'keeps unreviewed message %s out of primary recovery copy',
    (raw) => {
      const message = friendlyErrorMessage(error('UNKNOWN', raw));
      expect(message).toBe(ERROR_CODE_COPY.UNKNOWN);
      expect(message).not.toContain('INTERNAL_CODE');
    },
  );
});

describe('queue primary action', () => {
  it('never requeues a filled application', () => {
    expect(queuePrimaryAction('ready_for_review')).toBe('review');
    expect(queuePrimaryAction('verifying')).toBe('review');
  });

  it('routes needs_input to Needs you and finished jobs to no action', () => {
    expect(queuePrimaryAction('needs_input')).toBe('answer');
    for (const status of [
      'applied',
      'external',
      'already_applied',
      'skipped',
      'filtered',
    ] as const) {
      expect(queuePrimaryAction(status)).toBe('none');
    }
  });

  it('offers an apply action for retryable and active work', () => {
    expect(queuePrimaryAction('failed')).toBe('apply');
    expect(queuePrimaryAction('queued')).toBe('apply');
  });

  it('never offers an action on a final row', () => {
    // H4: blocked is final like applied; retrying it could re-submit.
    expect(queuePrimaryAction('blocked')).toBe('none');
  });
});

describe('engine action notices', () => {
  it('reports a start that stayed idle because the daily cap is used', () => {
    const notice = describeEngineAction(
      engine({
        status: 'idle',
        message: 'Daily cap reached (50/50). Start again after local midnight.',
      }),
      'start',
    );
    expect(notice.level).toBe('warn');
    expect(notice.message).toContain('Run not started');
    expect(notice.message).toContain('Daily cap reached');
  });

  it('reports a start that came back paused for active hours', () => {
    const notice = describeEngineAction(
      engine({
        status: 'paused',
        pauseReason: 'active_hours',
        message: 'Outside active hours (09:00–17:00).',
      }),
      'start',
    );
    expect(notice.level).toBe('warn');
    expect(notice.message).toContain('Outside active hours');
  });

  it('reports needs_user instead of success', () => {
    const notice = describeEngineAction(
      engine({ status: 'needs_user', message: 'A previous application needs review.' }),
      'resume',
    );
    expect(notice.level).toBe('warn');
    expect(notice.message).toContain('needs review');
  });

  it('reports success only for a running engine', () => {
    expect(describeEngineAction(engine({ status: 'running' }), 'start')).toEqual({
      level: 'success',
      message: 'Run started.',
    });
    expect(describeEngineAction(engine({ status: 'scanning' }), 'resume')).toEqual({
      level: 'success',
      message: 'Run resumed.',
    });
  });
});

describe('Handshake URL validation', () => {
  it('accepts job-search pages on Handshake hosts', () => {
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.com/job-search?query=data')).toBe(
      true,
    );
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.com/jobs?query=data')).toBe(true);
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.co.uk/postings')).toBe(true);
    expect(isHandshakeJobSearchUrl('https://school.joinhandshake.com/jobs/search')).toBe(true);
  });

  it('rejects individual jobs, non-search pages, and non-Handshake hosts', () => {
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.com/jobs/8451201')).toBe(false);
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.com/documents')).toBe(false);
    expect(isHandshakeJobSearchUrl('https://app.joinhandshake.com/')).toBe(false);
    expect(isHandshakeJobSearchUrl('http://app.joinhandshake.com/jobs')).toBe(false);
    expect(isHandshakeJobSearchUrl('https://joinhandshake.com.evil.com/jobs')).toBe(false);
  });
});

describe('host-aware links', () => {
  it('builds links from the configured Handshake host', () => {
    const links = handshakeLinks('app.joinhandshake.co.uk');
    expect(links.origin).toBe('https://app.joinhandshake.co.uk');
    expect(links.home).toBe('https://app.joinhandshake.co.uk/');
    expect(links.jobs).toBe('https://app.joinhandshake.co.uk/jobs');
    expect(links.documents).toBe('https://app.joinhandshake.co.uk/stu/documents');
  });

  it('falls back to the US app for empty or non-Handshake hosts', () => {
    expect(handshakeLinks(undefined).origin).toBe('https://app.joinhandshake.com');
    expect(handshakeLinks('').origin).toBe('https://app.joinhandshake.com');
    expect(handshakeLinks('evil.example.com').origin).toBe('https://app.joinhandshake.com');
    expect(isHandshakeHost('notjoinhandshake.com')).toBe(false);
  });
});
