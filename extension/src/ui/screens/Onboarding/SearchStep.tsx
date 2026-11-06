import { useId } from 'react';
import { Card } from '@/ui/components/Card';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { Field } from '@/ui/components/Field';
import { IconSearch } from '@/ui/components/icons';
import { Input } from '@/ui/components/Input';
import { handshakeLinks } from '@/ui/components/links';

export interface SearchStepProps {
  host: string;
  name: string;
  url: string;
  onName: (value: string) => void;
  onUrl: (value: string) => void;
  error: string | null;
}

export function SearchStep({ host, name, url, onName, onUrl, error }: SearchStepProps) {
  const nameId = useId();
  const urlId = useId();
  const links = handshakeLinks(host);

  return (
    <div className="space-y-3">
      <Card>
        <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <IconSearch size={15} className="text-accent" />
          Your saved search
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Handshook scans the job search you already trust. Run a search on Handshake, then paste
          the URL from the address bar.
        </p>

        <ol className="mt-2 space-y-1 pl-4 text-[11.5px] leading-snug text-muted">
          <li className="list-decimal">Open Handshake job search and set your filters.</li>
          <li className="list-decimal">
            Copy the full URL (it starts with https://…joinhandshake.com).
          </li>
          <li className="list-decimal">Paste it below and give it a name.</li>
        </ol>

        <div className="mt-3 space-y-2">
          <Field label="Search name" id={nameId}>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => onName(event.currentTarget.value)}
              placeholder="Data internships, New York"
            />
          </Field>
          <Field
            label="Search URL"
            id={urlId}
            error={error ?? undefined}
            hint="Must be a Handshake job search page (for example …/job-search). Individual job links are not accepted."
          >
            <Input
              id={urlId}
              value={url}
              onChange={(event) => onUrl(event.currentTarget.value)}
              placeholder="https://app.joinhandshake.com/jobs?query=data"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
            />
          </Field>
        </div>

        <div className="mt-2">
          <ExternalLink href={links.jobs}>Open Handshake job search</ExternalLink>
        </div>
      </Card>

      <Card tone="muted">
        <p className="text-[11px] leading-snug text-muted">
          Scanning respects your page limit and delays. Handshook reads job cards only — it does not
          message employers, follow people, or change your profile.
        </p>
      </Card>
    </div>
  );
}
