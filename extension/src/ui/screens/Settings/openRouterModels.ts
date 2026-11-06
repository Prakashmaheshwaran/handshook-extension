import type { OpenRouterModelSummary } from '@/core/contracts';

export type ModelSort = 'price' | 'context' | 'name';

export function filterModels(
  models: readonly OpenRouterModelSummary[],
  query: string,
  freeOnly: boolean,
  structuredOnly: boolean,
  sort: ModelSort,
): OpenRouterModelSummary[] {
  const search = query.trim().toLowerCase();
  return models
    .filter(
      (model) =>
        (!freeOnly || model.isFree) &&
        (!structuredOnly || model.supportsStructuredOutputs) &&
        (!search || `${model.name} ${model.id}`.toLowerCase().includes(search)),
    )
    .sort((a, b) => {
      if (sort === 'context')
        return (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.name.localeCompare(b.name);
      if (sort === 'name') return a.name.localeCompare(b.name);
      return (
        (a.promptPricePerMillion ?? Infinity) - (b.promptPricePerMillion ?? Infinity) ||
        (a.completionPricePerMillion ?? Infinity) - (b.completionPricePerMillion ?? Infinity) ||
        a.name.localeCompare(b.name)
      );
    });
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: value >= 1_000_000_000 ? 'scientific' : 'standard',
    maximumFractionDigits: 8,
  }).format(value);
}

export function modelPrice(model: OpenRouterModelSummary): string {
  if (model.isFree) return 'Free';
  const price = (value: number | null): string => (value === null ? 'unknown' : formatUsd(value));
  return `${price(model.promptPricePerMillion)} input / ${price(model.completionPricePerMillion)} output per 1M tokens`;
}

export function jobCostHint(model: OpenRouterModelSummary): string {
  if (model.isFree) return 'free';
  if (
    model.promptPricePerMillion === null ||
    model.completionPricePerMillion === null ||
    !Number.isFinite(model.promptPricePerMillion) ||
    !Number.isFinite(model.completionPricePerMillion) ||
    model.promptPricePerMillion < 0 ||
    model.completionPricePerMillion < 0
  )
    return 'cost unavailable';
  // Divide the token counts first so even very large finite prices cannot overflow.
  const cost = 0.0015 * model.promptPricePerMillion + 0.0002 * model.completionPricePerMillion;
  return `about ${formatUsd(Number(cost.toPrecision(2)))} per job`;
}
