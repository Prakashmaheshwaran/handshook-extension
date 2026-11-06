import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, ApplyOptions, DocumentRecord, Job } from '@/core/contracts';
import type { AnswerAssistMatch, AnswerAssistQuery } from '@/core/contracts/answerAssist';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { applyToJob } from '@/handshake/applyFlow';
import { resetSelectorHealth } from '@/handshake/health';

const HOST = 'app.joinhandshake.com';
const RESUME: DocumentRecord = { id: 'doc-resume', type: 'resume', title: 'Resume 2026' };

/** Worded differently from the form's "Are you authorized to work in the United States?". */
const ELIGIBILITY: Answer = {
  id: 'work_authorization',
  label: 'Legally eligible for US employment',
  aliases: [],
  type: 'radio',
  value: 'yes',
  options: { Yes: 'yes', No: 'no' },
  category: 'work',
  autoSubmitAllowed: true,
  sensitive: true,
  updatedAt: 1,
};

const job: Job = {
  id: '1001',
  host: HOST,
  title: 'Data Analyst',
  employer: 'Northwind Labs',
  url: `https://${HOST}/jobs/1001`,
  description: 'Analyse data.',
  applyType: 'handshake_form',
  requiredDocumentTypes: ['resume'],
  source: 'search',
  discoveredAt: 0,
};

function options(patch: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    mode: 'autopilot',
    documents: { resumeId: RESUME.id },
    documentsAvailable: [RESUME],
    answers: [ELIGIBILITY],
    allowSensitiveAutoSubmit: true,
    allowEeoAutoFill: true,
    allowFreeTextAutoFill: true,
    reviewBeforeSubmit: true,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
    timeoutMs: 1_000,
    ...patch,
  };
}

function control(
  answerAssist?: (questions: AnswerAssistQuery) => Promise<AnswerAssistMatch[] | null>,
): ApplyControl {
  return {
    authorizeSubmit: async () => true,
    needsReview: () => false,
    ...(answerAssist ? { answerAssist } : {}),
  };
}

const mapsTo = (answerId: string, confidence = 0.95) =>
  vi.fn(async (questions: AnswerAssistQuery): Promise<AnswerAssistMatch[]> =>
    questions.map((question) => ({
      questionId: question.id,
      answerId,
      source: 'ai' as const,
      confidence,
    })),
  );

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/synthetic/apply/handshake-form-unknown-question.html'),
    'utf8',
  );
  document.querySelector('button')?.addEventListener('click', () => {
    document.getElementById('apply-dialog')!.hidden = false;
  });
});

const workAuth = () => document.querySelector<HTMLSelectElement>('#work-auth')?.value;

describe('AI answer assist in the apply flow', () => {
  it('without answer assist, a differently worded question waits in Needs You', async () => {
    const result = await applyToJob(document, job, options(), undefined, control());
    expect(result.outcome).toBe('needs_input');
    expect(result.error?.code).toBe('UNKNOWN_QUESTION');
    expect(workAuth()).toBe('');
  });

  it('fills the saved answer the AI points to, and sends only the form’s own text', async () => {
    const assist = mapsTo(ELIGIBILITY.id);
    const result = await applyToJob(document, job, options(), undefined, control(assist));
    expect(result.outcome).toBe('ready_for_review');
    expect(workAuth()).toBe('yes');
    const [questions] = assist.mock.calls[0]!;
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'select', required: true });
    expect(questions[0]?.options?.map((option) => option.label)).toEqual(['yes', 'no']);
    // The query describes the form; it never carries the saved answer.
    expect(JSON.stringify(questions)).not.toContain('Legally eligible');
  });

  it('still requires the answer’s own approval', async () => {
    const result = await applyToJob(
      document,
      job,
      options({ answers: [{ ...ELIGIBILITY, autoSubmitAllowed: false }] }),
      undefined,
      control(mapsTo(ELIGIBILITY.id)),
    );
    expect(result.outcome).toBe('needs_input');
    expect(workAuth()).toBe('');
  });

  it('still requires the global sensitive-answer switch', async () => {
    const result = await applyToJob(
      document,
      job,
      options({ allowSensitiveAutoSubmit: false }),
      undefined,
      control(mapsTo(ELIGIBILITY.id)),
    );
    expect(result.outcome).toBe('needs_input');
    expect(workAuth()).toBe('');
  });

  it('ignores a mapping whose saved value does not fit the choices', async () => {
    const result = await applyToJob(
      document,
      job,
      options({ answers: [{ ...ELIGIBILITY, value: 'sometimes', options: {} }] }),
      undefined,
      control(mapsTo(ELIGIBILITY.id)),
    );
    expect(result.outcome).toBe('needs_input');
    expect(workAuth()).toBe('');
  });

  it('ignores a mapping to an answer that is not saved', async () => {
    const result = await applyToJob(
      document,
      job,
      options(),
      undefined,
      control(mapsTo('invented-answer')),
    );
    expect(result.outcome).toBe('needs_input');
  });

  it('does not ask AI when the wording already matches exactly', async () => {
    const assist = mapsTo(ELIGIBILITY.id);
    const result = await applyToJob(
      document,
      job,
      options({
        answers: [{ ...ELIGIBILITY, label: 'Are you authorized to work in the United States?' }],
      }),
      undefined,
      control(assist),
    );
    expect(result.outcome).toBe('ready_for_review');
    expect(workAuth()).toBe('yes');
    expect(assist).not.toHaveBeenCalled();
  });

  it('keeps the deterministic path when answer assist fails', async () => {
    const result = await applyToJob(
      document,
      job,
      options(),
      undefined,
      control(async () => null),
    );
    expect(result.outcome).toBe('needs_input');
  });
});

describe('AI-written answers in the apply flow', () => {
  function loadWriteForm(): void {
    document.body.innerHTML = `
      <main data-hook="job-details-page" aria-label="Job detail">
        <h1>Data Analyst</h1>
        <button type="button" aria-haspopup="dialog" aria-controls="apply-dialog">Apply</button>
        <div id="apply-dialog" hidden>
          <div role="dialog" aria-modal="true" aria-labelledby="t">
            <h2 id="t">Apply to Data Analyst</h2>
            <label for="resume-select">Resume</label>
            <select id="resume-select" name="resume" required>
              <option value="">Select a resume</option>
              <option value="doc-resume">Resume 2026</option>
            </select>
            <label for="heard">How did you hear about this position?</label>
            <input id="heard" name="heard" type="text" required />
            <fieldset>
              <legend>Do you have 2 years of SQL experience?</legend>
              <label><input type="radio" name="sql" value="yes" required /> Yes</label>
              <label><input type="radio" name="sql" value="no" /> No</label>
            </fieldset>
            <button type="button" data-testid="submit-application">Submit Application</button>
          </div>
        </div>
      </main>`;
    document.querySelector('button')?.addEventListener('click', () => {
      document.getElementById('apply-dialog')!.hidden = false;
    });
  }

  it('fills what AI may answer and never asks it about a personal fact', async () => {
    loadWriteForm();
    const answerWrite = vi.fn(async (questions: AnswerAssistQuery) =>
      questions.map((question) => ({
        questionId: question.id,
        value: 'Handshake',
        basis: 'general' as const,
        confidence: 0.95,
      })),
    );
    const result = await applyToJob(document, job, options({ answers: [] }), undefined, {
      ...control(),
      answerWrite,
    });
    const [asked] = answerWrite.mock.calls[0]!;
    expect(asked.map((question) => question.label)).toEqual([
      'how did you hear about this position',
    ]);
    // Only the SQL experience question waits for the user.
    expect(result.outcome).toBe('needs_input');
    expect(result.questions?.map((question) => question.label)).toEqual([
      'do you have 2 years of sql experience',
    ]);
  });

  it('fills the AI answer once the personal-fact question has a saved answer', async () => {
    loadWriteForm();
    const answerWrite = vi.fn(async (questions: AnswerAssistQuery) =>
      questions.map((question) => ({
        questionId: question.id,
        value: 'Handshake',
        basis: 'general' as const,
        confidence: 0.95,
      })),
    );
    const sql: Answer = {
      ...ELIGIBILITY,
      id: 'sql',
      label: 'Do you have 2 years of SQL experience?',
      value: 'no',
      sensitive: false,
    };
    const result = await applyToJob(document, job, options({ answers: [sql] }), undefined, {
      ...control(),
      answerWrite,
    });
    expect(result.outcome).toBe('ready_for_review');
    expect(document.querySelector<HTMLInputElement>('#heard')?.value).toBe('Handshake');
  });

  it('does not write over a question the answer bank knows', async () => {
    loadWriteForm();
    const answerWrite = vi.fn(async () => []);
    await applyToJob(
      document,
      job,
      options({
        answers: [
          {
            ...ELIGIBILITY,
            id: 'heard',
            label: 'How did you hear about this position?',
            type: 'text',
            value: 'Career fair',
            options: undefined,
            sensitive: false,
            autoSubmitAllowed: false,
          },
        ],
      }),
      undefined,
      { ...control(), answerWrite },
    );
    const asked =
      (answerWrite.mock.calls[0] as unknown as [AnswerAssistQuery] | undefined)?.[0] ?? [];
    expect(asked.map((question) => question.label)).not.toContain(
      'how did you hear about this position',
    );
  });

  it('skips free text when the free-text switch is off', async () => {
    loadWriteForm();
    const answerWrite = vi.fn(async () => []);
    await applyToJob(
      document,
      job,
      options({ answers: [], allowFreeTextAutoFill: false }),
      undefined,
      { ...control(), answerWrite },
    );
    expect(answerWrite).not.toHaveBeenCalled();
  });
});
