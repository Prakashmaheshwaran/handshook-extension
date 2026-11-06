import { PROTOCOL_VERSION, validateProtocolEnvelope } from '@/core/contracts';
import {
  answerAssistRequestSchema,
  answerAssistResponseSchema,
  type AnswerAssistMatch,
  type AnswerAssistQuery,
} from '@/core/contracts/answerAssist';
import {
  answerWriteRequestSchema,
  answerWriteResponseSchema,
  type AnswerWriteResult,
} from '@/core/contracts/answerWrite';

/** AI answer assist is a fallback; it must not stall the application. */
export const ANSWER_ASSIST_TIMEOUT_MS = 25_000;

/**
 * Asks the background which saved answer each question is asking for. The
 * request carries only the form's own question text and choices, is bound to
 * the exact in-flight apply attempt, and any failure, malformed reply or
 * timeout resolves to null so the caller keeps its normal deterministic path.
 */
export async function requestAnswerAssist(
  jobId: string,
  applyRequestId: string,
  questions: AnswerAssistQuery,
): Promise<AnswerAssistMatch[] | null> {
  const request = {
    type: 'engine.answerAssist' as const,
    requestId: crypto.randomUUID(),
    jobId,
    applyRequestId,
    questions,
  };
  const outbound = answerAssistRequestSchema.safeParse(request);
  if (!outbound.success) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage({ ...outbound.data, protocolVersion: PROTOCOL_VERSION }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ANSWER_ASSIST_TIMEOUT_MS);
      }),
    ]);
    const parsed = answerAssistResponseSchema.safeParse(response);
    if (
      !validateProtocolEnvelope(response).ok ||
      !parsed.success ||
      parsed.data.requestId !== request.requestId
    )
      return null;
    return parsed.data.data.matches;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the background to write answers the bank could not supply. Same binding,
 * timeout and fail-closed behaviour as `requestAnswerAssist`.
 */
export async function requestAnswerWrite(
  jobId: string,
  applyRequestId: string,
  questions: AnswerAssistQuery,
): Promise<AnswerWriteResult[] | null> {
  const request = {
    type: 'engine.answerWrite' as const,
    requestId: crypto.randomUUID(),
    jobId,
    applyRequestId,
    questions,
  };
  const outbound = answerWriteRequestSchema.safeParse(request);
  if (!outbound.success) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage({ ...outbound.data, protocolVersion: PROTOCOL_VERSION }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ANSWER_ASSIST_TIMEOUT_MS);
      }),
    ]);
    const parsed = answerWriteResponseSchema.safeParse(response);
    if (
      !validateProtocolEnvelope(response).ok ||
      !parsed.success ||
      parsed.data.requestId !== request.requestId
    )
      return null;
    return parsed.data.data.answers;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
