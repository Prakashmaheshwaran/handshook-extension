import { PACING_PRESETS, type Settings } from '@/core/contracts';

/** Caps and failure limits always remain user controlled. */
export function resolvePacing(pacing: Settings['pacing']): Settings['pacing'] {
  if (pacing.useAdvanced) return { ...pacing };
  const { label, description, ...timings } = PACING_PRESETS[pacing.speed];
  void label;
  void description;
  return { ...pacing, ...timings };
}
