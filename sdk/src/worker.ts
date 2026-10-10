import { serializeKernelError } from './errors.ts';
import { createWorkerBootstrap } from './worker/bootstrap.ts';
import type { ClientOptions, LoginRequest } from './contracts/client.ts';
import { isServiceOperation, isCancellableRead } from './runtime/operations.ts';
import { WorkerReadRequests } from './runtime/worker-read-requests.ts';
import { observeWorkerTask } from './runtime/worker-task.ts';

const send = (value: unknown) => {
  if (process.connected) process.send?.(value);
};
const bootstrap = createWorkerBootstrap((event, payload) =>
  send({
    event,
    payload:
      payload instanceof Error
        ? { message: serializeKernelError(payload).message }
        : Buffer.isBuffer((payload as { image?: unknown })?.image)
          ? {
              ...(payload as object),
              image: (payload as { image: Buffer }).image.toString('base64'),
            }
          : payload,
  }),
);
const reads = new WorkerReadRequests();
process.on('exit', () => {
  reads.close();
  bootstrap.releaseOnExit();
});
async function onMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object') return;
  const control = message as { control?: unknown; id?: unknown };
  if (control.control === 'cancel-read') {
    if (Number.isSafeInteger(control.id) && (control.id as number) > 0)
      reads.cancel(control.id as number);
    return;
  }
  const request = message as {
    id: number;
    method: string;
    options?: ClientOptions;
    login?: LoginRequest;
  };
  if (!Number.isSafeInteger(request.id) || request.id <= 0) return;
  let result: unknown;
  let closeSucceeded = false;
  try {
    if (request.method === 'init') {
      result = await bootstrap.initialize(request.options!);
    } else if (request.method === 'login') {
      result = await bootstrap.login(request.login!);
    } else if (isServiceOperation(request.method)) {
      const { id: _id, method, ...payload } = request;
      result = await (isCancellableRead(method)
        ? reads.run(request.id, (signal) => bootstrap.invokeOperation(method, payload, signal))
        : bootstrap.invokeOperation(method, payload));
    } else if (request.method === 'close') {
      reads.close();
      await bootstrap.close();
      result = null;
      closeSucceeded = true;
    } else throw new Error(`Unknown kernel request: ${request.method}`);
  } catch (error) {
    send({ id: request.id, error: serializeKernelError(error) });
    return;
  }
  // Sending can have partially succeeded before throwing. Never reinterpret a
  // transport failure as a business error and attempt a second response.
  send({ id: request.id, result });
  if (closeSucceeded) process.exit(0);
}
process.on('message', (message: unknown) => {
  // Call immediately: cancellation must not wait behind a dispatch microtask.
  observeWorkerTask(onMessage(message));
});
process.on('disconnect', () => {
  reads.close();
  process.exit(0);
});
