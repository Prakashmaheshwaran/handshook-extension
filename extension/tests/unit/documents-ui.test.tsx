import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_ADDITIONAL_RESUMES,
  mergeSettings,
  type DocumentSelection,
  type Settings,
} from '@/core/contracts';
import { configuredDocuments } from '@/core/documents/selection';
import { DOCUMENT_ID_ERROR } from '@/ui/components/DocumentIdField';
import { DocumentChoices } from '@/ui/components/DocumentChoices';
import { JobDocumentChoices } from '@/ui/components/JobDocumentChoices';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { makeEngineState, makeSettings } from '@/test/factories';
import { sendRequest } from '@/ui/bridge';

vi.mock('@/ui/bridge', async (original) => ({
  ...(await original<typeof import('@/ui/bridge')>()),
  sendRequest: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY: Settings['documents'] = { autoSelectResume: false };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

function output(): Settings['documents'] {
  return JSON.parse(
    container.querySelector('output')?.textContent ?? '{}',
  ) as Settings['documents'];
}

function control<T extends HTMLElement>(label: string): T {
  const field = [...container.querySelectorAll('label')].find(
    (node) => node.querySelector('span')?.textContent === label,
  );
  const element = field && document.getElementById(field.htmlFor);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element as T;
}

async function type(label: string, value: string): Promise<void> {
  const input = control<HTMLInputElement>(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === name || node.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function click(name: string): Promise<void> {
  await act(async () => button(name).click());
}

function Harness({
  initial = EMPTY,
  aiEnabled = true,
}: {
  initial?: Settings['documents'];
  aiEnabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DocumentChoices
        host="app.joinhandshake.com"
        value={value}
        aiEnabled={aiEnabled}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
      />
      <output>{JSON.stringify(value)}</output>
      <button type="button" onClick={() => setValue(initial)}>
        Reset
      </button>
    </>
  );
}

describe('manual document IDs shared by Settings and onboarding', () => {
  it('converts a pasted Handshake link to its document ID and says so', async () => {
    await render(<Harness />);
    await type('Resume link or ID', 'https://app.joinhandshake.com/docs/12345678');
    expect(output().defaultResumeId).toBe('12345678');
    expect(control<HTMLInputElement>('Resume link or ID').value).toBe(
      'https://app.joinhandshake.com/docs/12345678',
    );
    expect(container.textContent).toContain('Saved as document ID 12345678');
  });

  it('accepts a bare ID without the conversion hint', async () => {
    await render(<Harness />);
    await type('Resume link or ID', '12345678');
    expect(output().defaultResumeId).toBe('12345678');
    expect(container.textContent).not.toContain('Saved as document ID');
  });

  it('shows an inline error for an invalid value and never stores it', async () => {
    await render(<Harness initial={{ autoSelectResume: true, defaultResumeId: 'old-id' }} />);
    await type('Resume link or ID', 'definitely not a document');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(DOCUMENT_ID_ERROR);
    // '' clears the saved ID; settings patches cross messaging, which drops undefined keys.
    expect(output().defaultResumeId).toBe('');
  });

  it('clears a stored ID when the field is emptied', async () => {
    await render(
      <Harness
        initial={{ autoSelectResume: false, defaultResumeId: 'old-id', coverLetterId: 'cover-1' }}
      />,
    );
    await type('Cover letter link or ID', '');
    expect(output().coverLetterId).toBe('');
    expect(output().defaultResumeId).toBe('old-id');
  });

  it('resyncs the raw text when the external value changes', async () => {
    await render(<Harness initial={{ autoSelectResume: false, defaultResumeId: 'first-id' }} />);
    await type('Resume link or ID', 'second-id');
    expect(output().defaultResumeId).toBe('second-id');
    await click('Reset');
    expect(control<HTMLInputElement>('Resume link or ID').value).toBe('first-id');
    expect(output().defaultResumeId).toBe('first-id');
  });

  it('adds rows up to the cap, disables the button, and removes a row', async () => {
    await render(<Harness />);
    for (let index = 1; index <= MAX_ADDITIONAL_RESUMES; index += 1) {
      await click('Add resume');
      expect(control<HTMLInputElement>(`Additional resume ${index} name`)).toBeDefined();
    }
    expect(container.textContent).toContain(`${MAX_ADDITIONAL_RESUMES} of 5`);
    expect(button('Add resume').disabled).toBe(true);

    await click('Remove additional resume 2');
    expect(container.textContent).toContain('4 of 5');
    expect(button('Add resume').disabled).toBe(false);
  });

  it('commits only complete additional resume rows', async () => {
    await render(<Harness />);
    await click('Add resume');
    await type('Additional resume 1 name', 'Backend resume');
    expect(output().additionalResumes).toEqual([]);

    await type('Additional resume 1 link or ID', 'https://app.joinhandshake.com/docs/555000111');
    expect(output().additionalResumes).toEqual([{ id: '555000111', name: 'Backend resume' }]);

    await type('Additional resume 1 name', '');
    expect(output().additionalResumes).toEqual([]);
    expect(container.textContent).toContain('Add a name for this resume.');
  });

  it('warns when the same document is used more than once', async () => {
    await render(<Harness initial={{ autoSelectResume: false, defaultResumeId: '15550001' }} />);
    await click('Add resume');
    await type('Additional resume 1 name', 'Duplicate');
    await type('Additional resume 1 link or ID', '15550001');
    expect(container.textContent).toContain('The same document is used more than once: 15550001');
  });

  it('hides the AI resume toggle when AI is off', async () => {
    await render(<Harness aiEnabled={false} />);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).toContain('AI is off. Your default resume is used for every job');
  });

  it('shows and updates the AI resume toggle when AI is enabled', async () => {
    await render(<Harness aiEnabled initial={{ autoSelectResume: true }} />);
    expect(container.textContent).toContain('Let AI pick the best resume for each job');
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle?.click());
    expect(output().autoSelectResume).toBe(false);
  });
});

function appValue(settings: Settings): AppContextValue {
  return {
    engine: makeEngineState(),
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: vi.fn(async () => null),
    start: vi.fn(async () => null),
    pause: vi.fn(async () => null),
    resume: vi.fn(async () => null),
    stop: vi.fn(async () => null),
    settings,
    settingsLoading: false,
    settingsError: null,
    refreshSettings: vi.fn(async () => null),
    saveSettings: vi.fn(async () => null),
    applySettings: vi.fn(),
    view: 'queue',
    navigate: vi.fn(),
    notify: vi.fn(),
    bridgeMode: 'mock',
    version: 'test',
  };
}

function jobSettings(): Settings {
  return makeSettings({
    documents: {
      defaultResumeId: '11110001',
      defaultResumeName: 'Backend resume',
      additionalResumes: [{ id: '11110002', name: 'Product resume' }],
      coverLetterId: '11110003',
      coverLetterName: 'General cover letter',
      autoSelectResume: true,
    },
  });
}

async function renderJob(selection?: DocumentSelection): Promise<void> {
  await render(
    <AppContext.Provider value={appValue(jobSettings())}>
      <JobDocumentChoices jobId="900001" selection={selection} onSaved={vi.fn(async () => null)} />
    </AppContext.Provider>,
  );
}

describe('per-job document overrides', () => {
  it('lists configured resumes plus an explicit "another resume" choice', async () => {
    await renderJob();
    const select = control<HTMLSelectElement>('Resume for this job');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Backend resume',
      'Product resume',
      'Another resume (enter ID)',
    ]);
    expect(container.querySelector('a')?.href).toBe('https://app.joinhandshake.com/stu/documents');
  });

  it('saves an empty cover letter as none for this job', async () => {
    vi.mocked(sendRequest).mockResolvedValue({
      ok: true,
      value: { jobId: '900001', status: 'queued' },
    });
    await renderJob();
    await type('Cover letter', '');
    await click('Save for this job');
    expect(sendRequest).toHaveBeenCalledWith({
      type: 'ui.queue.documents',
      jobId: '900001',
      documents: {
        resumeId: '11110001',
        coverLetterId: '',
        transcriptId: '',
        otherDocumentId: '',
      },
    });
  });

  it('keeps Save disabled while "another resume" is chosen but empty', async () => {
    await renderJob();
    await choose(control<HTMLSelectElement>('Resume for this job'), '__other__');
    expect(button('Save for this job').disabled).toBe(true);
    await type('Resume link or ID', '22220001');
    expect(button('Save for this job').disabled).toBe(false);
  });

  it('saves another resume entered by ID', async () => {
    vi.mocked(sendRequest).mockResolvedValue({
      ok: true,
      value: { jobId: '900001', status: 'queued' },
    });
    await renderJob();
    await choose(control<HTMLSelectElement>('Resume for this job'), '__other__');
    await type('Resume link or ID', 'https://app.joinhandshake.com/docs/22220001');
    await click('Save for this job');
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        documents: expect.objectContaining({ resumeId: '22220001' }),
      }),
    );
  });

  it('prefills the effective per-job choice and never saves an invalid ID', async () => {
    vi.mocked(sendRequest).mockResolvedValue({
      ok: true,
      value: { jobId: '900001', status: 'queued' },
    });
    await renderJob({ resumeId: '11110002', transcriptId: '11110004' });
    expect(control<HTMLInputElement>('Transcript')).toBeDefined();
    expect(control<HTMLInputElement>('Transcript').value).toBe('11110004');
    await type('Transcript', 'not a document link!');
    expect(control<HTMLInputElement>('Transcript').value).toBe('not a document link!');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(DOCUMENT_ID_ERROR);
    expect(button('Save for this job').disabled).toBe(true);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe('cleared document choices survive extension messaging', () => {
  it('keeps every cleared field as a JSON-visible value', () => {
    // runtime.sendMessage serializes like JSON: undefined keys vanish and the
    // background merge would then keep the old saved value.
    const cleared: Partial<Settings['documents']> = {
      defaultResumeId: '',
      defaultResumeName: '',
      coverLetterId: '',
      additionalResumes: [],
    };
    expect(JSON.parse(JSON.stringify(cleared))).toEqual(cleared);
    const merged = mergeSettings(
      {
        ...DEFAULT_SETTINGS,
        documents: {
          ...DEFAULT_SETTINGS.documents,
          defaultResumeId: 'old-id',
          coverLetterId: 'old-cover',
          additionalResumes: [{ id: 'old-extra', name: 'Old extra' }],
        },
      },
      { documents: JSON.parse(JSON.stringify(cleared)) as Partial<Settings['documents']> },
    );
    expect(merged.documents.defaultResumeId).toBe('');
    expect(merged.documents.coverLetterId).toBe('');
    expect(merged.documents.additionalResumes).toEqual([]);
    expect(configuredDocuments(merged.documents)).toEqual([]);
  });
});
