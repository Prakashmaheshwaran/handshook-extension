import { Card } from '@/ui/components/Card';
import { Checkbox } from '@/ui/components/Checkbox';
import { ONE_CLICK_APPLY_HELP, ONE_CLICK_APPLY_LABEL } from '@/core/documents/selection';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { Section } from '@/ui/components/Section';
import { ToggleRow } from '@/ui/components/ToggleRow';
import type { SettingsSectionProps } from './types';

export function SafetySection({ draft, onChange }: SettingsSectionProps) {
  return (
    <Section
      id="safety"
      title="Run mode and safety"
      description="Handshook applies for you. Every switch below is on by default; turn one off only if you want to step in."
    >
      <div className="space-y-3 rounded-panel border border-line bg-surface p-3">
        <RadioGroup
          legend="Mode"
          name="run-mode"
          variant="cards"
          value={draft.mode}
          onChange={(value) => onChange({ mode: value as typeof draft.mode })}
          options={[
            {
              value: 'autopilot',
              label: 'Handshook applies for you (recommended)',
              description:
                'Fills and submits applications (Quick Apply or Handshake forms) that meet every gate: fit score, known answers, documents, active session, and caps. Anything uncertain waits for you.',
            },
            {
              value: 'review',
              label: 'Review each application before it is submitted',
              description:
                'The opt-out from automatic submitting. Handshook fills the form, then stops so you can check it and submit. Nothing is sent automatically.',
            },
            {
              value: 'dry_run',
              label: 'Dry run',
              description:
                'Inspects each job and records a would-apply result, but never fills or submits an application.',
            },
          ]}
        />

        {draft.mode === 'autopilot' ? (
          <Card tone="muted" padded={false} className="p-2">
            <p className="text-[11.5px] font-semibold leading-snug text-ink">
              Only two things stop a job:
            </p>
            <ul className="mt-1 space-y-1 pl-4 text-[11.5px] leading-snug text-muted">
              <li className="list-disc">a required question with no saved answer</li>
              <li className="list-disc">a required document type with no entered ID</li>
            </ul>
            <p className="mt-1 text-[11.5px] leading-snug text-muted">
              Answer the question or add the document once, and future jobs continue automatically.
            </p>
          </Card>
        ) : null}

        <div className="divide-y divide-line border-t border-line">
          <Checkbox
            className="py-3"
            label={ONE_CLICK_APPLY_LABEL}
            description={ONE_CLICK_APPLY_HELP}
            checked={draft.safety.allowOneClickApply}
            onChange={(allowOneClickApply) => onChange({ safety: { allowOneClickApply } })}
          />
          <ToggleRow
            label="Review each application before it is submitted"
            description="Off by default (fully automatic). Turn on to check every application before Handshook clicks Submit."
            checked={draft.safety.reviewBeforeSubmit}
            onChange={(reviewBeforeSubmit) => onChange({ safety: { reviewBeforeSubmit } })}
          />
          <ToggleRow
            label="Submit sensitive answers automatically"
            description="Work authorization, sponsorship, salary, veteran status, disability, gender, race, and EEO. On by default; turn off to answer these yourself."
            checked={draft.safety.allowSensitiveAutoSubmit}
            onChange={(allowSensitiveAutoSubmit) =>
              onChange({ safety: { allowSensitiveAutoSubmit } })
            }
          />
          <ToggleRow
            label="Fill EEO self-identification automatically"
            description="On by default. Turn off to leave EEO blocks blank for you to answer."
            checked={draft.safety.allowEeoAutoFill}
            onChange={(allowEeoAutoFill) => onChange({ safety: { allowEeoAutoFill } })}
          />
          <ToggleRow
            label="Fill free-text answers automatically"
            description="Uses your saved answers for open-ended questions. On by default; turn off to write those answers yourself."
            checked={draft.safety.allowFreeTextAutoFill}
            onChange={(allowFreeTextAutoFill) => onChange({ safety: { allowFreeTextAutoFill } })}
          />
          <ToggleRow
            label="Stop on an unknown required question"
            description="On by default. A required question with no saved answer goes to Needs you instead of being guessed."
            checked={draft.safety.stopOnUnknownQuestion}
            onChange={(stopOnUnknownQuestion) => onChange({ safety: { stopOnUnknownQuestion } })}
          />
          <ToggleRow
            label="Wait for submission confirmation"
            description="On by default. Looks for the confirmation page before marking a job applied."
            checked={draft.safety.verifySubmissions}
            onChange={(verifySubmissions) => onChange({ safety: { verifySubmissions } })}
          />
        </div>
      </div>
    </Section>
  );
}
