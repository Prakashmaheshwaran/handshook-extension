import { useCallback, useState } from 'react';
import {
  DEFAULT_OPENROUTER_MODEL,
  type AiProvider,
  type OpenRouterKeyInfo,
} from '@/core/contracts';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { ExternalLink } from '@/ui/components/ExternalLink';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { Section } from '@/ui/components/Section';
import { Select } from '@/ui/components/Select';
import { ToggleRow } from '@/ui/components/ToggleRow';
import type { AiTestPayload } from '@/ui/bridge';
import { useAiStatus } from '@/ui/hooks/useAiStatus';
import { useAppContext } from '@/ui/hooks/useAppContext';
import type { SettingsSectionProps } from './types';
import { toNumber } from './types';
import { requestOpenRouterHostPermission, type PermissionOutcome } from './aiRuntime';
import { OpenRouterModelPicker } from './OpenRouterModelPicker';
import { formatUsd } from './openRouterModels';

const PROVIDER_COPY = {
  auto: 'Auto uses OpenRouter when a key, model and permission are set; otherwise basic matching.',
  openrouter:
    'Matches using your chosen cloud model and your OpenRouter key; basic matching is the fallback.',
  heuristic: 'Matches your resume names to job keywords locally, without AI or cloud requests.',
};

export const AI_MIGRATION_NOTICE =
  'Gemini support was replaced by OpenRouter. Add an OpenRouter key to keep using cloud matching - until then Handshook uses basic matching.';

export function AiSection({ draft, onChange }: SettingsSectionProps) {
  const app = useAppContext();
  const ai = useAiStatus();
  const [busy, setBusy] = useState<'key' | 'clear' | 'test' | 'info' | 'dismiss' | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<OpenRouterKeyInfo | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testResult, setTestResult] = useState<AiTestPayload | null>(null);
  const status = ai.status;
  const config = draft.ai.openRouter;
  const requestPermission = useCallback(
    (): Promise<PermissionOutcome> =>
      app.bridgeMode === 'mock' ? Promise.resolve('granted') : requestOpenRouterHostPermission(),
    [app.bridgeMode],
  );

  const saveKey = async (): Promise<void> => {
    setBusy('key');
    setKeyError(null);
    setKeyNotice(null);
    setKeyInfo(null);
    // Do not await other work before requesting permission from this gesture.
    if ((await requestPermission()) !== 'granted') {
      setBusy(null);
      setKeyError(
        'OpenRouter permission was not granted. Your key was not saved. Allow access and try Save key again.',
      );
      return;
    }
    const key = keyDraft.trim();
    const error = await ai.saveKey(key);
    setBusy(null);
    if (error) {
      setKeyError(error.message);
      return;
    }
    setKeyDraft('');
    setKeyNotice(
      key.startsWith('sk-or-')
        ? 'Key saved locally. It is never shown again.'
        : 'Key saved locally, but OpenRouter keys usually start with sk-or-. Use Check key to verify it.',
    );
    app.notify('success', 'OpenRouter key saved.');
  };

  const clearKey = async (): Promise<void> => {
    setBusy('clear');
    setKeyError(null);
    const error = await ai.clearKey();
    setBusy(null);
    if (error) {
      setKeyError(error.message);
      app.notify('error', error.message);
      return;
    }
    setKeyDraft('');
    setKeyInfo(null);
    setTestResult(null);
    setKeyNotice('Key removed.');
    setConfirmClear(false);
    app.notify('success', 'OpenRouter key removed.');
  };

  const checkKey = async (): Promise<void> => {
    setBusy('info');
    setKeyError(null);
    setKeyInfo(null);
    if ((await requestPermission()) !== 'granted') {
      setBusy(null);
      setKeyError('OpenRouter permission was not granted. No key check was sent.');
      return;
    }
    const result = await ai.keyInfo();
    setBusy(null);
    if ('code' in result) {
      setKeyError(result.message);
      return;
    }
    setKeyInfo(result);
  };

  const testProvider = async (explicit?: AiProvider): Promise<void> => {
    const provider: AiProvider =
      explicit ??
      (draft.ai.provider === 'auto'
        ? status?.openRouterConfigured && config.model && status.openRouterPermission === 'granted'
          ? 'openrouter'
          : 'heuristic'
        : draft.ai.provider);
    setBusy('test');
    setTestResult(null);
    if (provider === 'openrouter') {
      if ((await requestPermission()) !== 'granted') {
        setBusy(null);
        setTestResult({
          provider,
          ok: false,
          message: 'OpenRouter permission was not granted. No request was sent.',
        });
        return;
      }
      if (JSON.stringify(config) !== JSON.stringify(app.settings?.ai.openRouter)) {
        setBusy(null);
        setTestResult({
          provider,
          ok: false,
          message: 'Save settings before testing the selected model and privacy controls.',
        });
        return;
      }
    }
    const result = await ai.test(provider);
    setBusy(null);
    setTestResult('code' in result ? { provider, ok: false, message: result.message } : result);
    await ai.refresh();
  };

  const dismissNotice = async (): Promise<void> => {
    setBusy('dismiss');
    const error = await ai.dismissMigrationNotice();
    setBusy(null);
    if (error) app.notify('error', error.message);
  };

  return (
    <Section
      id="ai"
      title="AI matching and page assist"
      description="On by default. AI matching and page assist use your own OpenRouter key; no telemetry."
    >
      <div className="min-w-0 space-y-3 rounded-panel border border-line bg-surface p-3">
        {status?.geminiReplacedNotice ? (
          <div
            role="status"
            className="rounded-lg border border-warn bg-surface-2 p-2 text-[11.5px] text-ink"
          >
            <p>{AI_MIGRATION_NOTICE}</p>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'dismiss'}
              disabled={busy !== null}
              onClick={() => void dismissNotice()}
            >
              Dismiss migration notice
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={draft.ai.enabled ? 'accent' : 'neutral'}>
            {draft.ai.enabled ? 'AI matching on' : 'AI matching off'}
          </Badge>
          {status?.openRouterConfigured ? <Badge tone="accent">OpenRouter key saved</Badge> : null}
          {config.model === DEFAULT_OPENROUTER_MODEL ? (
            <Badge tone="info">DeepSeek V4.1 Flash preselected</Badge>
          ) : null}
        </div>
        {draft.ai.enabled && status && !status.openRouterConfigured ? (
          <div
            role="status"
            className="rounded-lg border border-warn/40 bg-warn-soft p-2 text-[11.5px] leading-snug text-ink"
          >
            <p className="font-semibold">Add your OpenRouter key to turn AI on</p>
            <p className="mt-0.5 text-muted">
              AI matching and page assist both need your own OpenRouter key. DeepSeek V4.1 Flash (
              {DEFAULT_OPENROUTER_MODEL}) is preselected; you can change the model after saving the
              key below.
            </p>
          </div>
        ) : null}
        {ai.error ? (
          <p role="alert" className="text-[11.5px] text-danger">
            {ai.error.message}
          </p>
        ) : null}
        {status?.openRouterMessage ? (
          <p role="status" className="text-[11.5px] text-muted">
            {status.openRouterMessage}
          </p>
        ) : null}
        <ToggleRow
          label="Use AI to pick a resume"
          description="When off, Handshook uses your default resume. Turn matching on to use the provider below, including basic matching."
          checked={draft.ai.enabled}
          onChange={(enabled) => onChange({ ai: { enabled } })}
        />
        <ToggleRow
          label="Let AI find buttons and fields when Handshake changes its page"
          description="Sends only the labels, roles and a few attribute names of the page's buttons and fields to OpenRouter — never answers, document contents or form values. Used only when an OpenRouter key and permission are set."
          checked={draft.ai.pageAssist}
          onChange={(pageAssist) => onChange({ ai: { pageAssist } })}
        />
        <ToggleRow
          label="Let AI match differently worded questions to your saved answers"
          description="When a question is worded differently from your saved answers, sends the question text, its choices and your saved answers' labels — never the answers themselves — to OpenRouter, which only says which saved answer applies. Handshook fills your saved value and remembers the match. Used only when an OpenRouter key and permission are set."
          checked={draft.ai.answerAssist}
          onChange={(answerAssist) => onChange({ ai: { answerAssist } })}
        />
        <ToggleRow
          label="Let AI answer questions your saved answers don't cover"
          description="For questions that don't depend on a personal fact — such as how you heard about the job or why it interests you — AI writes an answer from the job posting and your non-sensitive saved answers (never work authorization, sponsorship, salary or self-identification answers). Questions about your experience, eligibility, history or other personal facts always wait for you. Every AI answer is listed in Activity."
          checked={draft.ai.answerWrite}
          onChange={(answerWrite) => onChange({ ai: { answerWrite } })}
        />
        <Field label="Provider" hint={PROVIDER_COPY[draft.ai.provider]}>
          <Select
            value={draft.ai.provider}
            onChange={(event) =>
              onChange({ ai: { provider: event.currentTarget.value as 'auto' | AiProvider } })
            }
            options={[
              { value: 'auto', label: 'Auto (recommended)' },
              { value: 'openrouter', label: 'OpenRouter' },
              { value: 'heuristic', label: 'Basic matching (no AI)' },
            ]}
          />
        </Field>
        <Field
          label={`Minimum confidence: ${Math.round(draft.ai.minConfidence * 100)}%`}
          hint="Below this, Handshook falls back to your default resume."
        >
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(draft.ai.minConfidence * 100)}
            aria-label="Minimum AI confidence"
            onChange={(event) =>
              onChange({ ai: { minConfidence: toNumber(event.currentTarget.value, 55) / 100 } })
            }
            className="w-full accent-[var(--accent)]"
          />
        </Field>
        <div className="min-w-0 space-y-2 rounded-lg border border-line bg-surface-2 p-2">
          <p className="text-[12px] font-medium text-ink">OpenRouter</p>
          <p className="text-[11.5px] leading-snug text-muted">
            One key gives access to many models from many companies. You pay OpenRouter directly.
            Free models have daily limits and usually allow the provider to keep or train on your
            data.
          </p>
          <p className="text-[11.5px] leading-snug text-muted">
            AI matching and page assist both use this key. Nothing AI does works without it, even
            with the switches above on.
          </p>
          <ExternalLink href="https://openrouter.ai/keys">Get a key</ExternalLink>
          <p className="text-[11px] text-muted">
            Your key is stored unencrypted in this browser's local storage and is only sent to
            OpenRouter. It is excluded from logs and exports.
          </p>
          <Field label="API key">
            <Input
              type="password"
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKeyDraft(event.currentTarget.value)}
              placeholder={
                status?.openRouterConfigured ? 'Replace the saved key' : 'Paste your OpenRouter key'
              }
            />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'key'}
              disabled={busy !== null || !keyDraft.trim() || /\s/.test(keyDraft.trim())}
              onClick={() => void saveKey()}
            >
              Save key
            </Button>
            {status?.openRouterConfigured ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setConfirmClear(true)}
                >
                  Remove key
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'info'}
                  disabled={busy !== null}
                  onClick={() => void checkKey()}
                >
                  Check key
                </Button>
              </>
            ) : null}
          </div>
          {keyNotice ? (
            <p role="status" className="text-[11px] text-muted">
              {keyNotice}
            </p>
          ) : null}
          {keyError ? (
            <p role="alert" className="text-[11.5px] text-danger">
              {keyError}
            </p>
          ) : null}
          {keyInfo ? (
            <div role="status" className="break-words text-[11.5px] text-muted">
              <p>Key: {keyInfo.label}</p>
              <p>
                {keyInfo.isFreeTier
                  ? 'Free tier'
                  : `Credits remaining: ${keyInfo.limitRemaining === null ? 'not reported' : formatUsd(keyInfo.limitRemaining)} / limit: ${keyInfo.limit === null ? 'no limit' : formatUsd(keyInfo.limit)}`}
              </p>
              <p>Free requests left today: {keyInfo.freeDailyRemaining ?? 'not reported'}</p>
            </div>
          ) : null}
          <OpenRouterModelPicker
            draft={draft}
            onChange={onChange}
            ai={ai}
            requestPermission={requestPermission}
          />
          <ToggleRow
            label="Allow providers that may store or train on job text"
            description="Off by default. Keeping this off can make some models, especially free ones, unavailable."
            checked={config.allowDataCollection}
            onChange={(allowDataCollection) =>
              onChange({ ai: { openRouter: { ...config, allowDataCollection } } })
            }
          />
          <ToggleRow
            label="Zero-data-retention providers only"
            description="Restricts routing to providers that offer zero data retention; fewer models may be available."
            checked={config.zeroDataRetention}
            onChange={(zeroDataRetention) =>
              onChange({ ai: { openRouter: { ...config, zeroDataRetention } } })
            }
          />
          <Field
            label="Max input price per 1M tokens"
            hint="USD. Leave empty for no cap. This limits input pricing, not total spend or output pricing."
          >
            <Input
              type="number"
              min={0}
              step="any"
              value={config.maxPromptPricePerMillion ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const price = Number(value);
                if (value === '' || (Number.isFinite(price) && price >= 0))
                  onChange({
                    ai: {
                      openRouter: {
                        ...config,
                        maxPromptPricePerMillion: value === '' ? null : price,
                      },
                    },
                  });
              }}
            />
          </Field>
          <p className="text-[11px] leading-snug text-muted">
            If you choose OpenRouter, Handshook sends the job's title and description plus your
            resume names and IDs to OpenRouter, which forwards them to the model provider you
            picked.
          </p>
          <p className="text-[11px] leading-snug text-muted">
            The description is a bounded excerpt. Document files and saved answers are not sent to
            AI. Provider tests send a fixed sample. Filling forms shares answers and selected
            document references with Handshake. No telemetry.
          </p>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'test'}
            disabled={busy !== null || !status?.openRouterConfigured || !config.model}
            onClick={() => void testProvider('openrouter')}
          >
            Test OpenRouter
          </Button>
        </div>
        {draft.ai.provider !== 'openrouter' ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'test'}
            disabled={busy !== null}
            onClick={() => void testProvider()}
          >
            Test provider
          </Button>
        ) : null}
        <p role="status" aria-live="polite" className="break-words text-[11.5px] text-muted">
          {testResult
            ? `${testResult.ok ? 'Passed' : 'Needs attention'}: ${testResult.message}${testResult.model ? ` Model: ${testResult.model}.` : ''}${testResult.costUsd !== undefined ? ` Cost: ${formatUsd(testResult.costUsd)}.` : ''}`
            : ''}
        </p>
      </div>
      <ConfirmDialog
        open={confirmClear}
        title="Remove the OpenRouter key?"
        description="OpenRouter matching will be unavailable until you save a key again. Your answers and documents stay."
        confirmLabel="Remove key"
        tone="danger"
        loading={busy === 'clear'}
        onConfirm={() => void clearKey()}
        onCancel={() => setConfirmClear(false)}
      />
    </Section>
  );
}
