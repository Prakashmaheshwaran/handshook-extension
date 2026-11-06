import { AiProviderError, providerError } from '@/ai/types';

export const AI_REQUEST_TIMEOUT_MS = 25_000;
export const AI_AVAILABILITY_TIMEOUT_MS = 3_000;

function abortError(signal: AbortSignal): AiProviderError {
  return signal.reason instanceof AiProviderError
    ? signal.reason
    : providerError('CANCELLED', 'Resume matching was cancelled', { retryable: true });
}

/** Settle even when a browser API ignores AbortSignal; always detach the listener. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? abortError(signal) : error);
      },
    );
  });
}

/** One deadline includes throttling, request headers, and the response body. */
export function requestScope(parent?: AbortSignal, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        providerError('TIMEOUT', 'AI matching timed out; using basic matching.', {
          retryable: true,
        }),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
