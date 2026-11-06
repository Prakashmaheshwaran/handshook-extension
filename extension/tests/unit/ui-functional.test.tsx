import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, mergeSettings, type Answer, type Settings } from '@/core/contracts';
import { ONE_CLICK_APPLY_REVIEW_REASON } from '@/core/documents/selection';
import {
  makeAnswer,
  makeEngineState,
  makeJob,
  makeQueueItem,
  makeSettings,
} from '@/test/factories';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { useAnswers } from '@/ui/hooks/useAnswers';
import { useNeeds } from '@/ui/hooks/useNeeds';
import { useOnboarding } from '@/ui/hooks/useOnboarding';
import { useAiStatus } from '@/ui/hooks/useAiStatus';
import { useDiagnostics } from '@/ui/hooks/useDiagnostics';
import { useQueue } from '@/ui/hooks/useQueue';
import { sendRequest } from '@/ui/bridge';
import { AnswersSection } from '@/ui/screens/Settings/AnswersSection';
import { AiSection } from '@/ui/screens/Settings/AiSection';
import { DataSection } from '@/ui/screens/Settings/DataSection';
import { AdvancedSection } from '@/ui/screens/Settings/AdvancedSection';
import { BetaSection } from '@/ui/screens/Settings/BetaSection';
import { SetupChecklist } from '@/ui/screens/Dashboard/SetupChecklist';
import { ReviewReadyCard } from '@/ui/screens/Dashboard/ReviewReadyCard';
import { RunModeNotice } from '@/ui/screens/Dashboard/RunModeNotice';
import { SearchSection } from '@/ui/screens/Settings/SearchSection';
import { NeedsYouScreen } from '@/ui/screens/NeedsYou/NeedsYouScreen';
import { OnboardingScreen } from '@/ui/screens/Onboarding/OnboardingScreen';
import { DashboardScreen } from '@/ui/screens/Dashboard/DashboardScreen';
import { DiagnosticsScreen } from '@/ui/screens/Diagnostics/DiagnosticsScreen';
import { QueueScreen } from '@/ui/screens/Queue/QueueScreen';
import { requestOpenRouterHostPermission } from '@/ui/screens/Settings/aiRuntime';

vi.mock('@/ui/hooks/useAnswers');
vi.mock('@/ui/hooks/useNeeds');
vi.mock('@/ui/hooks/useOnboarding');
vi.mock('@/ui/hooks/useAiStatus');
vi.mock('@/ui/hooks/useDiagnostics');
vi.mock('@/ui/hooks/useQueue');
vi.mock('@/ui/screens/Settings/aiRuntime', async (original) => ({
  ...(await original<typeof import('@/ui/screens/Settings/aiRuntime')>()),
  requestOpenRouterHostPermission: vi.fn(async () => 'granted'),
}));
vi.mock('@/ui/bridge', async (original) => ({
  ...(await original<typeof import('@/ui/bridge')>()),
  sendRequest: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let app: AppContextValue;
const saveAnswer = vi.fn(async (_answer: Answer) => null);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('granted');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  app = {
    engine: makeEngineState(),
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: vi.fn(async () => null),
    start: vi.fn(async () => null),
    pause: vi.fn(async () => null),
    resume: vi.fn(async () => null),
    stop: vi.fn(async () => null),
    settings: makeSettings(),
    settingsLoading: false,
    settingsError: null,
    refreshSettings: vi.fn(async () => null),
    saveSettings: vi.fn(async () => null),
    applySettings: vi.fn(),
    view: 'settings',
    navigate: vi.fn(),
    notify: vi.fn(),
    bridgeMode: 'mock',
    version: 'test',
  };
  vi.mocked(useAiStatus).mockReturnValue({
    status: null,
    error: null,
    loading: false,
    refresh: vi.fn(async () => null),
    saveKey: vi.fn(async () => null),
    clearKey: vi.fn(async () => null),
    test: vi.fn(async () => ({ provider: 'heuristic' as const, ok: true, message: 'Ready' })),
    loadModels: vi.fn(async () => ({ models: [], fetchedAt: 0 })),
    keyInfo: vi.fn(),
    dismissMigrationNotice: vi.fn(async () => null),
  });
  vi.mocked(useAnswers).mockReturnValue({
    answers: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    save: saveAnswer,
    remove: vi.fn(async () => null),
  });
  vi.mocked(useNeeds).mockReturnValue({
    needs: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    answer: vi.fn(async () => null),
    skip: vi.fn(async () => null),
  });
  vi.mocked(useOnboarding).mockReturnValue({
    onboarding: { version: 1, step: 'mode', sessionStatus: 'unknown' },
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    update: vi.fn(async () => null),
    complete: vi.fn(async () => null),
  });
  vi.mocked(useQueue).mockReturnValue({
    items: [],
    jobs: [],
    jobsById: new Map(),
    needs: [],
    summary: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    skip: vi.fn(async () => null),
    retry: vi.fn(async () => null),
    applyNow: vi.fn(async () => null),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(children: ReactNode): Promise<void> {
  await act(async () =>
    root.render(<AppContext.Provider value={app}>{children}</AppContext.Provider>),
  );
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === name || node.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function click(name: string): Promise<void> {
  await act(async () => button(name).click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function SearchHarness({ initial = makeSettings() }: { initial?: Settings }) {
  const [draft, setDraft] = useState(initial);
  return (
    <SearchSection draft={draft} onChange={(patch) => setDraft(mergeSettings(draft, patch))} />
  );
}

describe('UX-5 upgrade setup, mode clarity and beta controls', () => {
  it('offers setup again without resetting settings or data', async () => {
    await render(
      <AdvancedSection
        draft={makeSettings()}
        onChange={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onRunSetup={() => app.navigate('onboarding')}
      />,
    );
    await click('Run setup again');
    expect(app.navigate).toHaveBeenCalledWith('onboarding');
    expect(app.saveSettings).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('starts upgraded setup at welcome and prefills the original dry-run choice', async () => {
    vi.mocked(useOnboarding).mockReturnValue({
      ...useOnboarding(),
      onboarding: { version: 1, step: 'done', completedAt: 1 },
    });
    const settings = makeSettings({
      onboardingComplete: true,
      mode: 'dry_run',
      documents: { defaultResumeId: 'saved-resume' },
      search: {
        activeSearchId: undefined,
        savedSearches: [
          {
            id: 'saved-search',
            name: 'Saved search',
            url: 'https://app.joinhandshake.com/job-search',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    await render(
      <OnboardingScreen
        settings={settings}
        initialStep="welcome"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('Step 1 of 6');
    await click('Continue');
    await click('Continue');
    await click('Continue');
    expect(app.saveSettings).toHaveBeenCalledWith({
      documents: {
        defaultResumeId: 'saved-resume',
        autoSelectResume: settings.documents.autoSelectResume,
      },
    });
    await click('Continue');
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('Saved search');
    await click('Continue');
    expect(app.saveSettings).toHaveBeenLastCalledWith({
      search: {
        savedSearches: [expect.objectContaining({ id: 'saved-search', createdAt: 1 })],
        activeSearchId: 'saved-search',
      },
    });
    expect(container.querySelector<HTMLInputElement>('input[value="dry_run"]')?.checked).toBe(true);
    await click('Finish setup');
    expect(useOnboarding().complete).toHaveBeenCalledWith({
      mode: 'dry_run',
      reviewBeforeSubmit: settings.safety.reviewBeforeSubmit,
      allowOneClickApply: settings.safety.allowOneClickApply,
    });
    expect(sendRequest).not.toHaveBeenCalled();
    expect(useQueue().applyNow).not.toHaveBeenCalled();
  });

  it('lists each missing setup prerequisite and opens its specific step', async () => {
    app.settings = makeSettings({
      documents: { defaultResumeId: undefined },
      search: { savedSearches: [] },
    });
    await render(<SetupChecklist />);
    expect(container.textContent).toContain('Finish your setup');
    for (const [name, view] of [
      ['Check sign-in', 'setup-session'],
      ['Add search', 'setup-search'],
      ['Add resume', 'setup-documents'],
      ['Choose mode', 'setup-mode'],
    ]) {
      await click(name ?? '');
      expect(app.navigate).toHaveBeenLastCalledWith(view);
    }
  });

  it('hides the checklist when all prerequisites are ready and shows expired sign-in', async () => {
    app.settings = makeSettings({
      onboardingComplete: true,
      documents: { defaultResumeId: 'r1' },
      search: {
        savedSearches: [
          {
            id: 's1',
            name: 'Search',
            url: 'https://app.joinhandshake.com/job-search',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    vi.mocked(useOnboarding).mockReturnValue({
      ...useOnboarding(),
      onboarding: { version: 1, step: 'done', sessionStatus: 'logged_in' },
    });
    await render(<SetupChecklist />);
    expect(container.textContent).toBe('');
    app.engine = makeEngineState({ status: 'paused', pauseReason: 'auth_required' });
    await render(<SetupChecklist />);
    expect(button('Check sign-in')).toBeDefined();
    expect(container.textContent).toContain('Default resume added — Ready');
  });

  it.each([
    ['dry_run', 'idle', 'review', true],
    ['review', 'paused', 'dry_run', true],
    ['dry_run', 'running', 'autopilot', false],
    ['review', 'idle', 'dry_run', false],
  ] as const)(
    'shows dry-run notice for settings %s, engine %s/%s: %s',
    async (mode, status, engineMode, visible) => {
      await render(
        <RunModeNotice
          settings={makeSettings({ mode })}
          engine={makeEngineState({ status, mode: engineMode })}
        />,
      );
      expect(container.textContent?.includes('Dry run: nothing will be submitted')).toBe(visible);
    },
  );

  it('labels the dry-run Start action explicitly', async () => {
    app.settings = makeSettings({ mode: 'dry_run' });
    await render(<DashboardScreen />);
    await click('Start dry run (no submissions)');
    expect(app.start).toHaveBeenCalledWith('dry_run');
  });

  it('shows ready applications and focuses the existing current runner without applying again', async () => {
    const job = makeJob({ id: 'review-ready' });
    app.engine = makeEngineState({ status: 'needs_user', mode: 'review', currentJobId: job.id });
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: job.id, status: 'ready_for_review' })],
      jobs: [job],
      jobsById: new Map([[job.id, job]]),
    });
    vi.mocked(sendRequest).mockResolvedValue({ ok: true, value: { focused: true } });
    await render(<ReviewReadyCard />);
    expect(container.textContent).toContain(
      '1 application is ready for you to submit on Handshake',
    );
    expect(container.textContent).toContain(
      'You chose to review applications before submitting, so Handshook stops here and never clicks Submit for you.',
    );
    await click('Open job');
    expect(sendRequest).toHaveBeenCalledWith({ type: 'ui.runner.focus' });
    expect(useQueue().applyNow).not.toHaveBeenCalled();
    expect(useQueue().retry).not.toHaveBeenCalled();
  });

  it('shows the saved one-click reason even after the current engine job has cleared', async () => {
    const job = makeJob({ id: 'one-click-ready' });
    app.engine = makeEngineState({ status: 'needs_user', mode: 'review', currentJobId: undefined });
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: job.id, status: 'ready_for_review' })],
      jobsById: new Map([[job.id, job]]),
      needs: [
        {
          jobId: job.id,
          jobTitle: job.title,
          employer: job.employer,
          reason: 'review',
          message: ONE_CLICK_APPLY_REVIEW_REASON,
          questions: [],
          missingDocumentTypes: [],
          createdAt: 1,
        },
      ],
    });
    await render(<ReviewReadyCard />);
    expect(container.textContent).toContain(ONE_CLICK_APPLY_REVIEW_REASON);
    await click('Open job');
    expect(app.navigate).toHaveBeenCalledWith('needs');
    expect(useQueue().applyNow).not.toHaveBeenCalled();
    expect(useQueue().retry).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'excludes stale external rows from Review handoffs and their count (beta=%s)',
    async (collectExternalJobs) => {
      app.settings = makeSettings({ search: { collectExternalJobs } });
      const jobs = [
        makeJob({ id: 'internal-ready', title: 'Internal ready job', applyType: 'handshake_form' }),
        makeJob({ id: 'external-ready', title: 'External ready job', applyType: 'external' }),
        makeJob({ id: 'legacy-external', title: 'Legacy external job' }),
      ];
      const items = [
        makeQueueItem({ jobId: jobs[0]?.id, status: 'ready_for_review' }),
        makeQueueItem({ jobId: jobs[1]?.id, status: 'ready_for_review' }),
        makeQueueItem({
          jobId: jobs[2]?.id,
          status: 'ready_for_review',
          lastError: appError('EXTERNAL_APPLY', 'External posting'),
        }),
      ];
      vi.mocked(useQueue).mockReturnValue({
        ...useQueue(),
        items,
        jobs,
        jobsById: new Map(jobs.map((job) => [job.id, job])),
      });
      await render(<ReviewReadyCard />);
      expect(container.textContent).toContain(
        '1 application is ready for you to submit on Handshake',
      );
      expect(container.textContent).toContain('Internal ready job');
      expect(container.textContent).not.toContain('External ready job');
      expect(container.textContent).not.toContain('Legacy external job');
      vi.mocked(useQueue).mockReturnValue({ ...useQueue(), items: items.slice(1) });
      await render(<ReviewReadyCard />);
      expect(container.textContent).toBe('');
      expect(sendRequest).not.toHaveBeenCalled();
      expect(useQueue().applyNow).not.toHaveBeenCalled();
      expect(useQueue().retry).not.toHaveBeenCalled();
    },
  );

  it('routes an older ready application to Needs without focusing the wrong runner', async () => {
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: 'older', status: 'ready_for_review' })],
    });
    app.engine = makeEngineState({ currentJobId: 'newer' });
    await render(<ReviewReadyCard />);
    await click('Open job');
    expect(app.navigate).toHaveBeenCalledWith('needs');
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('handles a closed current review tab without replaying its application', async () => {
    app.engine = makeEngineState({ currentJobId: 'ready' });
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: 'ready', status: 'ready_for_review' })],
    });
    vi.mocked(sendRequest).mockResolvedValue({ ok: true, value: { focused: false } });
    await render(<ReviewReadyCard />);
    await click('Open job');
    expect(app.navigate).toHaveBeenCalledWith('needs');
    expect(app.notify).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('runner tab is closed'),
    );
    expect(useQueue().applyNow).not.toHaveBeenCalled();
  });

  it('describes active dry runs as previews and hides old Review handoff actions', async () => {
    app.engine = makeEngineState({ status: 'running', mode: 'dry_run' });
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: 'old-review', status: 'ready_for_review' })],
    });
    await render(<DashboardScreen />);
    expect(container.textContent).toContain(
      'Dry run is previewing the queue. Nothing will be submitted.',
    );
    expect(container.textContent).not.toContain('Each submit waits for your review.');
    expect(container.textContent).not.toContain('Open job');
  });

  it('keeps external job collection off by default and edits it independently of AI', async () => {
    const change = vi.fn();
    await render(<BetaSection draft={makeSettings()} onChange={change} />);
    const findToggle = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
        (node) =>
          document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent ===
          'Collect external job links (beta)',
      );
    const toggle = findToggle();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle?.click());
    expect(change).toHaveBeenLastCalledWith({ search: { collectExternalJobs: true } });
    await render(
      <BetaSection
        draft={makeSettings({ search: { collectExternalJobs: true } })}
        onChange={change}
      />,
    );
    await act(async () => findToggle()?.click());
    expect(change).toHaveBeenLastCalledWith({ search: { collectExternalJobs: false } });
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe('HX-08 settings inputs and confirmations', () => {
  it('describes the sensitive-answer opt-in without promising all submissions remain manual', async () => {
    await render(<NeedsYouScreen />);
    expect(container.textContent).toContain('Sensitive answers need your explicit permission');
    expect(container.textContent).not.toContain('Sensitive answers always wait');
  });

  it.each(['Include keywords', 'Exclude keywords', 'Locations', 'Employment types'])(
    'keeps delimiters and spaces while typing multiple values in %s',
    async (label) => {
      await render(<SearchHarness />);
      const labelNode = Array.from(container.querySelectorAll('label')).find(
        (node) => node.textContent === label,
      );
      const input = document.getElementById(labelNode?.htmlFor ?? '') as HTMLInputElement;
      await type(input, '');
      for (const character of 'data, New York') await type(input, input.value + character);
      expect(input.value).toBe('data, New York');
    },
  );

  it('requires confirmation before removing a saved search', async () => {
    await render(
      <SearchHarness
        initial={makeSettings({
          search: {
            savedSearches: [
              {
                id: 'search-test',
                name: 'Internships',
                url: 'https://app.joinhandshake.com/job-search',
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        })}
      />,
    );
    await click('Remove Internships');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await click('Cancel');
    expect(button('Remove Internships')).toBeDefined();
    await click('Remove Internships');
    await click('Remove search');
    expect(container.textContent).toContain('No saved searches yet');
  });

  it('disables reset until confirmation text is valid and keeps focus while typing', async () => {
    await render(<DataSection />);
    await click('Reset local data');
    const dialog = container.querySelector('[role="dialog"]');
    const input = dialog?.querySelector('input');
    expect(input).toBeTruthy();
    const confirm = dialog?.querySelector<HTMLButtonElement>('button:last-child');
    expect(confirm?.disabled).toBe(true);
    input?.focus();
    if (!input) throw new Error('Missing reset input');
    for (const character of 'reset') {
      await type(input, input.value + character);
      expect(document.activeElement).toBe(input);
    }
    expect(confirm?.disabled).toBe(false);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('traps reverse Tab from the dialog container and restores trigger focus', async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open dialog</button>
          <ConfirmDialog
            open={open}
            title="Confirm action"
            onCancel={() => setOpen(false)}
            onConfirm={() => undefined}
          />
        </>
      );
    }
    await render(<DialogHarness />);
    button('Open dialog').focus();
    await click('Open dialog');
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button('Confirm'));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.activeElement).toBe(button('Open dialog'));
  });
});

describe('HX-08 saved answer editor', () => {
  function setAnswer(answer: Answer): void {
    vi.mocked(useAnswers).mockReturnValue({ ...useAnswers(), answers: [answer] });
  }

  it('preserves every checkbox choice when changing approval', async () => {
    setAnswer(
      makeAnswer({
        type: 'checkbox',
        value: ['sql', 'python'],
        options: { SQL: 'sql', Python: 'python' },
      }),
    );
    await render(<AnswersSection />);
    await click('Edit');
    const choices = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(choices.map((choice) => choice.checked)).toEqual([true, true]);
    await click('Save');
    expect(saveAnswer).toHaveBeenCalledWith(expect.objectContaining({ value: ['sql', 'python'] }));
  });

  it('edits a boolean checkbox without converting it to text', async () => {
    setAnswer(makeAnswer({ type: 'checkbox', value: false }));
    await render(<AnswersSection />);
    await click('Edit');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => checkbox?.click());
    await click('Save');
    expect(saveAnswer).toHaveBeenCalledWith(expect.objectContaining({ value: true }));
  });

  it('rejects an empty numeric answer and saves zero as a number', async () => {
    setAnswer(makeAnswer({ type: 'number', value: 3.5 }));
    await render(<AnswersSection />);
    await click('Edit');
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error('Missing numeric input');
    await type(input, '');
    await click('Save');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid number.');
    expect(saveAnswer).not.toHaveBeenCalled();
    await type(input, '0');
    await click('Save');
    expect(saveAnswer).toHaveBeenCalledWith(expect.objectContaining({ value: 0 }));
  });

  it('keeps the delete confirmation open when deleting an answer fails', async () => {
    const answer = makeAnswer({ label: 'Sample answer' });
    setAnswer(answer);
    vi.mocked(useAnswers).mockReturnValue({
      ...useAnswers(),
      remove: vi.fn(async () => appError('UNKNOWN', 'Could not delete')),
    });
    await render(<AnswersSection />);
    await click('Delete answer Sample answer');
    await click('Delete answer');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(app.notify).toHaveBeenCalledWith('error', 'Could not delete');
  });
});

describe('HX-08 recovery paths', () => {
  it('shows the exact document-selection failure on a document resolution card', async () => {
    vi.mocked(useNeeds).mockReturnValue({
      ...useNeeds(),
      needs: [
        {
          jobId: '10000001',
          jobTitle: 'Example role',
          employer: 'Example employer',
          reason: 'documents',
          questions: [],
          missingDocumentTypes: ['resume'],
          createdAt: 1,
          message: 'The chosen resume was not found on Handshake.',
        },
      ],
    });
    await render(<NeedsYouScreen />);
    expect(container.textContent).toContain('The chosen resume was not found on Handshake.');
    expect(button('Save documents & continue')).toBeDefined();
  });
  it.each(['auth', 'challenge', 'ui_changed'] as const)(
    'provides a relevant recovery action for %s',
    async (reason) => {
      vi.mocked(useNeeds).mockReturnValue({
        ...useNeeds(),
        needs: [
          {
            jobId: '10000001',
            jobTitle: 'Example role',
            employer: 'Example employer',
            reason,
            questions: [],
            missingDocumentTypes: [],
            createdAt: 1,
          },
        ],
      });
      await render(<NeedsYouScreen />);
      expect(container.textContent).not.toContain('I added the document');
      expect(
        container.querySelector('a[href="https://app.joinhandshake.com/jobs/10000001"]'),
      ).not.toBeNull();
      if (reason === 'ui_changed') {
        expect(container.textContent).toContain('Retry here or from Queue');
        expect(container.textContent).not.toContain('Skip job');
        vi.mocked(sendRequest).mockResolvedValue({
          ok: true,
          value: { jobId: '10000001', status: 'queued' },
        });
        await click('Retry job');
        expect(sendRequest).toHaveBeenCalledWith({ type: 'ui.queue.retry', jobId: '10000001' });
        expect(app.notify).toHaveBeenCalledWith('success', 'Queued to retry.');
        await click('Open diagnostics');
        expect(app.navigate).toHaveBeenCalledWith('diagnostics');
      } else {
        expect(button('Resume run')).toBeDefined();
      }
    },
  );

  it('explains when a review tab was closed instead of silently doing nothing', async () => {
    vi.mocked(useNeeds).mockReturnValue({
      ...useNeeds(),
      needs: [
        {
          jobId: '10000001',
          jobTitle: 'Example role',
          employer: 'Example employer',
          reason: 'review',
          questions: [],
          missingDocumentTypes: [],
          createdAt: 1,
        },
      ],
    });
    vi.mocked(sendRequest).mockResolvedValue({ ok: true, value: { focused: false } });
    await render(<NeedsYouScreen />);
    expect(container.textContent).toContain('check My Jobs');
    expect(container.textContent).toContain('Skipping does not withdraw an application');
    await click('Open review tab');
    expect(app.notify).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('runner tab is closed'),
    );
  });

  it('explains a refused Resume without telling the user to reload an unfinished form', async () => {
    app.engine = makeEngineState({ status: 'needs_user' });
    vi.mocked(app.resume).mockResolvedValue({
      state: null,
      error: appError(
        'UNKNOWN',
        'Stop the run and finish any pending review before refreshing the runner.',
      ),
    });
    await render(<DashboardScreen />);
    await click('Resume');
    expect(app.notify).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('finish or skip the pending application in Needs you'),
    );
  });

  it('shows a capped run as finished, with no Resume or Stop left to press', async () => {
    app.engine = makeEngineState({
      status: 'idle',
      todayCount: 25,
      dailyCap: 25,
      message: 'Daily cap reached (25/25). Run finished; start again after local midnight.',
    });
    await render(<DashboardScreen />);
    expect(container.textContent).toContain('Run finished');
    expect(container.textContent).toContain('Start again after local midnight');
    expect(container.textContent).not.toContain('Resume');
    expect(
      [...container.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Stop'),
    ).toBe(false);
  });

  it('shows a user pause instead of stale scanning progress, preserving safety explanations', async () => {
    app.engine = makeEngineState({
      status: 'paused',
      pauseReason: 'user',
      message: 'Scanning saved searches',
    });
    await render(<DashboardScreen />);
    expect(container.textContent).toContain('Paused by you. Resume when ready.');
    expect(container.textContent).not.toContain('Scanning saved searches');
    app.engine = {
      ...app.engine,
      message: 'The school changed. Return to the queued job.',
      lastError: appError('CANCELLED', 'The school changed.'),
    };
    await render(<DashboardScreen />);
    expect(container.textContent).toContain('The school changed. Return to the queued job.');
  });

  it('finishes setup without a resume instead of blocking on a confirm dialog', async () => {
    await render(<OnboardingScreen settings={makeSettings()} onDone={vi.fn()} />);
    await click('Finish setup');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(useOnboarding().complete).toHaveBeenCalled();
  });

  it('continues setup without work authorization or graduation answers and never starts a run', async () => {
    vi.mocked(useOnboarding).mockReturnValue({
      ...useOnboarding(),
      onboarding: { version: 1, step: 'answers', sessionStatus: 'logged_in' },
    });
    await render(<OnboardingScreen settings={makeSettings()} onDone={vi.fn()} />);
    expect(container.textContent).toContain('You can add answers later');
    await click('Continue');
    expect(container.textContent).toContain('Your saved search');
    expect(saveAnswer.mock.calls.map(([answer]) => answer.id)).not.toContain('work_authorization');
    expect(saveAnswer.mock.calls.map(([answer]) => answer.id)).not.toContain('graduation_date');
    // Full automation: answers entered in setup are used without a per-job approval.
    expect(saveAnswer.mock.calls.every(([answer]) => answer.autoSubmitAllowed)).toBe(true);
    expect(app.start).not.toHaveBeenCalled();
    expect(app.saveSettings).not.toHaveBeenCalled();
  });

  it('preserves an entered setup answer without granting auto-submit approval', async () => {
    vi.mocked(useOnboarding).mockReturnValue({
      ...useOnboarding(),
      onboarding: { version: 1, step: 'answers', sessionStatus: 'logged_in' },
    });
    const answer = makeAnswer({
      id: 'graduation_date',
      value: '2027-05-15',
      autoSubmitAllowed: false,
    });
    vi.mocked(useAnswers).mockReturnValue({ ...useAnswers(), answers: [answer] });
    await render(<OnboardingScreen settings={makeSettings()} onDone={vi.fn()} />);
    await click('Continue');
    expect(saveAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'graduation_date',
        value: '2027-05-15',
        autoSubmitAllowed: false,
      }),
    );
    expect(container.textContent).toContain('Your saved search');
    expect(app.start).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'lets setup continue without a resume and explains jobs will wait (upgraded=%s)',
    async (onboardingComplete) => {
      vi.mocked(useOnboarding).mockReturnValue({
        ...useOnboarding(),
        onboarding: { version: 1, step: 'documents', sessionStatus: 'unknown' },
      });
      await render(
        <OnboardingScreen settings={makeSettings({ onboardingComplete })} onDone={vi.fn()} />,
      );
      expect(container.textContent).toContain(
        'Jobs will wait in Needs You until you add a resume.',
      );
      await click('Continue');
      expect(app.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          documents: expect.objectContaining({ autoSelectResume: true }),
        }),
      );
      expect(useOnboarding().complete).not.toHaveBeenCalled();
    },
  );

  it('points users without a default resume to document setup from the dashboard', async () => {
    await render(<DashboardScreen />);
    await click('Add resume');
    expect(app.navigate).toHaveBeenCalledWith('setup-documents');
  });

  it('explains that verifying jobs need a status check on Handshake', async () => {
    const job = makeJob();
    vi.mocked(useQueue).mockReturnValue({
      ...useQueue(),
      items: [makeQueueItem({ jobId: job.id, status: 'verifying' })],
      jobsById: new Map([[job.id, job]]),
    });
    await render(<QueueScreen />);
    expect(container.textContent).toContain(
      'Submission not yet confirmed. Open the posting on Handshake',
    );
    expect(container.textContent).not.toContain('Apply now');
  });

  it('shows a warning when a diagnostics refresh fails with cached data', async () => {
    vi.mocked(useDiagnostics).mockReturnValue({
      diagnostics: {
        version: '1',
        protocolVersion: 1,
        generatedAt: 1,
        mode: 'review',
        host: 'app.joinhandshake.com',
        storage: { ok: true, name: 'test', detail: 'local' },
        counts: { events: 0, answers: 0, documents: 0 },
        selectors: [],
        recentErrors: [],
        queue: { total: 0, todayCount: 0, dailyCap: 25, remainingToday: 25, counts: {} },
      },
      error: appError('UNKNOWN', 'Background unavailable'),
      loading: false,
      refresh: vi.fn(async () => null),
      clear: vi.fn(async () => null),
      exportBundle: vi.fn(async () => ({ payload: null, error: null })),
    });
    await render(<DiagnosticsScreen />);
    expect(container.textContent).toContain('Showing the last loaded diagnostics');
    expect(container.textContent).toContain('Refresh failed');
  });
});

describe('FX-01 selector-recovery control', () => {
  it.each(['UI_CHANGED', 'JOB_CLOSED', 'FORBIDDEN'] as const)(
    'offers blocked-job retry only for a selector change: %s',
    async (code) => {
      const job = makeJob();
      const retry = vi.fn(async () => null);
      vi.mocked(useQueue).mockReturnValue({
        ...useQueue(),
        items: [
          makeQueueItem({ status: 'blocked', lastError: appError(code, 'Page unavailable') }),
        ],
        jobs: [job],
        jobsById: new Map([[job.id, job]]),
        retry,
      });
      await render(<QueueScreen />);
      if (code === 'UI_CHANGED') {
        await click('Retry');
        expect(retry).toHaveBeenCalledWith(job.id);
      } else {
        expect(
          Array.from(container.querySelectorAll('button')).some(
            (node) => node.textContent?.trim() === 'Retry',
          ),
        ).toBe(false);
        expect(retry).not.toHaveBeenCalled();
      }
    },
  );
});

describe('HX-08 AI provider status', () => {
  it('shows cloud migration and actionable provider status on the Dashboard', async () => {
    vi.mocked(useAiStatus).mockReturnValue({
      ...useAiStatus(),
      status: {
        enabled: true,
        provider: 'openrouter',
        openRouterConfigured: false,
        openRouterPermission: 'not_granted',
        geminiReplacedNotice: true,
        openRouterMessage: 'Add an OpenRouter key to continue cloud matching.',
      },
    });
    await render(<DashboardScreen />);
    expect(container.textContent).toContain('Cloud matching setup changed');
    expect(container.textContent).toContain('Add an OpenRouter key to continue cloud matching.');
    await click('Set up OpenRouter');
    expect(app.navigate).toHaveBeenCalledWith('settings');
  });
  it('renders optional OpenRouter fallback status and confirms key removal', async () => {
    const clearKey = vi.fn(async () => null);
    const status = {
      enabled: true,
      provider: 'auto' as const,
      openRouterConfigured: true,
      openRouterPermission: 'granted' as const,
      geminiReplacedNotice: false,
      openRouterMessage: 'OpenRouter model unavailable — using basic matching',
    };
    app.bridgeMode = 'live';
    vi.mocked(useAiStatus).mockReturnValue({
      ...useAiStatus(),
      status,
      error: null,
      loading: false,
      refresh: vi.fn(async () => null),
      saveKey: vi.fn(async () => null),
      clearKey,
      test: vi.fn(async () => ({ provider: 'heuristic' as const, ok: true, message: 'Ready' })),
    });
    await render(<AiSection draft={makeSettings()} onChange={vi.fn()} />);
    expect(container.textContent).toContain(status.openRouterMessage);
    expect(container.textContent).toContain('resume names and IDs');
    expect(container.textContent).toContain('Document files and saved answers are not sent to AI');
    expect(container.textContent).toContain(
      'Filling forms shares answers and selected document references with Handshake',
    );
    expect(container.textContent).not.toContain('nothing else');
    expect(container.textContent).not.toContain('No AI key, cookie, or answer ever leaves');
    await click('Remove key');
    expect(clearKey).not.toHaveBeenCalled();
    const confirm = container.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child');
    await act(async () => confirm?.click());
    expect(clearKey).toHaveBeenCalledOnce();
  });
  it.each([
    [true, 'openrouter'],
    [false, 'heuristic'],
  ] as const)(
    'tests the effective Auto provider with OpenRouter %s',
    async (openRouterConfigured, expected) => {
      const testProvider = vi.fn(async () => ({ provider: expected, ok: true, message: 'Ready' }));
      app.bridgeMode = 'live';
      app.settings = makeSettings({
        ai: {
          enabled: true,
          provider: 'auto',
          openRouter: { ...makeSettings().ai.openRouter, model: 'demo/model' },
        },
      });
      vi.mocked(useAiStatus).mockReturnValue({
        ...useAiStatus(),
        status: {
          openRouterConfigured,
          openRouterPermission: 'granted',
          geminiReplacedNotice: false,
          enabled: true,
          provider: 'auto',
        },
        error: null,
        loading: false,
        refresh: vi.fn(async () => null),
        saveKey: vi.fn(async () => null),
        clearKey: vi.fn(async () => null),
        test: testProvider,
      });
      await render(<AiSection draft={app.settings} onChange={vi.fn()} />);
      await click('Test provider');
      expect(testProvider).toHaveBeenCalledWith(expected);
      if (expected === 'openrouter') {
        expect(requestOpenRouterHostPermission).toHaveBeenCalledOnce();
        expect(vi.mocked(requestOpenRouterHostPermission).mock.invocationCallOrder[0]).toBeLessThan(
          testProvider.mock.invocationCallOrder[0] ?? 0,
        );
      } else {
        expect(requestOpenRouterHostPermission).not.toHaveBeenCalled();
      }

      if (expected === 'openrouter') {
        testProvider.mockClear();
        vi.mocked(requestOpenRouterHostPermission).mockResolvedValue('denied');
        await click('Test provider');
        expect(testProvider).not.toHaveBeenCalled();
        expect(container.textContent).toContain('No request was sent.');
      }
    },
  );
});

describe('AI page assist and automation defaults', () => {
  function switchFor(text: string): HTMLButtonElement {
    const match = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
      (button) => {
        const labelId = button.getAttribute('aria-labelledby');
        const label = labelId ? document.getElementById(labelId) : null;
        return label?.textContent?.includes(text) ?? false;
      },
    );
    if (!match) throw new Error(`Missing switch: ${text}`);
    return match;
  }

  it('defaults AI matching, page assist and full automation on', async () => {
    const settings = makeSettings();
    expect(settings.mode).toBe('autopilot');
    expect(settings.ai).toMatchObject({ enabled: true, pageAssist: true });
    expect(settings.safety.allowOneClickApply).toBe(true);

    await render(<AiSection draft={settings} onChange={vi.fn()} />);
    const toggle = switchFor('Let AI find buttons and fields');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('explains exactly what page assist sends and never sends', async () => {
    await render(<AiSection draft={makeSettings()} onChange={vi.fn()} />);
    expect(container.textContent).toContain(
      'Let AI find buttons and fields when Handshake changes its page',
    );
    expect(container.textContent).toContain(
      "Sends only the labels, roles and a few attribute names of the page's buttons and fields to OpenRouter",
    );
    expect(container.textContent).toContain('never answers, document contents or form values');
    expect(container.textContent).toContain('only when an OpenRouter key and permission are set');
  });

  it('turns page assist off through ai.pageAssist', async () => {
    const change = vi.fn();
    await render(<AiSection draft={makeSettings()} onChange={change} />);
    const toggle = switchFor('Let AI find buttons and fields');
    await act(async () => toggle.click());
    expect(change).toHaveBeenCalledWith({ ai: { pageAssist: false } });
  });

  it('marks DeepSeek V4.1 Flash as preselected and makes the missing key prominent', async () => {
    vi.mocked(useAiStatus).mockReturnValue({
      ...useAiStatus(),
      status: {
        enabled: true,
        provider: 'auto',
        openRouterConfigured: false,
        openRouterPermission: 'not_granted',
        geminiReplacedNotice: false,
      },
    });
    await render(<AiSection draft={makeSettings()} onChange={vi.fn()} />);
    expect(container.textContent).toContain('DeepSeek V4.1 Flash preselected');
    expect(container.textContent).toContain('deepseek/deepseek-v4.1-flash');
    expect(container.textContent).toContain('Add your OpenRouter key to turn AI on');
    expect(container.textContent).toContain('AI matching and page assist both need your own');
  });
});
