import { describe, expect, it } from 'vitest';
import {
  browserLabel,
  buildIssueReportUrl,
  modeOption,
  osLabel,
  reviewedErrorCodes,
} from '@/core/diagnostics/issueReport';

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function params(url: string): URLSearchParams {
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(
    'https://github.com/Prakashmaheshwaran/handshook-extension/issues/new',
  );
  return parsed.searchParams;
}

describe('issue report link', () => {
  it('prefills the bug template with version, browser, OS, mode, and error codes', () => {
    const query = params(
      buildIssueReportUrl({
        version: '1.1.4',
        mode: 'autopilot',
        reviewBeforeSubmit: false,
        errorCodes: ['engine.ui_changed', 'engine.ui_changed', 'ai.error'],
        userAgent: MAC_CHROME,
        platform: 'macOS',
      }),
    );
    expect(query.get('template')).toBe('extension-bug.yml');
    expect(query.get('versions')).toBe('Handshook 1.1.4, Chrome 131, macOS');
    expect(query.get('mode')).toBe('Autopilot with Review before submit off');
    expect(query.get('diagnostics')).toBe('Recent error codes: engine.ui_changed, ai.error');
  });

  it('drops unreviewed codes and never includes free text', () => {
    const query = params(
      buildIssueReportUrl({
        version: 'jane@example.com',
        errorCodes: ['Failed for jane@example.com at https://app.joinhandshake.com/jobs/123'],
        userAgent: MAC_CHROME,
        platform: 'macOS',
      }),
    );
    expect(query.get('versions')).toBe('Handshook unknown, Chrome 131, macOS');
    expect(query.has('diagnostics')).toBe(false);
    expect(query.has('mode')).toBe(false);
    expect(decodeURIComponent(query.toString())).not.toContain('example.com');
  });

  it('caps the number of codes', () => {
    const codes = [
      'engine.ui_changed',
      'ai.error',
      'selector.miss',
      'scan.started',
      'scan.page',
      'scan.complete',
    ];
    expect(reviewedErrorCodes(codes)).toHaveLength(5);
  });

  it('maps modes to the template dropdown options', () => {
    expect(modeOption('review')).toBe('Review');
    expect(modeOption('dry_run')).toBe('Dry run');
    expect(modeOption('autopilot', true)).toBe('Autopilot with Review before submit on');
    expect(modeOption('autopilot')).toBeUndefined();
  });

  it('labels browsers and operating systems', () => {
    expect(browserLabel(`${MAC_CHROME} Edg/131.0.0.0`)).toBe('Edge 131');
    expect(browserLabel('Mozilla/5.0')).toBe('Browser unknown');
    expect(osLabel('Windows', '')).toBe('Windows');
    expect(osLabel('', 'X11; Linux x86_64')).toBe('Linux');
  });
});
