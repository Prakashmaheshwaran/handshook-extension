import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEngineState, makeJob, makeQueueItem, makeSettings } from '@/test/factories';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { useQueue } from '@/ui/hooks/useQueue';
import { QueueScreen } from '@/ui/screens/Queue/QueueScreen';

vi.mock('@/ui/hooks/useQueue');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let app: AppContextValue;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  app = {
    engine: makeEngineState(),
    engineLoading: false,
    engineError: null,
    enginePending: null,
    refreshEngine: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    settings: makeSettings(),
    settingsLoading: false,
    settingsError: null,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn(),
    applySettings: vi.fn(),
    view: 'queue',
    navigate: vi.fn(),
    notify: vi.fn(),
    bridgeMode: 'mock',
    version: 'test',
  };
  const jobs = [
    makeJob({ title: 'Internal role' }),
    makeJob(
      {
        title: 'External role',
        employer: 'Employer example',
        applyType: 'external',
        externalUrl: 'https://careers.example.test/apply',
      },
      2,
    ),
  ];
  vi.mocked(useQueue).mockReturnValue({
    items: [makeQueueItem(), makeQueueItem({ status: 'external' }, 2)],
    jobs,
    jobsById: new Map(jobs.map((job) => [job.id, job])),
    needs: [],
    summary: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
    retry: vi.fn(async () => null),
    skip: vi.fn(async () => null),
    applyNow: vi.fn(async () => null),
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <AppContext.Provider value={app}>
        <QueueScreen />
      </AppContext.Provider>,
    ),
  );
}
async function externalFilter() {
  const select = container.querySelector('select');
  if (!select) throw new Error('Queue filter missing');
  await act(async () => {
    select.value = 'external';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('hides external rows and their count by default, even if a stale payload contains them', async () => {
  await render();
  expect(container.textContent).toContain('Internal role');
  expect(container.textContent).not.toContain('External role');
  expect(container.textContent).not.toContain('External links (beta)');
  expect(container.textContent).toContain('Showing 1 of 1');
});

it('keeps beta links separate and exposes only safe manual opening and dismiss', async () => {
  app.settings = makeSettings({ search: { collectExternalJobs: true } });
  await render();
  expect(container.textContent).not.toContain('External role');
  await externalFilter();
  expect(container.textContent).toContain('External role');
  expect(container.textContent).not.toContain('Internal role');
  expect(container.textContent).toContain('Showing 1 of 1');
  expect(container.textContent).not.toContain('Fit ');
  const link = Array.from(container.querySelectorAll('a')).find((el) =>
    el.textContent?.includes('Open on employer site'),
  );
  expect(link?.href).toBe('https://careers.example.test/apply');
  expect(link?.target).toBe('_blank');
  expect(link?.rel).toContain('noopener');
  expect(link?.rel).toContain('noreferrer');
  const buttons = Array.from(container.querySelectorAll('button'));
  expect(
    buttons.some((el) => ['Apply now', 'Retry', 'Skip'].includes(el.textContent?.trim() ?? '')),
  ).toBe(false);
  const dismiss = buttons.find((el) => el.textContent?.trim() === 'Dismiss');
  if (!dismiss) throw new Error('Dismiss missing');
  await act(async () => dismiss.click());
  expect(useQueue().skip).toHaveBeenCalledWith('900002', 'Dismiss external link');
  expect(useQueue().applyNow).not.toHaveBeenCalled();
});

it('hides the beta list immediately when collection is disabled', async () => {
  app.settings = makeSettings({ search: { collectExternalJobs: true } });
  await render();
  await externalFilter();
  app.settings = makeSettings();
  await render();
  expect(container.textContent).not.toContain('External role');
  expect(container.textContent).toContain('Internal role');
});

it.each([
  'javascript:alert(1)',
  'data:text/html,unsafe',
  'https://user:password@example.test/apply',
])('does not render an unsafe employer URL: %s', async (externalUrl) => {
  const queue = useQueue();
  const job = makeJob({ title: 'External role', applyType: 'external', externalUrl }, 2);
  vi.mocked(useQueue).mockReturnValue({ ...queue, jobsById: new Map([[job.id, job]]) });
  app.settings = makeSettings({ search: { collectExternalJobs: true } });
  await render();
  await externalFilter();
  expect(container.textContent).not.toContain('Open on employer site');
  expect(container.querySelector('a')?.href).toBe(job.url);
});
