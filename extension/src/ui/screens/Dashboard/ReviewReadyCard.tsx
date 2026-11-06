import { useState } from 'react';
import { isExternalJob } from '@/core/util/application-policy';
import { ONE_CLICK_APPLY_REVIEW_REASON } from '@/core/documents/selection';
import { sendRequest } from '@/ui/bridge';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useQueue } from '@/ui/hooks/useQueue';
import { displayedRunMode } from './RunModeNotice';

export function ReviewReadyCard() {
  const app = useAppContext();
  const queue = useQueue();
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const ready = queue.items.filter(
    (item) =>
      item.status === 'ready_for_review' && !isExternalJob(queue.jobsById.get(item.jobId), item),
  );
  if (ready.length === 0 || displayedRunMode(app.settings, app.engine) === 'dry_run') return null;
  const reviewingEveryApplication =
    displayedRunMode(app.settings, app.engine) === 'review' ||
    app.settings?.safety.reviewBeforeSubmit;
  const oneClickReason = (jobId: string) => {
    const message = queue.needs.find((entry) => entry.jobId === jobId)?.message;
    return message?.startsWith(ONE_CLICK_APPLY_REVIEW_REASON) ? message : undefined;
  };

  const open = async (jobId: string) => {
    // Only the current job can be the runner's existing application. Older
    // pending jobs go to Needs You; never reload/requeue a ready application.
    if (app.engine?.currentJobId !== jobId) {
      app.navigate('needs');
      app.notify('info', 'Find this application in Needs you and open its posting.');
      return;
    }
    setBusyJobId(jobId);
    const result = await sendRequest({ type: 'ui.runner.focus' });
    setBusyJobId(null);
    if (!result.ok || !result.value.focused) {
      app.notify(
        result.ok ? 'info' : 'error',
        result.ok
          ? 'The runner tab is closed. Open the posting from Needs you.'
          : result.error.message,
      );
      app.navigate('needs');
    }
  };

  return (
    <Card tone="accent" className="mb-3">
      <h2 className="text-[13px] font-semibold leading-snug text-ink">
        {ready.length} {ready.length === 1 ? 'application is' : 'applications are'} ready for you to
        submit on Handshake
      </h2>
      <p className="mt-1 text-[11.5px] leading-snug text-muted">
        {reviewingEveryApplication
          ? 'You chose to review applications before submitting, so Handshook stops here and never clicks Submit for you.'
          : 'Handshook stopped here because this application needs something only you can confirm. Open it on Handshake to finish.'}
      </p>
      <ul className="mt-2 space-y-2">
        {ready.map((item) => (
          <li key={item.jobId} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 break-words text-[12px] text-ink">
              <span>{queue.jobsById.get(item.jobId)?.title ?? `Job ${item.jobId}`}</span>
              {oneClickReason(item.jobId) ? (
                <p className="mt-1 text-[11.5px] leading-snug text-muted">
                  {oneClickReason(item.jobId)}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="primary"
              loading={busyJobId === item.jobId}
              onClick={() => void open(item.jobId)}
            >
              Open job
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
