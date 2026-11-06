import {
  PACING_PRESETS,
  describePacingRate,
  estimateAppsPerHour,
  type Settings,
  type SettingsPatch,
  type PacingSpeed,
} from '@/core/contracts';
import { resolvePacing } from '@/core/orchestrator/pacing-settings';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';

export function SpeedControl({
  pacing,
  onChange,
}: {
  pacing: Settings['pacing'];
  onChange: (patch: SettingsPatch) => void;
}) {
  const preset = PACING_PRESETS[pacing.speed];
  // Derive from the effective timings so saved custom values stay truthful and
  // a legacy saved preset never shows an out-of-date rate.
  const rate = describePacingRate(estimateAppsPerHour(resolvePacing(pacing)));
  const label = pacing.useAdvanced ? 'Custom' : preset.label;
  return (
    <div className="space-y-2">
      <Field label="Speed" hint={rate}>
        <Input
          type="range"
          min={1}
          max={5}
          step={1}
          value={pacing.speed}
          aria-valuetext={label}
          onChange={(event) =>
            onChange({
              pacing: {
                speed: Number(event.currentTarget.value) as PacingSpeed,
                useAdvanced: false,
              },
            })
          }
        />
      </Field>
      <div className="grid grid-cols-5 gap-1 text-center text-[10px] leading-snug text-muted">
        {([1, 2, 3, 4, 5] as const).map((speed) => (
          <span key={speed}>{PACING_PRESETS[speed].label}</span>
        ))}
      </div>
    </div>
  );
}
