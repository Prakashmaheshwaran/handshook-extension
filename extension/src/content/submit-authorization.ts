import {
  submitAuthorizationResponseSchema,
  type SubmitAuthorizationRequest,
} from '@/core/contracts/submitAuthorization';
import { PROTOCOL_VERSION, validateProtocolEnvelope } from '@/core/contracts';

/** No reply, malformed reply, channel failure or timeout means human review. */
export async function requestSubmitAuthorization(
  jobId: string,
  applyRequestId: string,
): Promise<boolean> {
  const request: SubmitAuthorizationRequest = {
    type: 'engine.authorizeSubmit',
    requestId: crypto.randomUUID(),
    jobId,
    applyRequestId,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage({ ...request, protocolVersion: PROTOCOL_VERSION }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2_000);
      }),
    ]);
    const parsed = submitAuthorizationResponseSchema.safeParse(response);
    return (
      validateProtocolEnvelope(response).ok &&
      parsed.success &&
      parsed.data.requestId === request.requestId &&
      parsed.data.data.authorized
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
