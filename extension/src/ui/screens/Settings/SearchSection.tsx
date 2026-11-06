import { useId, useState } from 'react';
import { now } from '@/core/util/time';
import type { SavedSearch } from '@/core/contracts';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Checkbox';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { Field } from '@/ui/components/Field';
import { IconPlus, IconTrash } from '@/ui/components/icons';
import { IconButton } from '@/ui/components/IconButton';
import { Input } from '@/ui/components/Input';
import { ListInput } from '@/ui/components/ListInput';
import { Section } from '@/ui/components/Section';
import { Select } from '@/ui/components/Select';
import { isHandshakeJobSearchUrl } from '@/ui/components/ui-copy';
import { handshakeLinks } from '@/ui/components/links';
import type { SettingsSectionProps } from './types';
import { toNumber } from './types';

export function SearchSection({ draft, onChange }: SettingsSectionProps) {
  const links = handshakeLinks(draft.host);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SavedSearch | null>(null);
  const nameId = useId();
  const urlId = useId();
  const fitId = useId();

  const addSearch = (): void => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      setError('Give the search a short name.');
      return;
    }
    if (!isHandshakeJobSearchUrl(trimmedUrl)) {
      setError(
        'Paste a Handshake job search URL, for example https://app.joinhandshake.com/job-search. Individual job links are not accepted.',
      );
      return;
    }
    const search: SavedSearch = {
      id: crypto.randomUUID(),
      name: trimmedName,
      url: trimmedUrl,
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
    };
    onChange({
      search: {
        savedSearches: [...draft.search.savedSearches, search],
        activeSearchId: draft.search.activeSearchId ?? search.id,
      },
    });
    setName('');
    setUrl('');
    setError(null);
  };

  const removeSearch = (id: string): void => {
    onChange({
      search: {
        savedSearches: draft.search.savedSearches.filter((search) => search.id !== id),
        activeSearchId:
          draft.search.activeSearchId === id ? undefined : draft.search.activeSearchId,
      },
    });
  };

  const toggleSearch = (id: string, enabled: boolean): void => {
    onChange({
      search: {
        savedSearches: draft.search.savedSearches.map((search) =>
          search.id === id ? { ...search, enabled, updatedAt: now() } : search,
        ),
      },
    });
  };

  return (
    <Section
      id="search"
      title="Search"
      description="Handshook only visits the searches you paste here. It never invents a search."
    >
      <div className="space-y-3 rounded-panel border border-line bg-surface p-3">
        <Field
          label="Handshake host"
          hint="Choose your region. Handshook also saves the host it detects after a session check."
        >
          <Select
            value={draft.host}
            onChange={(event) => onChange({ host: event.currentTarget.value })}
            options={[
              { value: 'app.joinhandshake.com', label: 'United States — app.joinhandshake.com' },
              {
                value: 'app.joinhandshake.co.uk',
                label: 'United Kingdom — app.joinhandshake.co.uk',
              },
            ]}
          />
        </Field>
        {draft.search.savedSearches.length === 0 ? (
          <p className="text-[11.5px] text-muted">
            No saved searches yet. Paste the URL of a Handshake job search below.
          </p>
        ) : (
          <ul className="space-y-2">
            {draft.search.savedSearches.map((search) => (
              <li key={search.id} className="rounded-lg border border-line bg-surface-2 p-2">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="break-words text-[12px] font-medium text-ink">{search.name}</p>
                    <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted">
                      {search.url}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {draft.search.activeSearchId === search.id ? (
                      <Badge tone="accent">Active</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onChange({ search: { activeSearchId: search.id } })}
                      >
                        Use
                      </Button>
                    )}
                    <IconButton
                      label={`Remove ${search.name}`}
                      size="sm"
                      tone="danger"
                      onClick={() => setRemoveTarget(search)}
                    >
                      <IconTrash size={13} />
                    </IconButton>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <Checkbox
                    label="Enabled"
                    checked={search.enabled}
                    onChange={(enabled) => toggleSearch(search.id, enabled)}
                  />
                  <ExternalLink href={search.url} withIcon={false} className="text-[11px]">
                    Preview
                  </ExternalLink>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2">
          <Field label="Search name" id={nameId}>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Data internships"
            />
          </Field>
          <Field
            label="Search URL"
            id={urlId}
            hint="In Handshake, run a job search, then copy the address bar URL."
          >
            <Input
              id={urlId}
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://app.joinhandshake.com/jobs?query=…"
              inputMode="url"
              spellCheck={false}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-[11.5px] font-medium text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<IconPlus size={13} />}
              onClick={addSearch}
            >
              Add saved search
            </Button>
            <ExternalLink href={links.jobs}>Open Handshake job search</ExternalLink>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 rounded-panel border border-line bg-surface p-3">
        <Field
          label={`Minimum fit score: ${Math.round(draft.search.minFitScore * 100)}%`}
          id={fitId}
          hint="Jobs below this score are filtered out before they reach the queue."
        >
          <input
            id={fitId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(draft.search.minFitScore * 100)}
            onChange={(event) =>
              onChange({ search: { minFitScore: toNumber(event.currentTarget.value, 55) / 100 } })
            }
            className="w-full accent-[var(--accent)]"
          />
        </Field>

        <Field label="Include keywords" hint="Comma separated. Any match adds to the score.">
          <ListInput
            values={draft.search.includeKeywords}
            onValuesChange={(includeKeywords) => onChange({ search: { includeKeywords } })}
            placeholder="analyst, data, research"
          />
        </Field>

        <Field label="Exclude keywords" hint="Comma separated. A match filters the job out.">
          <ListInput
            values={draft.search.excludeKeywords}
            onValuesChange={(excludeKeywords) => onChange({ search: { excludeKeywords } })}
            placeholder="unpaid, commission only"
          />
        </Field>

        <Field label="Locations" hint="Comma separated. Leave empty to accept any location.">
          <ListInput
            values={draft.search.locations}
            onValuesChange={(locations) => onChange({ search: { locations } })}
            placeholder="New York, Remote"
          />
        </Field>

        <Field
          label="Employment types"
          hint="Comma separated. Leave empty to accept any type; jobs with an unknown type are kept with a warning."
        >
          <ListInput
            values={draft.search.employmentTypes}
            onValuesChange={(employmentTypes) => onChange({ search: { employmentTypes } })}
            placeholder="Internship, Co-op, Full-time"
          />
        </Field>

        <Checkbox
          label="Remote roles only"
          checked={draft.search.remoteOnly}
          onChange={(remoteOnly) => onChange({ search: { remoteOnly } })}
        />

        <div className="grid grid-cols-2 gap-2">
          <Field label="Max pages per run">
            <Input
              type="number"
              min={0}
              max={20}
              value={draft.search.maxPagesPerRun}
              onChange={(event) =>
                onChange({
                  search: {
                    maxPagesPerRun: toNumber(
                      event.currentTarget.value,
                      draft.search.maxPagesPerRun,
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Max jobs per run">
            <Input
              type="number"
              min={1}
              max={500}
              value={draft.search.maxJobsPerRun}
              onChange={(event) =>
                onChange({
                  search: {
                    maxJobsPerRun: toNumber(event.currentTarget.value, draft.search.maxJobsPerRun),
                  },
                })
              }
            />
          </Field>
        </div>
      </div>
      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove this saved search?"
        description={
          removeTarget
            ? `“${removeTarget.name}” will be removed when you save settings. Tracked jobs stay in the queue.`
            : undefined
        }
        confirmLabel="Remove search"
        tone="danger"
        onConfirm={() => {
          if (removeTarget) removeSearch(removeTarget.id);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Section>
  );
}
