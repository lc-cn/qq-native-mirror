import { withCleanupFailure } from '../runtime/cleanup.ts';

type NativeResponse = Pick<Response, 'ok' | 'status' | 'body'>;
interface ResponseReadPolicy {
  maxBytes: number;
  signal?: AbortSignal;
  errors: {
    http(status: number): string;
    empty(status: number): string;
    tooLarge: string;
  };
}
type Failure = { error: unknown };

function retainFailure(primary: Failure | undefined, cleanup: unknown): Failure {
  if (!primary) return { error: cleanup };
  return Object.is(primary.error, cleanup)
    ? primary
    : { error: withCleanupFailure(primary.error, cleanup) };
}

/** Discard one response before its caller follows or rejects a redirect.
 * A wrapped primary preserves even JavaScript's `throw undefined`.
 * Cancellation uses the original request's policy; no extra deadline is imposed.
 */
export async function discardNativeResponse(
  response: Pick<Response, 'body'>,
  primary?: Failure,
): Promise<void> {
  let failure = primary;
  try {
    await response.body?.cancel();
  } catch (cleanup) {
    failure = retainFailure(failure, cleanup);
  }
  if (failure) throw failure.error;
}

/** Own one bounded response read, including failure cancellation and reader release.
 * Fetching, redirect trust, hashes and metadata interpretation stay with callers.
 */
export async function readNativeResponse(
  response: NativeResponse,
  policy: ResponseReadPolicy,
): Promise<Buffer> {
  const signal = policy.signal;
  if (signal?.aborted) await discardNativeResponse(response, { error: signal.reason });
  if (!response.ok) {
    await discardNativeResponse(response, {
      error: new Error(policy.errors.http(response.status)),
    });
  }
  const body = response.body;
  if (!body) throw new Error(policy.errors.empty(response.status));
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (error) {
    await discardNativeResponse({ body }, { error });
    // discard always rejects when supplied a primary, including undefined.
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let failure: Failure | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown) =>
    (cancellation ??= Promise.resolve().then(() => reader.cancel(reason)));
  const aborted = () => {
    void cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > policy.maxBytes) throw new Error(policy.errors.tooLarge);
      chunks.push(Buffer.from(chunk.value));
    }
    signal?.throwIfAborted();
  } catch (error) {
    failure = { error };
    try {
      await cancel(error);
    } catch (cleanup) {
      failure = retainFailure(failure, cleanup);
    }
  }
  try {
    reader.releaseLock();
  } catch (cleanup) {
    failure = retainFailure(failure, cleanup);
  }
  signal?.removeEventListener('abort', aborted);
  if (failure) throw failure.error;
  return Buffer.concat(chunks);
}
