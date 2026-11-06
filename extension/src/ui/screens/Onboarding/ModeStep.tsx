import type { RunMode } from '@/core/contracts';
import { Badge } from '@/ui/components/Badge';
import { Card } from '@/ui/components/Card';
import { Checkbox } from '@/ui/components/Checkbox';
import { ONE_CLICK_APPLY_HELP, ONE_CLICK_APPLY_LABEL } from '@/core/documents/selection';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { ToggleRow } from '@/ui/components/ToggleRow';

export interface ModeStepProps {
  mode: RunMode;
  onMode: (mode: RunMode) => void;
  documentsChosen: number;
  answersFilled: number;
  searchReady: boolean;
  sensitiveAutoCount: number;
  /** Settings → Safety: turning this on is the opt-out from automatic submitting. */
  reviewBeforeSubmit: boolean;
  onReviewBeforeSubmit: (value: boolean) => void;
  allowOneClickApply: boolean;
  onAllowOneClickApply: (value: boolean) => void;
}

export function ModeStep({
  mode,
  onMode,
  documentsChosen,
  answersFilled,
  searchReady,
  sensitiveAutoCount,
  reviewBeforeSubmit,
  onReviewBeforeSubmit,
  allowOneClickApply,
  onAllowOneClickApply,
}: ModeStepProps) {
  return (
    <div className="space-y-3">
      <Card>
        <h2 className="text-[14px] font-semibold text-ink">How should runs behave?</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Handshook applies for you by default: press Start and it fills and submits applications
          that meet your rules. Review and Dry run are the opt-outs. You can change this later in
          Settings → Run mode and safety.
        </p>
        <div className="mt-3">
          <RadioGroup
            legend="Run mode"
            name="onboarding-mode"
            variant="cards"
            value={mode}
            onChange={(value) => onMode(value as RunMode)}
            options={[
              {
                value: 'autopilot',
                label: 'Handshook applies for you (recommended)',
                description:
                  'Fills and submits applications that meet every gate: fit score, known answers, documents, active session, and caps. Anything uncertain waits for you in Needs you.',
              },
              {
                value: 'review',
                label: 'Review each application before it is submitted',
                description:
                  'Turns off automatic submitting: Handshook fills the form, then pauses so you can check it and submit. Choose this if you want to approve every application.',
              },
              {
                value: 'dry_run',
                label: 'Dry run: nothing will be submitted',
                description:
                  'Previews the run without filling or submitting any applications. Choose Review or Handshook applies for you later when ready.',
              },
            ]}
          />
        </div>

        {mode === 'autopilot' ? (
          <div className="mt-3 rounded-panel border border-line bg-surface p-3">
            <ToggleRow
              label="Review each application before it is submitted"
              description="Off by default (fully automatic). Turn this on to make Handshook fill each application and stop for your approval instead of submitting it."
              checked={reviewBeforeSubmit}
              onChange={onReviewBeforeSubmit}
            />
            <Checkbox
              className="mt-3"
              label={ONE_CLICK_APPLY_LABEL}
              description={ONE_CLICK_APPLY_HELP}
              checked={allowOneClickApply}
              onChange={onAllowOneClickApply}
            />
            {reviewBeforeSubmit ? (
              <p className="mt-2 rounded-md bg-surface-2 px-2 py-1.5 text-[11.5px] leading-snug text-muted">
                Review is on, so Handshook will fill each application and wait for you. Turn this
                off at any time in Settings → Run mode and safety to apply automatically.
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      {mode === 'dry_run' ? (
        <Card tone="warn">
          <p className="text-[12px] font-semibold text-ink">Dry run: nothing will be submitted</p>
        </Card>
      ) : mode === 'autopilot' ? (
        <Card tone="accent">
          <p className="text-[12px] font-semibold text-ink">Handshook applies for you</p>
          <ul className="mt-1 space-y-1 pl-4 text-[11.5px] leading-snug text-muted">
            <li className="list-disc">Supports Quick Apply and Handshake application forms.</li>
            <li className="list-disc">
              Runs at any hour. Daily caps, delays, and breaks still apply.
            </li>
            <li className="list-disc">
              Only two things stop a job: a required question with no saved answer, or a required
              document type with no entered ID. Answer or add it once and future jobs continue
              automatically.
            </li>
            <li className="list-disc">External employer sites are always handed to you.</li>
          </ul>
        </Card>
      ) : (
        <Card tone="muted">
          <p className="text-[12px] font-semibold text-ink">
            You chose to review every application
          </p>
          <ul className="mt-1 space-y-1 pl-4 text-[11.5px] leading-snug text-muted">
            <li className="list-disc">Handshook fills the form and stops.</li>
            <li className="list-disc">You see every answer before it is submitted.</li>
            <li className="list-disc">Switch back to Handshook applies for you at any time.</li>
          </ul>
        </Card>
      )}

      <Card>
        <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted">
          Setup summary
        </p>
        <ul className="mt-1.5 space-y-1 text-[12px]">
          <li className="flex items-center justify-between gap-2">
            <span className="text-muted">Documents chosen</span>
            <Badge tone={documentsChosen > 0 ? 'accent' : 'warn'}>
              {documentsChosen > 0 ? `${documentsChosen} selected` : 'None yet'}
            </Badge>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="text-muted">Answers filled</span>
            <Badge tone={answersFilled > 0 ? 'accent' : 'warn'}>{answersFilled}</Badge>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="text-muted">Saved search</span>
            <Badge tone={searchReady ? 'accent' : 'warn'}>
              {searchReady ? 'Ready' : 'Not set'}
            </Badge>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="text-muted">Sensitive auto-submit</span>
            <Badge tone={sensitiveAutoCount > 0 ? 'warn' : 'neutral'}>
              {sensitiveAutoCount > 0 ? `${sensitiveAutoCount} allowed` : 'All manual'}
            </Badge>
          </li>
        </ul>
      </Card>

      <p className="text-[11px] leading-snug text-muted">
        Pressing Finish saves this setup. It does not start a run — the dashboard does, when you are
        ready.
      </p>
    </div>
  );
}
