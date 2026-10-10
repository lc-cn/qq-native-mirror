/** A worker response carries an opaque business result, never a native assertion. */
export type WorkerRpcResponse =
  { id: number; result?: unknown; error?: never } | { id: number; error: unknown; result?: never };
export interface WorkerRpcTransport {
  send(
    message: { id: number; method: string } & object,
    callback: (error: Error | null) => void,
  ): unknown;
}
interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface WorkerRpcPolicy {
  failure(method: string, error: Error): Error;
  responseFailure(method: string, error: unknown): Error;
  /** Client owns login retirement; the channel owns removing its request first. */
  timeout?(method: string, error: Error): Error | Promise<Error>;
}

/** Owns request IDs and timers. Every terminal path removes before settlement.
 * Late replies/send callbacks are ignored; failed requests are never replayed.
 * Generation and worker termination remain responsibilities of the owning Client.
 */
export class WorkerRpcChannel {
  #next = 0;
  #pending = new Map<number, Pending>();
  private readonly transport: () => WorkerRpcTransport;
  private readonly policy: WorkerRpcPolicy;
  constructor(transport: () => WorkerRpcTransport, policy: WorkerRpcPolicy) {
    this.transport = transport;
    this.policy = policy;
  }
  request(method: string, payload: object, timeoutMs: number): Promise<unknown> {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#take(id);
        if (!pending) return;
        const error = new Error(`Kernel ${method} timed out`);
        // Attach rejection handling even when retirement throws synchronously.
        try {
          const outcome = this.policy.timeout?.(method, error) ?? error;
          void Promise.resolve(outcome).then(
            (value) => pending.reject(this.policy.failure(method, value)),
            (failure) =>
              pending.reject(failure instanceof Error ? failure : new Error(String(failure))),
          );
        } catch (failure) {
          pending.reject(failure instanceof Error ? failure : new Error(String(failure)));
        }
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      const fail = (error: Error) => {
        const pending = this.#take(id);
        if (pending) pending.reject(this.policy.failure(method, error));
      };
      try {
        this.transport().send({ id, method, ...payload }, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const response = value as Partial<WorkerRpcResponse>;
    if (typeof response.id !== 'number') return;
    const pending = this.#take(response.id);
    if (!pending) return;
    if (response.error) pending.reject(this.policy.responseFailure(pending.method, response.error));
    else pending.resolve(response.result);
  }
  rejectPending(error: Error, keep?: (method: string) => boolean): void {
    for (const [id, value] of this.#pending) {
      if (keep?.(value.method)) continue;
      const pending = this.#take(id)!;
      pending.reject(this.policy.failure(pending.method, error));
    }
  }
  #take(id: number): Pending | undefined {
    const value = this.#pending.get(id);
    if (!value) return;
    this.#pending.delete(id);
    clearTimeout(value.timer);
    return value;
  }
}
