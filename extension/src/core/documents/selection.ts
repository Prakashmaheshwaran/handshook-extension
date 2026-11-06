import {
  DOCUMENT_ID_MAX_LENGTH,
  isAllowedHandshakeHost,
  MAX_ADDITIONAL_RESUMES,
  type DocumentRecord,
  type DocumentSelection,
  type DocumentType,
  type Settings,
} from '@/core/contracts';

export const QUICK_APPLY_DOCUMENTS_HELP =
  "One-click Apply / Quick apply use the resume and documents set as default in your Handshake profile. Handshook can't change them. Set your preferred resume as default on Handshake before opting in. Forms with document pickers use your Handshook choices.";

export const ONE_CLICK_APPLY_LABEL = 'Let Autopilot use Handshake one-click Apply';
export const ONE_CLICK_APPLY_HELP =
  "One-click Apply sends the resume and documents set as default in your Handshake profile. Handshook can't change them. Jobs that need other documents or answers still wait for you.";

/**
 * Review mode only: an Apply control that may submit with the click is never
 * clicked there. Autopilot clicks it and lets the application dialog collect
 * documents and answers; a missing document uses {@link documentChoiceError}.
 */
export const ONE_CLICK_APPLY_REVIEW_REASON =
  'One-click Apply: click Apply on Handshake yourself - it submits immediately';

/** Legacy document preflight only; this never authorizes a one-click send. */
export function quickApplyMayUseUnselectedDocument(
  type: DocumentType,
  required: readonly DocumentType[],
  available: readonly DocumentRecord[],
): boolean {
  return (
    required.includes(type) &&
    available.filter((document) => document.type === type && document.ready !== false).length === 1
  );
}

/** Settings and per-job choices use the same exact-ID policy. Empty strings survive RPC. */
export function documentSelectionForJob(
  settings: Settings['documents'],
  override?: DocumentSelection,
): DocumentSelection {
  return {
    resumeId: settings.defaultResumeId,
    coverLetterId: settings.coverLetterId,
    transcriptId: settings.transcriptId,
    otherDocumentId: settings.otherDocumentId,
    ...override,
  };
}

/** The default resume plus every additional resume; AI may choose only among these. */
export function aiResumeCandidates(documents: readonly DocumentRecord[]): DocumentRecord[] {
  return documents.filter((document) => document.type === 'resume' && document.ready !== false);
}

const DOCUMENT_ID = new RegExp(`^[A-Za-z0-9_-]{1,${DOCUMENT_ID_MAX_LENGTH}}$`);
/** Path segments that precede a document ID: `/docs/<id>`, `/documents/<id>`, `/stu/documents/<id>`. */
const DOCUMENT_PATH = /\/(?:docs|documents)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i;

/**
 * Accepts what a user copies from Handshake: a bare document ID or a document
 * link on a Handshake host (`https://app.joinhandshake.com/docs/12345678`).
 * Returns the ID, or null when the input is not recognizably either.
 */
export function parseHandshakeDocumentId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (DOCUMENT_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isAllowedHandshakeHost(url.hostname)) return null;
  const id = url.pathname.match(DOCUMENT_PATH)?.[1];
  return id && DOCUMENT_ID.test(id) ? id : null;
}

const SLOTS: readonly {
  type: Exclude<DocumentType, 'resume'>;
  id: 'coverLetterId' | 'transcriptId' | 'otherDocumentId';
  name: 'coverLetterName' | 'transcriptName' | 'otherDocumentName';
}[] = [
  { type: 'cover_letter', id: 'coverLetterId', name: 'coverLetterName' },
  { type: 'transcript', id: 'transcriptId', name: 'transcriptName' },
  { type: 'other', id: 'otherDocumentId', name: 'otherDocumentName' },
];

/**
 * The documents Handshook knows about, built only from what the user entered.
 * The default resume comes first and is marked default; additional resumes
 * follow (capped). IDs from a per-job override that are not saved in settings
 * are included without a name so an explicit per-job choice can be validated.
 * A `title` is the user's label or empty — never a guess.
 */
export function configuredDocuments(
  settings: Settings['documents'],
  override?: DocumentSelection,
): DocumentRecord[] {
  const records: DocumentRecord[] = [];
  const add = (type: DocumentType, id: string | undefined, title = '', isDefault = false) => {
    const clean = id?.trim();
    if (!clean || !DOCUMENT_ID.test(clean)) return;
    if (records.some((record) => record.id === clean && record.type === type)) return;
    records.push({ id: clean, type, title: title.trim(), ...(isDefault ? { isDefault } : {}) });
  };
  add('resume', settings.defaultResumeId, settings.defaultResumeName, true);
  for (const resume of (settings.additionalResumes ?? []).slice(0, MAX_ADDITIONAL_RESUMES)) {
    add('resume', resume.id, resume.name);
  }
  for (const slot of SLOTS) add(slot.type, settings[slot.id], settings[slot.name]);
  if (override) {
    for (const type of DOCUMENT_TYPES) add(type, idForType(override, type));
  }
  return records;
}

/** A user-facing label for a configured document; never empty. */
export function documentLabel(document: Pick<DocumentRecord, 'id' | 'title'>): string {
  return document.title.trim() || `Document ${document.id}`;
}

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'resume',
  'cover_letter',
  'transcript',
  'other',
];

export function idForType(selection: DocumentSelection, type: DocumentType): string | undefined {
  switch (type) {
    case 'resume':
      return selection.resumeId;
    case 'cover_letter':
      return selection.coverLetterId;
    case 'transcript':
      return selection.transcriptId;
    case 'other':
      return selection.otherDocumentId;
  }
}

/** Undeclared requirements retain the conservative resume requirement. */
export function resolveRequiredDocumentTypes(required: DocumentType[]): DocumentType[] {
  return required.length > 0 ? [...new Set(required)] : ['resume'];
}

/**
 * An explicit ID is exact, including its type; never substitute another file.
 * Legacy resume settings use the site's default, then its first resume. Optional
 * types never fall back: a required attachment without a choice needs the user.
 */
export function findDocumentForType(
  selection: DocumentSelection,
  type: DocumentType,
  available: readonly DocumentRecord[],
): DocumentRecord | undefined {
  const id = idForType(selection, type);
  if (id !== undefined)
    return available.find(
      (entry) => entry.id === id && entry.type === type && entry.ready !== false,
    );
  if (type !== 'resume') return undefined;
  return (
    available.find((entry) => entry.type === type && entry.isDefault && entry.ready !== false) ??
    available.find((entry) => entry.type === type && entry.ready !== false)
  );
}

/**
 * A user-facing explanation for a document choice that cannot be used. Handshook
 * knows only the IDs and labels the user entered, so a missing choice asks for a
 * link or ID instead of claiming anything about the Handshake document list.
 */
export function documentChoiceError(
  selection: DocumentSelection,
  type: DocumentType,
  available: readonly DocumentRecord[],
): string | undefined {
  if (findDocumentForType(selection, type, available)) return undefined;
  const id = idForType(selection, type);
  const label = type.replace('_', ' ');
  if (!id) return `This job needs a ${label}. Add its Handshake document link or ID.`;
  const found = available.find((entry) => entry.id === id);
  if (!found) return `Your ${label} (ID ${id}) is not a valid Handshake document link or ID.`;
  if (found.ready === false)
    return `Your ${label} (${documentLabel(found)}) is not Ready on Handshake. Choose a ready document.`;
  return `Your ${label} (${documentLabel(found)}) has type ${found.type.replace('_', ' ')}, not ${label}.`;
}

export function findMissingDocumentTypes(
  required: DocumentType[],
  selection: DocumentSelection,
  available: readonly DocumentRecord[],
): DocumentType[] {
  return resolveRequiredDocumentTypes(required).filter(
    (type) => !findDocumentForType(selection, type, available),
  );
}
