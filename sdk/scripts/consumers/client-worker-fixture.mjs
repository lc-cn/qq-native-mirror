import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';

/** Controlled IPC peer for public installed-client contracts. No process is
 * spawned. Each test supplies responses; close still exercises worker retirement.
 */
export class ClientWorkerFixture extends ChildProcess {
  /** @type {Record<string, unknown>[]} */
  requests = [];
  /** @type {{message: string, code: number} | undefined} */
  failure;
  /** @type {(command: Record<string, unknown>) => unknown} */
  respond = () => undefined;

  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }

  /** @param {import('node:child_process').Serializable} message
   * @param {unknown[]} args */
  send(message, ...args) {
    assert.ok(message && typeof message === 'object');
    const command = /** @type {Record<string, unknown>} */ (message);
    this.requests.push(command);
    const callback = args.find((value) => typeof value === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    queueMicrotask(() => {
      this.emit(
        'message',
        this.failure
          ? { id: command.id, error: this.failure }
          : { id: command.id, result: this.respond(command) },
      );
      if (command.method === 'close') this.exit();
    });
    return true;
  }

  exit() {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
  }

  kill() {
    this.exit();
    return true;
  }
}
