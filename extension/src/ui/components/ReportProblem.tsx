import {
  buildIssueReportUrl,
  KNOWN_ISSUES_URL,
  type IssueReportContext,
} from '@/core/diagnostics/issueReport';
import { ExternalLink } from './ExternalLink';
import { IconExternal } from './icons';

export interface ReportProblemProps {
  context: IssueReportContext;
  className?: string;
}

/**
 * Opens a prefilled GitHub bug report in a new tab. Nothing is sent from the
 * extension: the user reviews and submits the form on GitHub, where new reports
 * are listed in docs/KNOWN_ISSUES.md automatically.
 */
export function ReportProblem({ context, className = '' }: ReportProblemProps) {
  return (
    <div className={['space-y-1.5', className].filter(Boolean).join(' ')}>
      <a
        href={buildIssueReportUrl(context)}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <IconExternal size={13} />
        Report a problem
        <span className="sr-only">(opens GitHub in a new tab)</span>
      </a>
      <p className="text-[10.5px] leading-snug text-muted">
        Opens a GitHub bug report with your Handshook version, browser, run mode, and recent error
        codes filled in. Review it before submitting: issues are public, so never add passwords,
        keys, resumes, or job details. Check{' '}
        <ExternalLink href={KNOWN_ISSUES_URL} withIcon={false} className="text-[10.5px]">
          known issues
        </ExternalLink>{' '}
        first.
      </p>
    </div>
  );
}
