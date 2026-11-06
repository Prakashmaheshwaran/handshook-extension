import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OpenRouterModelSummary } from '@/core/contracts';
import { Button } from '@/ui/components/Button';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { Select } from '@/ui/components/Select';
import { ToggleRow } from '@/ui/components/ToggleRow';
import type { AiController } from '@/ui/hooks/useAiStatus';
import type { PermissionOutcome } from './aiRuntime';
import type { SettingsSectionProps } from './types';
import { filterModels, jobCostHint, modelPrice, type ModelSort } from './openRouterModels';

interface Props extends SettingsSectionProps {
  ai: AiController;
  requestPermission: () => Promise<PermissionOutcome>;
}

export function OpenRouterModelPicker({ draft, onChange, ai, requestPermission }: Props) {
  const [models, setModels] = useState<OpenRouterModelSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [structuredOnly, setStructuredOnly] = useState(true);
  const [sort, setSort] = useState<ModelSort>('price');
  const [limit, setLimit] = useState(50);
  const { loadModels } = ai;
  const config = draft.ai.openRouter;

  const load = useCallback(
    async (refresh = false, fromClick = false) => {
      setLoading(true);
      setError(null);
      if (fromClick && (await requestPermission()) !== 'granted') {
        setError('OpenRouter permission was not granted. Allow access to load models.');
        setLoading(false);
        return;
      }
      const result = await loadModels(refresh);
      setLoading(false);
      if ('code' in result) {
        setError(result.message);
        return;
      }
      setModels(result.models);
      setLoaded(true);
    },
    [loadModels, requestPermission],
  );

  useEffect(() => {
    let active = true;
    if (
      ai.status?.enabled &&
      (ai.status.provider === 'auto' || ai.status.provider === 'openrouter') &&
      ai.status.openRouterConfigured &&
      ai.status.openRouterPermission === 'granted'
    ) {
      void Promise.resolve().then(() => {
        if (active) void load();
      });
    }
    return () => {
      active = false;
    };
  }, [
    ai.status?.enabled,
    ai.status?.provider,
    ai.status?.openRouterConfigured,
    ai.status?.openRouterPermission,
    load,
  ]);

  const matches = useMemo(
    () => filterModels(models, query, freeOnly, structuredOnly, sort),
    [models, query, freeOnly, structuredOnly, sort],
  );
  const selected = models.find((model) => model.id === config.model);
  const toggleFallback = (id: string): void => {
    const fallbackModels = config.fallbackModels.includes(id)
      ? config.fallbackModels.filter((model) => model !== id)
      : [...config.fallbackModels, id].slice(0, 2);
    onChange({ ai: { openRouter: { ...config, fallbackModels } } });
  };

  return (
    <div className="min-w-0 space-y-2 border-t border-line pt-3">
      <p className="text-[12px] font-medium text-ink">Model</p>
      <div
        aria-label="Selected OpenRouter model"
        className="min-w-0 rounded-lg border border-line bg-surface p-2 text-[11.5px] text-muted"
      >
        <p className="break-words font-medium text-ink">
          {selected?.name ?? config.model ?? 'Choose a model after loading the catalog.'}
        </p>
        {selected ? (
          <>
            <p className="truncate text-[10.5px]" title={selected.id}>
              {selected.id}
            </p>
            <p>{modelPrice(selected)}</p>
            <p>Estimated match cost: {jobCostHint(selected)}.</p>
            {selected.expirationDate ? (
              <p className="text-warn">expires {selected.expirationDate}</p>
            ) : null}
          </>
        ) : config.model ? (
          <p>Load models for current pricing.</p>
        ) : null}
      </div>
      <p className="text-[11px] leading-snug text-muted">
        Estimate uses about 1,500 input and 200 output tokens. Actual usage varies. Save settings to
        apply your model and privacy choices.
      </p>
      <Button
        size="sm"
        variant="secondary"
        loading={loading}
        onClick={() => void load(loaded, true)}
      >
        {loaded ? 'Refresh' : 'Load models'}
      </Button>
      {error ? (
        <p role="alert" className="text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <>
          <Field label="Search models" hint="Search by model name or ID.">
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setLimit(50);
              }}
            />
          </Field>
          <ToggleRow
            label="Free only"
            checked={freeOnly}
            onChange={(value) => {
              setFreeOnly(value);
              setLimit(50);
            }}
          />
          <ToggleRow
            label="Structured output only"
            description="Improves matching reliability by requiring the model to follow a response schema."
            checked={structuredOnly}
            onChange={(value) => {
              setStructuredOnly(value);
              setLimit(50);
            }}
          />
          <Field label="Sort models">
            <Select
              value={sort}
              options={[
                { value: 'price', label: 'Price: low to high' },
                { value: 'context', label: 'Context length: largest first' },
                { value: 'name', label: 'Name: A to Z' },
              ]}
              onChange={(event) => {
                setSort(event.currentTarget.value as ModelSort);
                setLimit(50);
              }}
            />
          </Field>
          <p role="status" className="text-[11px] text-muted">
            {matches.length} models match{matches.length > limit ? `; showing first ${limit}` : ''}.
          </p>
          <ul
            aria-label="OpenRouter models"
            className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border border-line p-1"
          >
            {matches.slice(0, limit).map((model) => (
              <li
                key={model.id}
                className="min-w-0 space-y-1 rounded bg-surface p-2 text-[11px] text-muted"
              >
                <p className="break-words text-[12px] font-medium text-ink">{model.name}</p>
                <p className="truncate text-[10.5px]" title={model.id}>
                  {model.id}
                </p>
                <p>{modelPrice(model)}</p>
                <p>Context: {model.contextLength?.toLocaleString('en-US') ?? 'unknown'} tokens</p>
                {model.expirationDate ? (
                  <p className="text-warn">expires {model.expirationDate}</p>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant={config.model === model.id ? 'primary' : 'secondary'}
                    aria-label={`Select ${model.name}`}
                    aria-pressed={config.model === model.id}
                    onClick={() =>
                      onChange({
                        ai: {
                          openRouter: {
                            ...config,
                            model: model.id,
                            fallbackModels: config.fallbackModels.filter((id) => id !== model.id),
                          },
                        },
                      })
                    }
                  >
                    {config.model === model.id ? 'Selected' : 'Select'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Fallback ${model.name}`}
                    aria-pressed={config.fallbackModels.includes(model.id)}
                    disabled={
                      config.model === model.id ||
                      (!config.fallbackModels.includes(model.id) &&
                        config.fallbackModels.length >= 2)
                    }
                    onClick={() => toggleFallback(model.id)}
                  >
                    {config.fallbackModels.includes(model.id) ? 'Remove fallback' : 'Add fallback'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {matches.length > limit ? (
            <Button size="sm" variant="secondary" onClick={() => setLimit((value) => value + 50)}>
              Show more
            </Button>
          ) : null}
        </>
      ) : null}
      <p className="text-[11px] leading-snug text-muted">
        Up to 2 fallback models, tried in the order below. Fallbacks may cost more than your
        selected model.
      </p>
      <ol aria-label="Fallback models" className="space-y-1">
        {config.fallbackModels.map((id, index) => {
          const model = models.find((entry) => entry.id === id);
          return (
            <li key={id} className="min-w-0 text-[11px] text-muted">
              <p className="break-words">
                {index + 1}. {model?.name ?? id}
              </p>
              {model ? <p>{modelPrice(model)}</p> : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove fallback ${model?.name ?? id}`}
                onClick={() => toggleFallback(id)}
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
