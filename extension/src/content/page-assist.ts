import { PROTOCOL_VERSION, validateProtocolEnvelope } from '@/core/contracts';
import {
  pageAssistRequestSchema,
  pageAssistResponseSchema,
  type PageAssistAnswer,
  type PageAssistQuery,
} from '@/core/contracts/pageAssist';

/** AI page assist is a last resort; it must not stall the application. */
export const PAGE_ASSIST_TIMEOUT_MS = 25_000;

/**
 * Asks the background to choose a control the deterministic selectors missed.
 * The request is bound to the exact in-flight apply attempt, and any failure,
 * malformed reply or timeout resolves to null so the caller keeps its normal
 * deterministic path.
 */
export async function requestPageAssist(
  jobId: string,
  applyRequestId: string,
  query: PageAssistQuery,
): Promise<PageAssistAnswer | null> {
  const request = {
    type: 'engine.pageAssist' as const,
    requestId: crypto.randomUUID(),
    jobId,
    applyRequestId,
    target: query.target,
    scope: query.scope,
    candidates: query.candidates,
  };
  const outbound = pageAssistRequestSchema.safeParse(request);
  if (!outbound.success) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage({ ...request, protocolVersion: PROTOCOL_VERSION }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PAGE_ASSIST_TIMEOUT_MS);
      }),
    ]);
    const parsed = pageAssistResponseSchema.safeParse(response);
    if (
      !validateProtocolEnvelope(response).ok ||
      !parsed.success ||
      parsed.data.requestId !== request.requestId
    )
      return null;
    return parsed.data.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
