import { useState } from 'react';
import { mergeSettings, type Settings, type SettingsPatch } from '@/core/contracts';
import { Button } from '@/ui/components/Button';
import { ErrorState } from '@/ui/components/ErrorState';
import { LoadingBlock } from '@/ui/components/Skeleton';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { AdvancedSection } from './AdvancedSection';
import { AiSection } from './AiSection';
import { BetaSection } from './BetaSection';
import { AnswersSection } from './AnswersSection';
import { DataSection } from './DataSection';
import { DocumentsSection } from './DocumentsSection';
import { ImportExportSection } from './ImportExportSection';
import { PacingSection } from './PacingSection';
import { SafetySection } from './SafetySection';
import { SearchSection } from './SearchSection';

interface DraftEdits {
  base: Settings;
  value: Settings;
}

export function SettingsScreen() {
  const app = useAppContext();
  const settings = app.settings;
  const [edits, setEdits] = useState<DraftEdits | null>(null);
  const [saving, setSaving] = useState(false);

  if (!settings) {
    if (app.settingsError) {
      return (
        <ErrorState
          error={app.settingsError}
          title="Cannot load settings"
          onRetry={() => void app.refreshSettings()}
        />
      );
    }
    return <LoadingBlock label="Loading settings" />;
  }

  const draft = edits && edits.base === settings ? edits.value : settings;
  const dirty = edits !== null && JSON.stringify(edits.value) !== JSON.stringify(edits.base);

  const onChange = (patch: SettingsPatch): void => {
    setEdits({ base: settings, value: mergeSettings(draft, patch) });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const error = await app.saveSettings(draft);
    setSaving(false);
    if (error) {
      app.notify('error', error.message);
      return;
    }
    setEdits(null);
    app.notify('success', 'Settings saved.');
  };

  return (
    <div className="space-y-5">
      <p aria-live="polite" className="sr-only">
        {dirty ? 'You have unsaved settings.' : 'All settings saved.'}
      </p>

      <SafetySection draft={draft} onChange={onChange} />
      <SearchSection draft={draft} onChange={onChange} />
      <PacingSection draft={draft} onChange={onChange} />
      <DocumentsSection draft={draft} onChange={onChange} />
      <AnswersSection />
      <AiSection draft={draft} onChange={onChange} />
      <BetaSection draft={draft} onChange={onChange} />
      <AdvancedSection
        draft={draft}
        onChange={onChange}
        onOpenDiagnostics={() => app.navigate('diagnostics')}
        onRunSetup={() => app.navigate('onboarding')}
      />
      <DataSection />
      <ImportExportSection />

      {dirty ? (
        <div className="sticky bottom-0 z-10 -mx-3 flex items-center gap-2 border-t border-line bg-surface/95 px-3 py-2 backdrop-blur">
          <p className="min-w-0 flex-1 text-[11.5px] font-medium text-ink">Unsaved changes</p>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEdits(null)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
