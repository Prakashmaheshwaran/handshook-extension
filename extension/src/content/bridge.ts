import type { z } from 'zod';
import type { ContentEvent, ContentRequest, MessageResponse } from '@/core/contracts';
import {
  PROTOCOL_VERSION,
  appError,
  contentRequestSchema,
  isRecord,
  validateProtocolEnvelope,
} from '@/core/contracts';

type Handler = (request: ContentRequest) => Promise<MessageResponse<unknown>>;
type CommandHandler = (message: unknown) => Promise<MessageResponse<unknown>>;
const additionalCommands = new Map<string, CommandHandler>();

/** Extra commands must supply a schema; the common sender/version gates still apply. */
export function registerContentCommand<T extends { requestId: string }>(
  type: string,
  schema: z.ZodType<T>,
  handler: (request: T) => Promise<MessageResponse<unknown>>,
): void {
  additionalCommands.set(type, async (message) => {
    const parsed = schema.safeParse(message);
    if (!parsed.success) return invalidRequest(message);
    return handler(parsed.data);
  });
}

function invalidRequest(message: unknown): MessageResponse<never> {
  return {
    requestId:
      isRecord(message) && typeof message.requestId === 'string' ? message.requestId : 'unknown',
    ok: false,
    error: appError('INVALID_INPUT', 'Handshook rejected an invalid content request.'),
  };
}

function reportRejection(code: string): void {
  // Only constant reason codes; never rejected payloads, IDs, or page URLs.
  void sendContentEvent({
    type: 'content.event.log',
    event: {
      id: crypto.randomUUID(),
      at: Date.now(),
      level: 'warn',
      type: 'messaging.rejected',
      message: `Content request rejected: ${code}`,
    },
  });
}

export function registerContentBridge(handler: Handler): void {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (
      !isRecord(message) ||
      typeof message.type !== 'string' ||
      !message.type.startsWith('content.') ||
      message.type.startsWith('content.event.')
    )
      return false;
    if (!browser.runtime.id || sender.id !== browser.runtime.id || sender.tab) {
      reportRejection('FORBIDDEN');
      return false;
    }
    const protocol = validateProtocolEnvelope(message);
    const respond = (response: MessageResponse<unknown>) =>
      sendResponse({ ...response, protocolVersion: PROTOCOL_VERSION });
    if (!protocol.ok) {
      reportRejection(protocol.error.code);
      respond({ requestId: invalidRequest(message).requestId, ok: false, error: protocol.error });
      return false;
    }
    const additional = additionalCommands.get(message.type);
    const parsed = contentRequestSchema.safeParse(message);
    if (!additional && !parsed.success) {
      reportRejection('INVALID_INPUT');
      respond(invalidRequest(message));
      return false;
    }
    const result = additional ? additional(message) : handler(parsed.data as ContentRequest);
    result
      .then((response) => {
        if (!response.ok && response.error.code === 'INVALID_INPUT')
          reportRejection('INVALID_INPUT');
        respond(response);
      })
      .catch(() => {
        reportRejection('UNKNOWN');
        respond({
          requestId: invalidRequest(message).requestId,
          ok: false,
          error: appError('UNKNOWN', 'Content handler failed'),
        });
      });
    return true;
  });
}

export function isContentRequest(value: unknown): value is ContentRequest {
  return contentRequestSchema.safeParse(value).success;
}

export async function sendContentEvent(event: ContentEvent): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage({ ...event, protocolVersion: PROTOCOL_VERSION }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2_000);
      }),
    ]);
    return validateProtocolEnvelope(response).ok && isRecord(response) && response.ok === true;
  } catch {
    // The background service worker may be asleep or the extension reloaded.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function responseOk<T>(requestId: string, data: T): MessageResponse<T> {
  return { requestId, ok: true, data };
}
