import { useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { IconRefresh, IconShield } from '@/ui/components/icons';
import { handshakeLinks } from '@/ui/components/links';

/**
 * `unchecked` is "no check has run"; `not_verified` is "a check ran and could
 * not confirm the session". They must never share a label, or a slow page
 * looks like a dead button.
 */
export type SessionUiStatus = 'unchecked' | 'logged_in' | 'logged_out' | 'not_verified';

export interface SessionStepProps {
  status: SessionUiStatus;
  host: string;
  checking: boolean;
  /** When the last check finished. Omitted until a check runs in this session. */
  checkedAt?: number;
  onCheck: () => void;
}

const STATUS_COPY: Record<SessionUiStatus, string> = {
  unchecked: 'Not checked yet',
  logged_in: 'Signed in on this browser',
  logged_out: 'Not signed in',
  not_verified: "Couldn't verify",
};

const STATUS_TONE: Record<SessionUiStatus, BadgeTone> = {
  unchecked: 'neutral',
  logged_in: 'accent',
  logged_out: 'warn',
  not_verified: 'info',
};

function describeAge(ageMs: number): string {
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Keep the age label honest while the card stays open, so a result taken
 * minutes ago stops claiming to be "just now".
 */
function useCheckedAgeLabel(checkedAt: number | undefined): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (checkedAt === undefined) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [checkedAt]);
  if (checkedAt === undefined) return null;
  return describeAge(Math.max(0, nowMs - checkedAt));
}

export function SessionStep({ status, host, checking, checkedAt, onCheck }: SessionStepProps) {
  const links = handshakeLinks(host);
  const checkedAge = useCheckedAgeLabel(checkedAt);
  return (
    <div className="space-y-3">
      <Card>
        <h2 className="text-[14px] font-semibold text-ink">Check your Handshake session</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Handshook works inside your existing browser session on{' '}
          <span className="font-mono text-[11px] text-ink">{host}</span>. There is no password field
          here, and there never will be.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<IconRefresh size={13} />}
            loading={checking}
            onClick={onCheck}
          >
            {status === 'not_verified' ? 'Check again' : 'Check session'}
          </Button>
          <span role="status" aria-live="polite">
            <Badge tone={STATUS_TONE[status]}>{STATUS_COPY[status]}</Badge>
          </span>
        </div>

        {checkedAge !== null ? (
          <p className="mt-1 text-[11px] leading-snug text-muted">
            Checked in the Handshook runner tab · {checkedAge}
          </p>
        ) : null}

        {status === 'logged_out' ? (
          <p className="mt-2 rounded-md bg-warn-soft px-2 py-1.5 text-[11.5px] leading-snug text-warn">
            Sign in on Handshake in a normal tab, then come back and check again. Handshook cannot
            automate single sign-on.
          </p>
        ) : null}

        {status === 'not_verified' ? (
          <p className="mt-2 rounded-md bg-surface-2 px-2 py-1.5 text-[11.5px] leading-snug text-muted">
            Handshook opened its own Handshake tab, but the page did not finish loading, so your
            session could not be confirmed. Try Check again; if it keeps failing, open Handshake in
            this browser, sign in, and check once more.
          </p>
        ) : null}

        {status === 'unchecked' ? (
          <p className="mt-2 text-[11.5px] leading-snug text-muted">
            The check reads Handshake in Handshook&apos;s own tab. It never signs in for you and
            never reads your other tabs.
          </p>
        ) : null}

        <div className="mt-2">
          <ExternalLink href={links.home}>Open Handshake</ExternalLink>
        </div>
      </Card>

      <Card tone="muted">
        <p className="flex items-start gap-2 text-[11.5px] leading-snug text-muted">
          <IconShield size={14} className="mt-0.5 shrink-0 text-accent" />
          Handshook reads Handshake pages to check your session, discover documents, and run
          applications. Filled forms and submissions go to Handshake. If you choose OpenRouter,
          Handshook sends the job's title and description plus your resume IDs, names and notes to
          OpenRouter, which forwards them to the model provider you picked.
        </p>
      </Card>
    </div>
  );
}
