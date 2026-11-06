import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { Field } from '@/ui/components/Field';
import { extensionVersion } from '@/core/version';
import { IconDiagnostics, IconShield } from '@/ui/components/icons';
import { ReportProblem } from '@/ui/components/ReportProblem';
import { Section } from '@/ui/components/Section';
import { Select } from '@/ui/components/Select';
import { ToggleRow } from '@/ui/components/ToggleRow';
import type { SettingsSectionProps } from './types';

export interface AdvancedSectionProps extends SettingsSectionProps {
  onOpenDiagnostics: () => void;
  onRunSetup: () => void;
}

export function AdvancedSection({
  draft,
  onChange,
  onOpenDiagnostics,
  onRunSetup,
}: AdvancedSectionProps) {
  return (
    <Section id="advanced" title="Advanced" description="Diagnostics and local data details.">
      <div className="space-y-2 rounded-panel border border-line bg-surface p-3">
        <p className="text-[11.5px] leading-snug text-muted">
          Revisit setup with your saved choices. Your queue, history, documents, and answers stay
          saved.
        </p>
        <Button size="sm" variant="secondary" onClick={onRunSetup}>
          Run setup again
        </Button>
        <Field label="Theme">
          <Select
            value={draft.ui.theme}
            onChange={(event) =>
              onChange({ ui: { theme: event.currentTarget.value as typeof draft.ui.theme } })
            }
            options={[
              { value: 'system', label: 'Match system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Field>

        <ToggleRow
          label="Show advanced options"
          description="Adds extra diagnostics detail and developer-facing fields."
          checked={draft.ui.showAdvanced}
          onChange={(showAdvanced) => onChange({ ui: { showAdvanced } })}
        />

        <Button
          size="sm"
          variant="secondary"
          iconLeft={<IconDiagnostics size={13} />}
          onClick={onOpenDiagnostics}
        >
          Open diagnostics
        </Button>

        <ReportProblem
          className="border-t border-line pt-2"
          context={{
            version: extensionVersion(),
            mode: draft.mode,
            reviewBeforeSubmit: draft.safety.reviewBeforeSubmit,
          }}
        />

        {draft.ui.showAdvanced ? (
          <Card tone="muted" padded={false} className="p-2">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
              <IconShield size={13} />
              Local-first
            </p>
            <ul className="mt-1 space-y-1 pl-4 text-[11px] leading-snug text-muted">
              <li className="list-disc">Jobs, answers, and events stay in this browser profile.</li>
              <li className="list-disc">
                IndexedDB is not encrypted at rest. Anyone with access to this profile can read it.
              </li>
              <li className="list-disc">
                No telemetry. Handshake pages and forms use the network. If you choose OpenRouter,
                Handshook sends the job's title and description plus your resume IDs, names and
                notes to OpenRouter, which forwards them to the model provider you picked.
              </li>
              <li className="list-disc">Handshook never sees or stores your Handshake password.</li>
            </ul>
          </Card>
        ) : null}
      </div>
    </Section>
  );
}
