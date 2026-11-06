import { useState } from 'react';
import type { DocumentSelection } from '@/core/contracts';
import {
  configuredDocuments,
  documentLabel,
  documentSelectionForJob,
} from '@/core/documents/selection';
import { sendRequest } from '@/ui/bridge';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { Button } from './Button';
import { DocumentIdField } from './DocumentIdField';
import { ExternalLink } from './ExternalLink';
import { Field } from './Field';
import { Select } from './Select';
import { handshakeLinks } from './links';

const OTHER_RESUME = '__other__';

const ATTACHMENTS: readonly {
  key: 'coverLetterId' | 'transcriptId' | 'otherDocumentId';
  label: string;
}[] = [
  { key: 'coverLetterId', label: 'Cover letter' },
  { key: 'transcriptId', label: 'Transcript' },
  { key: 'otherDocumentId', label: 'Other document' },
];

export function JobDocumentChoices({
  jobId,
  selection,
  continueJob = false,
  onSaved,
}: {
  jobId: string;
  selection?: DocumentSelection;
  continueJob?: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const app = useAppContext();
  const [edits, setEdits] = useState<Partial<DocumentSelection>>({});
  const [otherResume, setOtherResume] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(() => new Set());
  if (!app.settings) return null;

  const reportField =
    (key: string) =>
    (bad: boolean): void => {
      setInvalidFields((current) => {
        if (current.has(key) === bad) return current;
        const next = new Set(current);
        if (bad) next.add(key);
        else next.delete(key);
        return next;
      });
    };
  const invalid = invalidFields.size > 0;

  const settings = app.settings;
  const resumes = configuredDocuments(settings.documents).filter(
    (document) => document.type === 'resume',
  );
  const defaultResume = resumes.find((document) => document.isDefault) ?? resumes[0];
  const override: Partial<DocumentSelection> = { ...(selection ?? {}), ...edits };
  const effective = documentSelectionForJob(settings.documents, override);

  const resumeOverride = override.resumeId;
  const resumeIsConfigured = resumes.some((document) => document.id === resumeOverride);
  const showOtherResume = otherResume || (Boolean(resumeOverride) && !resumeIsConfigured);
  const resumeSelectValue = showOtherResume
    ? OTHER_RESUME
    : (resumeOverride ?? defaultResume?.id ?? OTHER_RESUME);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const result = await sendRequest({
      type: continueJob ? 'ui.needs.documentsResolved' : 'ui.queue.documents',
      jobId,
      documents: {
        resumeId: effective.resumeId ?? '',
        coverLetterId: effective.coverLetterId ?? '',
        transcriptId: effective.transcriptId ?? '',
        otherDocumentId: effective.otherDocumentId ?? '',
      },
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await onSaved();
    app.notify(
      'success',
      continueJob
        ? 'Documents saved. Continuing this job.'
        : 'Document choices saved for this job.',
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-[11.5px] leading-snug text-muted">
        Choose documents for this job only. Your defaults stay the same.
      </p>

      {resumes.length > 0 ? (
        <Field label="Resume for this job">
          <Select
            value={resumeSelectValue}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next === OTHER_RESUME) {
                setOtherResume(true);
                setEdits((current) => ({ ...current, resumeId: undefined }));
                return;
              }
              setOtherResume(false);
              // The "another resume" field unmounts; never keep it blocking Save.
              reportField('resume')(false);
              setEdits((current) => ({ ...current, resumeId: next }));
            }}
            options={[
              ...resumes.map((document) => ({
                value: document.id,
                label: documentLabel(document),
              })),
              { value: OTHER_RESUME, label: 'Another resume (enter ID)' },
            ]}
          />
        </Field>
      ) : null}

      {resumes.length === 0 || showOtherResume ? (
        <DocumentIdField
          label="Resume link or ID"
          value={resumeIsConfigured ? undefined : resumeOverride}
          onChange={(resumeId) => setEdits((current) => ({ ...current, resumeId }))}
          onValidityChange={reportField('resume')}
        />
      ) : null}

      {ATTACHMENTS.map((slot) => (
        <DocumentIdField
          key={slot.key}
          label={slot.label}
          value={effective[slot.key] ?? ''}
          hint="Leave empty to use none for this job."
          onChange={(id) => setEdits((current) => ({ ...current, [slot.key]: id }))}
          onValidityChange={reportField(slot.key)}
        />
      ))}

      <ExternalLink href={handshakeLinks(settings.host).documents}>
        Open my Handshake documents
      </ExternalLink>

      {error ? (
        <p role="alert" className="break-words text-[11.5px] font-medium text-danger">
          {error}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="primary"
        loading={saving}
        // An empty "Another resume" would save "no resume for this job".
        disabled={invalid || (showOtherResume && !resumeOverride)}
        onClick={() => void save()}
      >
        {continueJob ? 'Save documents & continue' : 'Save for this job'}
      </Button>
    </div>
  );
}
