import type { Settings, SettingsPatch } from '@/core/contracts';

export interface SettingsSectionProps {
  draft: Settings;
  onChange: (patch: SettingsPatch) => void;
}

export function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function keywordsToList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
