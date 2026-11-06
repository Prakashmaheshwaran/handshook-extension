import { SpeedControl } from './SpeedControl';
import { Card } from '@/ui/components/Card';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { Section } from '@/ui/components/Section';
import type { SettingsSectionProps } from './types';
import { clamp, toNumber } from './types';

export function PacingSection({ draft, onChange }: SettingsSectionProps) {
  const pacing = draft.pacing;

  const dailyCapAboveHardCap = pacing.dailyCap > pacing.hardCap;

  return (
    <Section
      id="pacing"
      title="Pacing"
      description="Slower is safer. These limits reduce load on Handshake; they are not a guarantee against account limits."
    >
      <div className="grid gap-3 rounded-panel border border-line bg-surface p-3">
        <SpeedControl pacing={pacing} onChange={onChange} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Daily cap" hint="Applications per day.">
            <Input
              type="number"
              min={1}
              max={100}
              value={pacing.dailyCap}
              onChange={(event) =>
                onChange({
                  pacing: {
                    dailyCap: clamp(toNumber(event.currentTarget.value, pacing.dailyCap), 1, 100),
                  },
                })
              }
            />
          </Field>
          <Field label="Hard cap" hint="Never exceed, even with resume.">
            <Input
              type="number"
              min={1}
              max={100}
              value={pacing.hardCap}
              onChange={(event) =>
                onChange({
                  pacing: {
                    hardCap: clamp(toNumber(event.currentTarget.value, pacing.hardCap), 1, 100),
                  },
                })
              }
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Pause after failures" hint="Consecutive failures before slowing down.">
            <Input
              type="number"
              min={1}
              max={10}
              value={pacing.maxConsecutiveFailures}
              onChange={(event) =>
                onChange({
                  pacing: {
                    maxConsecutiveFailures: clamp(
                      toNumber(event.currentTarget.value, pacing.maxConsecutiveFailures),
                      1,
                      10,
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Tries per job" hint="Attempts before a job is set aside.">
            <Input
              type="number"
              min={1}
              max={5}
              value={pacing.maxAttemptsPerJob}
              onChange={(event) =>
                onChange({
                  pacing: {
                    maxAttemptsPerJob: clamp(
                      toNumber(event.currentTarget.value, pacing.maxAttemptsPerJob),
                      1,
                      5,
                    ),
                  },
                })
              }
            />
          </Field>
        </div>

        {dailyCapAboveHardCap ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-2 py-1 text-[11.5px] font-medium text-danger"
          >
            Daily cap is higher than the hard cap, so the hard cap wins.
          </p>
        ) : null}

        {pacing.dailyCap > 25 ? (
          <Card tone="warn" padded={false} className="p-2">
            <p className="text-[11.5px] leading-snug text-warn">
              {pacing.dailyCap} a day is aggressive for a new account. Start lower and raise it only
              if runs stay clean.
            </p>
          </Card>
        ) : null}
      </div>
    </Section>
  );
}
