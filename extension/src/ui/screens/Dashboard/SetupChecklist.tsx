import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { isHandshakeJobSearchUrl } from '@/ui/components/ui-copy';
import { parseHandshakeDocumentId } from '@/core/documents/selection';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useOnboarding } from '@/ui/hooks/useOnboarding';
import type { View } from '@/ui/router';

export function SetupChecklist() {
  const app = useAppContext();
  const onboarding = useOnboarding();
  const settings = app.settings;
  if (!settings) return null;
  const steps: { label: string; complete: boolean; action: string; view: View }[] = [
    {
      label: 'Signed in to Handshake',
      complete:
        onboarding.onboarding?.sessionStatus === 'logged_in' &&
        app.engine?.pauseReason !== 'auth_required',
      action: 'Check sign-in',
      view: 'setup-session',
    },
    {
      label: 'At least one enabled search',
      complete: settings.search.savedSearches.some(
        (search) => search.enabled && isHandshakeJobSearchUrl(search.url),
      ),
      action: 'Add search',
      view: 'setup-search',
    },
    {
      label: 'Default resume added',
      complete: parseHandshakeDocumentId(settings.documents.defaultResumeId ?? '') !== null,
      action: 'Add resume',
      view: 'setup-documents',
    },
    {
      label: 'Run mode chosen',
      complete:
        settings.onboardingComplete &&
        (onboarding.onboarding?.step === 'done' || !!onboarding.onboarding?.completedAt),
      action: 'Choose mode',
      view: 'setup-mode',
    },
  ];
  if (steps.every((step) => step.complete)) return null;
  return (
    <Card tone="warn">
      <h2 className="text-[13px] font-semibold text-ink">Finish your setup</h2>
      <p className="mt-1 text-[11.5px] leading-snug text-muted">
        Check these before starting. Fixing setup keeps your queue and history.
      </p>
      <ul className="mt-2 space-y-2">
        {steps.map((step) => (
          <li
            key={step.view}
            className="flex flex-wrap items-center justify-between gap-1.5 text-[11.5px]"
          >
            <span>
              {step.label} — {step.complete ? 'Ready' : 'Needs attention'}
            </span>
            {!step.complete ? (
              <Button size="sm" variant="secondary" onClick={() => app.navigate(step.view)}>
                {step.action}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
