import { describe, expect, it } from 'vitest';
import {
  MAX_ADDITIONAL_RESUMES,
  DEFAULT_SETTINGS,
  mergeSettings,
  parseSettings,
  parseUiRequest,
  type DocumentRecord,
} from '@/core/contracts';
import {
  aiResumeCandidates,
  configuredDocuments,
  documentChoiceError,
  findDocumentForType,
  findMissingDocumentTypes,
  parseHandshakeDocumentId,
  quickApplyMayUseUnselectedDocument,
} from '@/core/documents/selection';
import { upgradeStoredSettings } from '@/core/storage/settings-upgrade';
import { legacyDocumentSchema } from '@/core/migration/schemas';
import { makeDocument } from '@/test/factories';

describe('parseHandshakeDocumentId', () => {
  it.each([
    ['12345678', '12345678'],
    ['  abc-def_123  ', 'abc-def_123'],
    ['https://app.joinhandshake.com/docs/123', '123'],
    ['https://app.joinhandshake.co.uk/docs/123', '123'],
    ['https://app.joinhandshake.com/stu/documents/123', '123'],
    ['https://app.joinhandshake.com/docs/123/preview', '123'],
    ['https://app.joinhandshake.com/docs/123?query=1', '123'],
    ['app.joinhandshake.com/documents/123', '123'],
  ])('parses %s', (input, expected) => {
    expect(parseHandshakeDocumentId(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'not a document',
    'https://evil.example.com/docs/123',
    'https://joinhandshake.com.evil.test/docs/123',
    'javascript:alert(1)',
    'https://app.joinhandshake.com/jobs/123',
  ])('rejects %s', (input) => {
    expect(parseHandshakeDocumentId(input)).toBeNull();
  });
});

describe('configuredDocuments', () => {
  it('orders the default resume, additional resumes, then the other slots', () => {
    const documents = configuredDocuments({
      defaultResumeId: 'resume-default',
      defaultResumeName: 'Main Resume',
      additionalResumes: [
        { id: 'resume-2', name: 'Second Resume' },
        { id: 'resume-3', name: '' },
      ],
      coverLetterId: 'cover',
      coverLetterName: 'Cover Letter',
      transcriptId: 'transcript',
      otherDocumentId: 'other',
      autoSelectResume: true,
    });

    expect(documents).toEqual([
      { id: 'resume-default', type: 'resume', title: 'Main Resume', isDefault: true },
      { id: 'resume-2', type: 'resume', title: 'Second Resume' },
      { id: 'resume-3', type: 'resume', title: '' },
      { id: 'cover', type: 'cover_letter', title: 'Cover Letter' },
      { id: 'transcript', type: 'transcript', title: '' },
      { id: 'other', type: 'other', title: '' },
    ]);
  });

  it('caps additional resumes at the contract limit', () => {
    const additionalResumes = Array.from({ length: MAX_ADDITIONAL_RESUMES + 2 }, (_, index) => ({
      id: `resume-${index}`,
      name: `Resume ${index}`,
    }));
    const documents = configuredDocuments({
      defaultResumeId: 'default',
      additionalResumes,
      autoSelectResume: true,
    });
    expect(documents.filter((entry) => entry.type === 'resume')).toHaveLength(
      MAX_ADDITIONAL_RESUMES + 1,
    );
  });

  it('includes per-job override IDs with an empty title and skips invalid IDs', () => {
    expect(
      configuredDocuments({ autoSelectResume: true }, { transcriptId: 'job-transcript' }),
    ).toEqual([{ id: 'job-transcript', type: 'transcript', title: '' }]);
    expect(
      configuredDocuments({
        defaultResumeId: 'bad id',
        transcriptId: 'ok-id',
        autoSelectResume: true,
      }),
    ).toEqual([{ id: 'ok-id', type: 'transcript', title: '' }]);
  });

  it('labels records with the user name or the document ID', () => {
    const records = configuredDocuments({
      defaultResumeId: '123',
      defaultResumeName: '  My Resume  ',
      transcriptId: '456',
      autoSelectResume: true,
    });
    expect(findDocumentForType({ resumeId: '123' }, 'resume', records)).toMatchObject({
      title: 'My Resume',
    });
    expect(documentChoiceError({ transcriptId: '456' }, 'transcript', records)).toBeUndefined();
  });
});

describe('document resolution', () => {
  const first = makeDocument({ id: 'first', type: 'resume', isDefault: false });
  const preferred = makeDocument({ id: 'preferred', type: 'resume', isDefault: true });
  const cover = makeDocument({ id: 'cover', type: 'cover_letter' });

  it('uses the default of the requested type only when no ID was chosen', () => {
    expect(findDocumentForType({}, 'resume', [cover, first, preferred])).toEqual(preferred);
    expect(findDocumentForType({}, 'resume', [cover, first])).toEqual(first);
  });

  it('never substitutes the default for a missing or wrong-type explicit ID', () => {
    expect(
      findDocumentForType({ resumeId: 'missing' }, 'resume', [first, preferred]),
    ).toBeUndefined();
    expect(findDocumentForType({ resumeId: cover.id }, 'resume', [cover, first])).toBeUndefined();
    expect(findDocumentForType({ resumeId: first.id }, 'resume', [preferred, first])).toEqual(
      first,
    );
  });

  it('keeps the conservative resume requirement when the posting has no declared types', () => {
    expect(findMissingDocumentTypes([], {}, [cover])).toEqual(['resume']);
    expect(findMissingDocumentTypes([], {}, [cover, first])).toEqual([]);
  });

  it('does not attach an unchosen required optional document or replace None with the first file', () => {
    expect(findMissingDocumentTypes(['cover_letter'], {}, [cover])).toEqual(['cover_letter']);
    expect(findMissingDocumentTypes(['cover_letter'], { coverLetterId: '' }, [cover])).toEqual([
      'cover_letter',
    ]);
    expect(findDocumentForType({ resumeId: '' }, 'resume', [first])).toBeUndefined();
  });

  it('asks for a link or ID when a required document is unset', () => {
    expect(documentChoiceError({}, 'transcript', [])).toBe(
      'This job needs a transcript. Add its Handshake document link or ID.',
    );
    expect(documentChoiceError({ transcriptId: 'bad id!' }, 'transcript', [])).toMatch(
      /not a valid Handshake document/i,
    );
  });

  it('lists every resume for AI matching with no allow-list', () => {
    expect(aiResumeCandidates([first, preferred, cover])).toEqual([first, preferred]);
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      documents: { defaultResumeId: first.id, coverLetterId: cover.id },
    });
    const parsed = parseSettings(upgradeStoredSettings(settings));
    expect(parsed).toMatchObject({
      ok: true,
      value: { documents: { defaultResumeId: first.id, coverLetterId: cover.id } },
    });
  });

  it('preserves exact per-job choices and None through the request parser', () => {
    const request = {
      type: 'ui.needs.documentsResolved',
      requestId: 'choice',
      jobId: '900001',
      documents: { resumeId: 'preferred', coverLetterId: '', transcriptId: 'transcript' },
    };
    expect(parseUiRequest(JSON.parse(JSON.stringify(request)))).toMatchObject({
      ok: true,
      value: request,
    });
  });

  it('lists non-ready uploads but excludes them from exact choices, defaults and AI matching', () => {
    const processing = makeDocument({ id: 'processing', ready: false, isDefault: true });
    expect(
      findDocumentForType({ resumeId: processing.id }, 'resume', [processing, first]),
    ).toBeUndefined();
    expect(findDocumentForType({}, 'resume', [processing, first])).toEqual(first);
    expect(findMissingDocumentTypes(['resume'], { resumeId: processing.id }, [processing])).toEqual(
      ['resume'],
    );
    expect(aiResumeCandidates([processing, first])).toEqual([first]);
    expect(quickApplyMayUseUnselectedDocument('resume', ['resume'], [processing])).toBe(false);
    expect(documentChoiceError({ resumeId: processing.id }, 'resume', [processing])).toMatch(
      /not Ready/,
    );
  });

  it('preserves upload metadata in backups and accepts legacy documents without metadata', () => {
    const record: DocumentRecord = { ...first, uploadedAt: 'February 16, 2025', ready: false };
    expect(legacyDocumentSchema.parse(record)).toEqual(record);
    expect(legacyDocumentSchema.parse(first)).toEqual(first);
    expect(legacyDocumentSchema.safeParse({ ...record, ready: 'Ready' }).success).toBe(false);
    expect(legacyDocumentSchema.safeParse({ ...record, uploadedAt: 123 }).success).toBe(false);
  });
});
