import { Badge } from '@/ui/components/Badge';
import { Card } from '@/ui/components/Card';
import { IconClock, IconDocument, IconLock, IconShield } from '@/ui/components/icons';

export function WelcomeStep() {
  return (
    <div className="space-y-3">
      <Card>
        <h2 className="text-[15px] font-semibold leading-snug text-ink">
          Apply without the copy-paste marathon
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Handshook fills and submits Handshake applications with your existing session, documents,
          and reusable answers. Review is optional; you can turn it on any time.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="accent">Applies for you</Badge>
          <Badge tone="info">Runs locally</Badge>
          <Badge tone="neutral">
            <IconClock size={11} /> About 3 minutes
          </Badge>
        </div>
      </Card>

      <Card tone="muted">
        <ul className="space-y-2.5">
          <li className="flex gap-2">
            <IconDocument size={15} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-[12.5px] font-medium text-ink">Your documents stay yours</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
                Handshook picks from resumes already uploaded to Handshake. It never uploads or
                edits a file.
              </p>
            </div>
          </li>
          <li className="flex gap-2">
            <IconShield size={15} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-[12.5px] font-medium text-ink">
                Nothing runs until you press Start
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
                Handshook applies for you by default: it fills and submits applications that meet
                your rules. Anything uncertain waits for you instead of being guessed.
              </p>
            </div>
          </li>
          <li className="flex gap-2">
            <IconLock size={15} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-[12.5px] font-medium text-ink">No password, ever</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
                Handshook uses the session already in your browser. It cannot log in for you and
                never stores your Handshake password or exports your cookies.
              </p>
            </div>
          </li>
        </ul>
      </Card>

      <p className="text-[11px] leading-snug text-muted">
        You can change every choice later in Settings. Handshook is not affiliated with Handshake.
      </p>
    </div>
  );
}
