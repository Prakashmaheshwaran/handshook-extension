/**
 * Builds the "Report a problem" link: a GitHub bug report with the issue form's
 * fields prefilled. Like diagnostics, this is an allowlist. Only the version,
 * browser and OS names, run mode, and reviewed event codes are included. Error
 * messages, URLs, job and document details, and settings values are never added.
 * Nothing is sent until the user reviews the form on GitHub and submits it.
 */
import type { RunMode } from '@/core/contracts';
import { EVENT_TYPES } from './privacy';

export const ISSUE_REPO_URL = 'https://github.com/Prakashmaheshwaran/handshook-extension';
export const KNOWN_ISSUES_URL = `${ISSUE_REPO_URL}/blob/master/extension/docs/KNOWN_ISSUES.md`;
const ISSUE_TEMPLATE = 'extension-bug.yml';
const MAX_CODES = 5;

export interface IssueReportContext {
  version: string;
  mode?: RunMode;
  /** Only meaningful for Autopilot; picks the matching dropdown option. */
  reviewBeforeSubmit?: boolean;
  /** Event types from recent errors, newest first. Unreviewed types are dropped. */
  errorCodes?: readonly string[];
  /** Defaults to the current navigator. Tests pass fixed values. */
  userAgent?: string;
  platform?: string;
}

/** Exact option labels from .github/ISSUE_TEMPLATE/extension-bug.yml. */
export function modeOption(mode?: RunMode, reviewBeforeSubmit?: boolean): string | undefined {
  if (mode === 'review') return 'Review';
  if (mode === 'dry_run') return 'Dry run';
  if (mode === 'autopilot' && reviewBeforeSubmit !== undefined) {
    return `Autopilot with Review before submit ${reviewBeforeSubmit ? 'on' : 'off'}`;
  }
  return undefined;
}

export function browserLabel(userAgent: string): string {
  const edge = /\bEdg\/(\d+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /\bChrome\/(\d+)/.exec(userAgent);
  if (chrome) return `Chrome ${chrome[1]}`;
  return 'Browser unknown';
}

export function osLabel(platform: string, userAgent: string): string {
  const source = `${platform} ${userAgent}`;
  if (/mac/i.test(source)) return 'macOS';
  if (/win/i.test(source)) return 'Windows';
  if (/cros/i.test(source)) return 'ChromeOS';
  if (/linux/i.test(source)) return 'Linux';
  return 'OS unknown';
}

function currentNavigator(): { userAgent: string; platform: string } {
  if (typeof navigator === 'undefined') return { userAgent: '', platform: '' };
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return {
    userAgent: navigator.userAgent ?? '',
    platform: data?.platform ?? navigator.platform ?? '',
  };
}

export function reviewedErrorCodes(codes: readonly string[] = []): string[] {
  const allowed = new Set(EVENT_TYPES);
  return [...new Set(codes.filter((code) => allowed.has(code)))].slice(0, MAX_CODES);
}

export function buildIssueReportUrl(context: IssueReportContext): string {
  const nav = currentNavigator();
  const userAgent = context.userAgent ?? nav.userAgent;
  const platform = context.platform ?? nav.platform;
  const version = /^\d+(?:\.\d+){1,3}$/.test(context.version) ? context.version : 'unknown';

  const params = new URLSearchParams({ template: ISSUE_TEMPLATE });
  params.set(
    'versions',
    `Handshook ${version}, ${browserLabel(userAgent)}, ${osLabel(platform, userAgent)}`,
  );
  const mode = modeOption(context.mode, context.reviewBeforeSubmit);
  if (mode) params.set('mode', mode);
  const codes = reviewedErrorCodes(context.errorCodes);
  if (codes.length > 0) {
    params.set('diagnostics', `Recent error codes: ${codes.join(', ')}`);
  }
  return `${ISSUE_REPO_URL}/issues/new?${params.toString()}`;
}
