import { DocumentChoices } from '@/ui/components/DocumentChoices';
import { Section } from '@/ui/components/Section';
import type { SettingsSectionProps } from './types';

export function DocumentsSection({ draft, onChange }: SettingsSectionProps) {
  return (
    <Section
      id="documents"
      title="Documents"
      description="Paste the link or ID of each Handshake document you want Handshook to use. Save your choices with the Settings Save button."
    >
      <div className="rounded-panel border border-line bg-surface p-3">
        <DocumentChoices
          host={draft.host}
          value={draft.documents}
          aiEnabled={draft.ai.enabled}
          onChange={(patch) => onChange({ documents: patch })}
        />
      </div>
    </Section>
  );
}
