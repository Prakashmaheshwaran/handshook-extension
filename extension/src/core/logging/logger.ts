import type { EventLevel, JobEvent } from '@/core/contracts';
import { appendEvent } from '@/core/logging/eventStore';
import { redactData, redactText } from '@/core/logging/redact';
import { uuid } from '@/core/util/hash';

function localIdentifier(value: string): string {
  // Local Activity joins/filtering require the actual job/event identifiers.
  // Diagnostics removes these entirely at its separate export boundary.
  return /^(?:\d{1,20}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ? value
    : redactText(value);
}

export function makeEvent(
  level: EventLevel,
  type: string,
  message: string,
  options: { jobId?: string; data?: Record<string, unknown> } = {},
): JobEvent {
  return {
    id: uuid(),
    at: Date.now(),
    level,
    type: redactText(type),
    jobId: options.jobId === undefined ? undefined : localIdentifier(options.jobId),
    message: redactText(message),
    data: options.data ? (redactData(options.data) as Record<string, unknown>) : undefined,
  };
}

export async function logEvent(event: JobEvent): Promise<void> {
  try {
    // Content events can bypass makeEvent. Redact again at the persistence
    // boundary and explicitly discard unknown top-level fields.
    await appendEvent({
      id: localIdentifier(event.id),
      at: event.at,
      level: event.level,
      type: redactText(event.type),
      jobId: event.jobId === undefined ? undefined : localIdentifier(event.jobId),
      message: redactText(event.message),
      data: event.data ? (redactData(event.data) as Record<string, unknown>) : undefined,
    });
  } catch {
    // Logging must never break the application.
  }
}

export async function log(
  level: EventLevel,
  type: string,
  message: string,
  options: { jobId?: string; data?: Record<string, unknown> } = {},
): Promise<JobEvent> {
  const event = makeEvent(level, type, message, options);
  await logEvent(event);
  return event;
}
