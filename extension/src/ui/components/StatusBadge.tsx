import type { EngineStatus, JobStatus } from '@/core/contracts';
import { Badge } from './Badge';
import { ENGINE_STATUS_COPY, JOB_STATUS_COPY } from './ui-copy';

export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const copy = JOB_STATUS_COPY[status];
  return (
    <Badge tone={copy.tone} className={className} dot>
      {copy.label}
    </Badge>
  );
}

export function EngineStatusBadge({
  status,
  className,
}: {
  status: EngineStatus;
  className?: string;
}) {
  const copy = ENGINE_STATUS_COPY[status];
  return (
    <Badge tone={copy.tone} className={className} dot>
      {copy.label}
    </Badge>
  );
}
