/** Owns interruptible reads for one worker. Cancellation settles its waiter and
 * aborts cooperative IO; an already issued native promise remains observed.
 * Request state is detached before abort listeners can reenter this owner.
 */
export class WorkerReadRequests {
  readonly #pending = new Map<number, AbortController>();
  #closed = false;

  async run<T>(id: number, invoke: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    if (this.#closed) throw new Error('Worker reads are closed');
    if (this.#pending.has(id)) throw new Error('Worker read request is already active');
    const controller = new AbortController();
    this.#pending.set(id, controller);
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    // Register observation before invoking code that can synchronously cancel,
    // close, throw or complete. Both losing promises remain handled by the race.
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return invoke(controller.signal);
    });
    try {
      const result = await Promise.race([pending, stopped]);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      controller.signal.removeEventListener('abort', abort);
      if (this.#pending.get(id) === controller) this.#pending.delete(id);
    }
  }

  cancel(id: number): void {
    const controller = this.#pending.get(id);
    if (!controller) return;
    this.#pending.delete(id);
    controller.abort(new Error('Worker read cancelled'));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const controllers = [...this.#pending.values()];
    this.#pending.clear();
    for (const controller of controllers) controller.abort(new Error('Worker reads are closed'));
  }
}
