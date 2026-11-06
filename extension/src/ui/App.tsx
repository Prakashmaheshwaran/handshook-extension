import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { getExtensionVersion, isBroadcast, subscribeToBroadcasts } from '@/ui/bridge';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { ErrorState } from '@/ui/components/ErrorState';
import { Spinner } from '@/ui/components/Spinner';
import { EngineStatusBadge } from '@/ui/components/StatusBadge';
import { ToastViewport } from '@/ui/components/Toast';
import { ICONS } from '@/ui/components/icons';
import { AppContext, type AppContextValue } from '@/ui/hooks/useAppContext';
import { useBridge } from '@/ui/hooks/useBridge';
import { useEngineState } from '@/ui/hooks/useEngineState';
import { useSettings } from '@/ui/hooks/useSettings';
import { useToasts } from '@/ui/hooks/useToasts';
import { NAV_ITEMS, VIEW_META, setupStep, type View } from '@/ui/router';
import { RunModeNotice, displayedRunMode } from '@/ui/screens/Dashboard/RunModeNotice';
import { ReviewReadyCard } from '@/ui/screens/Dashboard/ReviewReadyCard';
import { DashboardScreen } from '@/ui/screens/Dashboard/DashboardScreen';
import { OnboardingScreen } from '@/ui/screens/Onboarding/OnboardingScreen';

// The dashboard is the first screen and stays in the initial chunk. Every
// other screen is loaded on first visit so the side panel opens quickly.
const ActivityScreen = lazy(async () => {
  const module = await import('@/ui/screens/Activity/ActivityScreen');
  return { default: module.ActivityScreen };
});
const DiagnosticsScreen = lazy(async () => {
  const module = await import('@/ui/screens/Diagnostics/DiagnosticsScreen');
  return { default: module.DiagnosticsScreen };
});
const NeedsYouScreen = lazy(async () => {
  const module = await import('@/ui/screens/NeedsYou/NeedsYouScreen');
  return { default: module.NeedsYouScreen };
});
const QueueScreen = lazy(async () => {
  const module = await import('@/ui/screens/Queue/QueueScreen');
  return { default: module.QueueScreen };
});
const SettingsScreen = lazy(async () => {
  const module = await import('@/ui/screens/Settings/SettingsScreen');
  return { default: module.SettingsScreen };
});

function Splash({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-muted">
      <Spinner size={18} />
      <span className="text-[12px]">{label}</span>
    </div>
  );
}

/**
 * Production builds must not fall back to demo data. If the background cannot
 * be reached, block the panel and ask for a reload instead of showing seeded
 * jobs (and never let Start run against a store that is not real).
 */
function BackgroundUnavailable() {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div
        role="alert"
        className="w-full max-w-[420px] rounded-panel border border-danger/35 bg-danger-soft p-4 text-danger"
      >
        <h2 className="text-[14px] font-semibold">Background not responding</h2>
        <p className="mt-1 text-[12px] leading-snug">
          The extension’s background service did not answer, so Handshook cannot read or run your
          queue. Reload the extension, then try again. Start stays disabled until it responds.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => window.location.reload()}
        >
          Reload extension
        </Button>
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const engine = useEngineState();
  const settings = useSettings();
  const { toasts, notify, dismiss } = useToasts();
  const bridge = useBridge();
  const version = useMemo(() => getExtensionVersion(), []);
  const mainRef = useRef<HTMLElement | null>(null);

  const navigate = useCallback((next: View) => {
    setView(next);
  }, []);

  useEffect(() => {
    const node = mainRef.current;
    if (!node) return;
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior: 'auto' });
    else node.scrollTop = 0;
  }, [view]);

  // Toast broadcasts from the background.
  useEffect(
    () =>
      subscribeToBroadcasts((message) => {
        if (isBroadcast(message) && message.type === 'toast') {
          notify(message.level, message.message);
        }
      }),
    [notify],
  );

  // Theme: system by default, explicit override from settings.
  const theme = settings.settings?.ui.theme ?? 'system';
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }
  }, [theme]);

  const current = settings.settings;
  const contextValue: AppContextValue = {
    engine: engine.state,
    engineLoading: engine.loading,
    engineError: engine.error,
    enginePending: engine.pending,
    refreshEngine: engine.refresh,
    start: engine.start,
    pause: engine.pause,
    resume: engine.resume,
    stop: engine.stop,
    settings: current,
    settingsLoading: settings.loading,
    settingsError: settings.error,
    refreshSettings: settings.refresh,
    saveSettings: settings.save,
    applySettings: settings.setSettings,
    view,
    navigate,
    notify,
    bridgeMode: bridge.mode,
    version,
  };

  const setupStart = setupStep(view);
  const showOnboarding = current !== null && (!current.onboardingComplete || !!setupStart);

  let body: ReactElement;
  if (bridge.mode === 'unavailable') {
    body = <BackgroundUnavailable />;
  } else if (bridge.mode === null) {
    body = <Splash label="Connecting to Handshook" />;
  } else if (!current) {
    if (settings.error) {
      body = (
        <div className="flex h-full items-center justify-center p-4">
          <ErrorState
            error={settings.error}
            title="Cannot load Handshook settings"
            onRetry={() => void settings.refresh()}
          />
        </div>
      );
    } else {
      body = <Splash label="Loading Handshook" />;
    }
  } else if (showOnboarding) {
    body = (
      <div className="hs-scroll h-full overflow-y-auto bg-bg">
        <OnboardingScreen
          settings={current}
          initialStep={setupStart}
          onDone={() => navigate('dashboard')}
          onCancel={current.onboardingComplete ? () => navigate('dashboard') : undefined}
        />
      </div>
    );
  } else {
    const meta = VIEW_META[view] ?? VIEW_META.dashboard;
    const today = engine.state?.todayCount ?? 0;
    const cap = engine.state?.dailyCap ?? current.pacing.dailyCap;
    const liveMessage = engine.state
      ? `${engine.state.status}${engine.state.message ? `. ${engine.state.message}` : ''}`
      : '';

    let screen: ReactElement;
    switch (view) {
      case 'queue':
        screen = <QueueScreen />;
        break;
      case 'needs':
        screen = <NeedsYouScreen />;
        break;
      case 'activity':
        screen = <ActivityScreen />;
        break;
      case 'settings':
        screen = <SettingsScreen />;
        break;
      case 'diagnostics':
        screen = <DiagnosticsScreen />;
        break;
      default:
        screen = <DashboardScreen />;
    }

    body = (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-accent-ink"
              >
                H
              </span>
              <p className="text-[13px] font-semibold leading-tight tracking-tight text-ink">
                Handshook
              </p>
            </div>
            <p className="mt-0.5 truncate text-[10.5px] text-muted">{current.host}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {bridge.mode === 'mock' ? (
              <span title="Seeded demo data — no extension background is running">
                <Badge tone="info">Demo</Badge>
              </span>
            ) : null}
            {engine.state ? (
              <EngineStatusBadge status={engine.state.status} />
            ) : (
              <Badge tone="neutral">Connecting</Badge>
            )}
          </div>
        </header>

        <nav aria-label="Sections" className="shrink-0 border-b border-line bg-surface px-1.5 py-1">
          <ul className="grid grid-cols-5 gap-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = ICONS[item.icon];
              const active = view === item.view;
              const attention =
                item.needsAttention === true &&
                (engine.state?.status === 'needs_user' ||
                  engine.state?.pauseReason === 'auth_required');
              return (
                <li key={item.view} className="min-w-0">
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => navigate(item.view)}
                    className={[
                      'flex w-full flex-col items-center gap-0.5 rounded-lg px-0.5 py-1 transition-colors',
                      active
                        ? 'bg-accent-soft text-accent'
                        : 'text-muted hover:bg-surface-2 hover:text-ink',
                    ].join(' ')}
                  >
                    <span className="relative">
                      <Icon size={16} />
                      {attention ? (
                        <span
                          aria-hidden="true"
                          className="absolute -right-1 -top-1 size-1.5 rounded-full bg-warn ring-2 ring-surface"
                        />
                      ) : null}
                    </span>
                    <span className="w-full truncate text-center text-[10px] font-medium leading-tight">
                      {item.label}
                    </span>
                    {attention ? <span className="sr-only">Needs your attention</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {view === 'dashboard' || view === 'queue' ? (
          <RunModeNotice settings={current} engine={engine.state} />
        ) : null}

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          aria-labelledby="view-title"
          className="hs-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3"
        >
          <div className="mb-2.5">
            <h1 id="view-title" className="text-[15px] font-semibold leading-tight text-ink">
              {meta.title}
            </h1>
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{meta.subtitle}</p>
          </div>
          {view === 'queue' ? <ReviewReadyCard /> : null}
          <Suspense fallback={<Splash label="Loading…" />}>{screen}</Suspense>
        </main>

        <footer className="shrink-0 border-t border-line bg-surface px-3 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted">
            <span className="hs-numeric truncate">
              {today}/{cap} today
            </span>
            <span className="truncate">
              {displayedRunMode(current, engine.state) === 'autopilot'
                ? 'Autopilot'
                : displayedRunMode(current, engine.state) === 'dry_run'
                  ? 'Dry run'
                  : 'Review mode'}
            </span>
            <span className="hs-numeric shrink-0">v{version}</span>
          </div>
        </footer>

        <p className="sr-only" role="status" aria-live="polite">
          {liveMessage}
        </p>
      </div>
    );
  }

  return (
    <AppContext.Provider value={contextValue}>
      {body}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </AppContext.Provider>
  );
}
