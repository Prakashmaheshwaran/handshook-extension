import type { EngineState, Settings } from '@/core/contracts';

/** A paused/resumable run retains its mode even after Settings changes. */
export function displayedRunMode(settings: Settings | null, engine: EngineState | null) {
  return engine && engine.status !== 'idle'
    ? engine.mode
    : (settings?.mode ?? engine?.mode ?? 'review');
}

export function RunModeNotice({
  settings,
  engine,
}: {
  settings: Settings;
  engine: EngineState | null;
}) {
  if (displayedRunMode(settings, engine) !== 'dry_run') return null;
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warn/30 bg-warn-soft px-3 py-2 text-[12px] font-semibold leading-snug text-warn"
    >
      Dry run: nothing will be submitted
    </div>
  );
}
