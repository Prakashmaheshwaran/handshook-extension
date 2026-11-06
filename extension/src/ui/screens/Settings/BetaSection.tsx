import { Section } from '@/ui/components/Section';
import { ToggleRow } from '@/ui/components/ToggleRow';
import type { SettingsSectionProps } from './types';

export function BetaSection({ draft, onChange }: SettingsSectionProps) {
  return (
    <Section
      id="beta"
      title="Beta features"
      description="Experimental features are off by default. Save to apply your choices."
    >
      <div className="space-y-3 rounded-panel border border-line bg-surface p-3">
        <ToggleRow
          label="Collect external job links (beta)"
          description="Include links to applications on employer sites for you to open manually. Handshook never applies on external sites."
          checked={draft.search.collectExternalJobs}
          onChange={(collectExternalJobs) => onChange({ search: { collectExternalJobs } })}
        />
      </div>
    </Section>
  );
}
