import { useCallback, useEffect, useState } from 'react';
import {
  DOCUMENT_NAME_MAX_LENGTH,
  MAX_ADDITIONAL_RESUMES,
  type AdditionalResume,
  type Settings,
} from '@/core/contracts';
import { parseHandshakeDocumentId, QUICK_APPLY_DOCUMENTS_HELP } from '@/core/documents/selection';
import { Button } from './Button';
import { DocumentIdField } from './DocumentIdField';
import { ExternalLink } from './ExternalLink';
import { Field } from './Field';
import { Input } from './Input';
import { handshakeLinks } from './links';
import { ToggleRow } from './ToggleRow';

type DocumentSettings = Settings['documents'];

type AttachmentIdKey = 'coverLetterId' | 'transcriptId' | 'otherDocumentId';
type AttachmentNameKey = 'coverLetterName' | 'transcriptName' | 'otherDocumentName';

const ATTACHMENTS: readonly {
  idKey: AttachmentIdKey;
  nameKey: AttachmentNameKey;
  label: string;
}[] = [
  { idKey: 'coverLetterId', nameKey: 'coverLetterName', label: 'Cover letter' },
  { idKey: 'transcriptId', nameKey: 'transcriptName', label: 'Transcript' },
  { idKey: 'otherDocumentId', nameKey: 'otherDocumentName', label: 'Other document' },
];

function attachmentIdPatch(key: AttachmentIdKey, id: string): Partial<DocumentSettings> {
  switch (key) {
    case 'coverLetterId':
      return { coverLetterId: id };
    case 'transcriptId':
      return { transcriptId: id };
    case 'otherDocumentId':
      return { otherDocumentId: id };
  }
}

function attachmentNamePatch(key: AttachmentNameKey, name: string): Partial<DocumentSettings> {
  switch (key) {
    case 'coverLetterName':
      return { coverLetterName: name };
    case 'transcriptName':
      return { transcriptName: name };
    case 'otherDocumentName':
      return { otherDocumentName: name };
  }
}

export interface DocumentChoicesProps {
  host: string;
  value: DocumentSettings;
  onChange: (patch: Partial<DocumentSettings>) => void;
  aiEnabled: boolean;
  /** Reports whether a typed field is invalid, so a caller can block Continue. */
  onValidityChange?: (valid: boolean) => void;
}

interface AdditionalRow {
  key: string;
  name: string;
  id?: string;
}

function savedRows(resumes: readonly AdditionalResume[] | undefined): AdditionalRow[] {
  return (resumes ?? []).map((resume, index) => ({
    key: `saved-${index}-${resume.id}`,
    name: resume.name,
    id: resume.id,
  }));
}

/** Stable comparison key so a Saved/undo change can replace the local rows. */
function rowsKey(resumes: readonly AdditionalResume[] | undefined): string {
  return JSON.stringify(resumes ?? []);
}

/** Why a name matters, shown under every document name field. */
const NAME_HINT =
  'Type the file’s name exactly as Handshake shows it. Handshook searches for it in the application’s document picker.';

function NameField({
  label,
  required,
  value,
  hint = NAME_HINT,
  onChange,
}: {
  label: string;
  required?: boolean;
  value?: string;
  hint?: string;
  onChange: (name: string) => void;
}) {
  return (
    <Field label={label} required={required} hint={hint}>
      <Input
        type="text"
        autoComplete="off"
        maxLength={DOCUMENT_NAME_MAX_LENGTH}
        value={value ?? ''}
        onChange={(event) => {
          const text = event.currentTarget.value;
          // '' clears a saved name; settings patches drop undefined keys.
          onChange(text.trim() ? text : '');
        }}
      />
    </Field>
  );
}

export function DocumentChoices({
  host,
  value,
  onChange,
  aiEnabled,
  onValidityChange,
}: DocumentChoicesProps) {
  const [rowsState, setRowsState] = useState(() => ({
    source: rowsKey(value.additionalResumes),
    rows: savedRows(value.additionalResumes),
  }));
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(() => new Set());

  // Settings discard (or an import) replaces every unsaved row.
  let rows = rowsState.rows;
  const externalRows = rowsKey(value.additionalResumes);
  if (externalRows !== rowsState.source) {
    rows = savedRows(value.additionalResumes);
    setRowsState({ source: externalRows, rows });
  }

  const commitRows = (next: readonly AdditionalRow[]): void => {
    const complete: AdditionalResume[] = [];
    for (const row of next) {
      const name = row.name.trim();
      const id = parseHandshakeDocumentId(row.id ?? '');
      if (name && id) complete.push({ id, name });
    }
    setRowsState({ source: rowsKey(complete), rows: [...next] });
    // [] (not undefined) so removing the last row survives the settings patch.
    onChange({ additionalResumes: complete });
  };

  const reportField = useCallback((key: string, invalid: boolean): void => {
    setInvalidFields((current) => {
      if (current.has(key) === invalid) return current;
      const next = new Set(current);
      if (invalid) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const addRow = (): void => {
    if (rows.length >= MAX_ADDITIONAL_RESUMES) return;
    commitRows([...rows, { key: crypto.randomUUID(), name: '' }]);
  };

  const removeRow = (key: string): void => {
    reportField(key, false);
    commitRows(rows.filter((row) => row.key !== key));
  };

  const updateRow = (key: string, patch: Partial<AdditionalRow>): void => {
    commitRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const rowInvalid = rows.some((row) => (row.name.trim() ? !row.id : Boolean(row.id)));
  const invalid = rowInvalid || invalidFields.size > 0;
  useEffect(() => {
    onValidityChange?.(!invalid);
  }, [invalid, onValidityChange]);

  const ids = [value.defaultResumeId, ...rows.map((row) => row.id)].filter((id): id is string =>
    Boolean(id),
  );
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const unnamed = [
    value.defaultResumeId && !value.defaultResumeName?.trim() ? 'default resume' : null,
    ...ATTACHMENTS.map((slot) =>
      value[slot.idKey] && !value[slot.nameKey]?.trim() ? slot.label.toLowerCase() : null,
    ),
  ].filter((label): label is string => label !== null);
  const aiNeedsDefaultName =
    aiEnabled &&
    value.autoSelectResume &&
    rows.some((row) => row.id) &&
    Boolean(value.defaultResumeId) &&
    !value.defaultResumeName?.trim();

  return (
    <div className="min-w-0 space-y-4">
      <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-snug text-muted">
        <li>
          <ExternalLink href={handshakeLinks(host).documents}>
            Open my Handshake documents
          </ExternalLink>
        </li>
        <li>Open a document and copy the link from the address bar — or just its number.</li>
        <li>Paste it into the fields below.</li>
      </ol>

      <fieldset className="space-y-2">
        <legend className="text-[12.5px] font-medium text-ink">Default resume</legend>
        <NameField
          label="Resume name"
          hint={`${NAME_HINT} AI also uses it to choose between your resumes.`}
          value={value.defaultResumeName}
          onChange={(defaultResumeName) => onChange({ defaultResumeName })}
        />
        <DocumentIdField
          label="Resume link or ID"
          value={value.defaultResumeId}
          onChange={(defaultResumeId) => onChange({ defaultResumeId })}
          onValidityChange={(bad) => reportField('default', bad)}
        />
        {value.defaultResumeId ? null : (
          <p role="status" className="text-[11.5px] leading-snug text-warn">
            Jobs will wait in Needs You until you add a resume.
          </p>
        )}
      </fieldset>

      {aiEnabled ? (
        <ToggleRow
          label="Let AI pick the best resume for each job"
          description="AI chooses between your default and additional resumes by their names, so give each one a descriptive name (for example “Data analyst resume”). If it is unsure, the default is used."
          checked={value.autoSelectResume}
          onChange={(autoSelectResume) => onChange({ autoSelectResume })}
        />
      ) : (
        <p className="text-[11.5px] leading-snug text-muted">
          AI is off. Your default resume is used for every job; you can choose another resume for a
          single job in Queue or Needs You.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="text-[12.5px] font-medium text-ink">Additional resumes</legend>
        <p role="status" className="text-[11.5px] text-muted">
          {rows.length} of {MAX_ADDITIONAL_RESUMES}
        </p>
        {rows.map((row, index) => {
          const number = index + 1;
          const named = row.name.trim() !== '';
          return (
            <div key={row.key} className="space-y-2 rounded-lg border border-line p-2.5">
              <Field
                label={`Additional resume ${number} name`}
                required
                error={!named && row.id ? 'Add a name for this resume.' : undefined}
              >
                <Input
                  type="text"
                  autoComplete="off"
                  maxLength={DOCUMENT_NAME_MAX_LENGTH}
                  value={row.name}
                  onChange={(event) => updateRow(row.key, { name: event.currentTarget.value })}
                />
              </Field>
              <DocumentIdField
                label={`Additional resume ${number} link or ID`}
                value={row.id}
                required={named}
                onChange={(id) => updateRow(row.key, { id })}
                onValidityChange={(bad) => reportField(row.key, bad)}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove additional resume ${number}`}
                onClick={() => removeRow(row.key)}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="secondary"
          disabled={rows.length >= MAX_ADDITIONAL_RESUMES}
          onClick={addRow}
        >
          Add resume
        </Button>
      </fieldset>

      {aiNeedsDefaultName ? (
        <p role="status" className="text-[11.5px] leading-snug text-warn">
          Name your default resume so AI can choose between it and your additional resumes. Until
          then the default is used for every job.
        </p>
      ) : null}

      {duplicates.length > 0 ? (
        <p role="status" className="text-[11.5px] leading-snug text-warn">
          The same document is used more than once: {duplicates.join(', ')}. Check the IDs above.
        </p>
      ) : null}

      {ATTACHMENTS.map((slot) => (
        <fieldset key={slot.idKey} className="space-y-2">
          <legend className="text-[12.5px] font-medium text-ink">{slot.label}</legend>
          <NameField
            label={`${slot.label} name`}
            value={value[slot.nameKey]}
            onChange={(name) => onChange(attachmentNamePatch(slot.nameKey, name))}
          />
          <DocumentIdField
            label={`${slot.label} link or ID`}
            value={value[slot.idKey]}
            hint="Leave empty when you do not want to use one."
            onChange={(id) => onChange(attachmentIdPatch(slot.idKey, id))}
            onValidityChange={(bad) => reportField(slot.idKey, bad)}
          />
        </fieldset>
      ))}

      {unnamed.length > 0 ? (
        <p role="status" className="text-[11.5px] leading-snug text-warn">
          Add a name for your {unnamed.join(', ')}. Without it Handshook can only look for the ID
          among the files Handshake shows first, so a job may wait in Needs You.
        </p>
      ) : null}

      <div className="rounded-lg border border-line bg-surface-2 p-2.5">
        <p className="text-[12px] font-medium text-ink">How documents work</p>
        <ul className="mt-1.5 list-disc space-y-1.5 pl-4 text-[11.5px] leading-snug text-muted">
          <li>
            Upload and manage files on Handshake. Paste a document link or its ID here; Handshook
            never uploads, lists, or edits files.
          </li>
          <li>
            Your default and optional attachments are used when requested. Change a single job’s
            choices in Queue or Needs You.
          </li>
          <li>{QUICK_APPLY_DOCUMENTS_HELP}</li>
        </ul>
      </div>
    </div>
  );
}
