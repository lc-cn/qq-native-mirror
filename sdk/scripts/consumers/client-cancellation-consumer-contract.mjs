import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

/** The real public factory and client run against a controlled IPC peer. Native
 * preparation reads only fixture files; no addon is loaded or account contacted.
 * @param {typeof import('../../src/index.ts').createClient} createClient
 * @param {typeof import('../../src/index.ts').QQClient} QQClient
 * @param {string} directory
 * @param {string} bridgePath
 */
export async function verifyClientCancellation(createClient, QQClient, directory, bridgePath) {
  const wrapperPath = join(directory, 'cancellation-wrapper.node');
  await writeFile(wrapperPath, 'synthetic cancellation fixture; never loaded');
  const originalFork = childProcess.fork;
  const originalClose = QQClient.prototype.close;
  let forks = 0;
  let closes = 0;
  /** @type {Error | undefined} */
  let cleanupFailure;
  QQClient.prototype.close = async function () {
    closes++;
    await originalClose.call(this);
    if (cleanupFailure) throw cleanupFailure;
  };
  const options = {
    wrapperPath,
    bridgePath,
    dataDir: join(directory, 'cancellation-data'),
    version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
    timeoutMs: 5000,
    autoReconnect: false,
  };
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let worker;
  /** @type {{id:number,method:string,options?:object}[]} */
  let requests = [];
  /** @type {() => void} */
  let initStarted = () => {};
  /** @type {() => void} */
  let closeStarted = () => {};
  childProcess.fork = () => {
    forks++;
    const peer = new childProcess.ChildProcess();
    worker = peer;
    Object.defineProperty(peer, 'connected', { value: true, configurable: true });
    peer.send = /** @type {typeof peer.send} */ (
      (message, callback) => {
        assert.ok(message && typeof message === 'object');
        const command = /** @type {{id:number,method:string,options?:object}} */ (message);
        requests.push(command);
        if (typeof callback === 'function') callback(null);
        if (command.method === 'init') initStarted();
        else if (command.method === 'close') closeStarted();
        else assert.fail('Creation cancellation cannot dispatch login or account operations');
        return true;
      }
    );
    peer.kill = () => {
      Object.defineProperty(peer, 'connected', { value: false, configurable: true });
      Object.defineProperty(peer, 'exitCode', { value: 0, configurable: true });
      queueMicrotask(() => peer.emit('exit', 0, null));
      return true;
    };
    return peer;
  };
  syncBuiltinESMExports();
  /** @param {'init' | 'close'} method @param {object} reply */
  const respond = (method, reply) => {
    const request = requests.find((value) => value.method === method);
    assert.ok(worker && request);
    worker.emit('message', { id: request.id, ...reply });
    if (method === 'close') worker.kill();
  };
  /** @param {AbortController} controller */
  const start = (controller) => {
    requests = [];
    let initialized = new Promise((resolve) => {
      initStarted = () => resolve(undefined);
    });
    const closing = new Promise((resolve) => {
      closeStarted = () => resolve(undefined);
    });
    let settled = false;
    const pending = createClient(options, { signal: controller.signal });
    const outcome = pending.then(
      (client) => {
        settled = true;
        return { ok: true, client };
      },
      (error) => {
        settled = true;
        return { ok: false, error };
      },
    );
    initialized = initialized.then(() => {
      const request = requests.find((value) => value.method === 'init');
      assert.ok(request?.options);
      assert.equal(Object.hasOwn(request.options, 'signal'), false);
      assert.equal(Object.hasOwn(request, 'signal'), false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 2);
    });
    return { initialized, closing, outcome, settled: () => settled };
  };
  try {
    const early = new AbortController();
    const earlyReason = { cancelled: 'before any acquisition' };
    early.abort(earlyReason);
    await assert.rejects(
      createClient({ dataDir: '' }, { signal: early.signal }),
      (error) => error === earlyReason,
    );
    assert.equal(forks, 0);
    assert.equal(closes, 0);

    const captured = new AbortController();
    const capturedReason = new Error('cancel while options are captured');
    await assert.rejects(
      createClient(
        {
          ...options,
          get device() {
            captured.abort(capturedReason);
            return { hostname: 'fixture' };
          },
        },
        { signal: captured.signal },
      ),
      (error) => error === capturedReason,
    );
    assert.equal(forks, 0);
    assert.equal(closes, 0);

    for (const failCleanup of [false, true]) {
      const controller = new AbortController();
      const reason = new Error('cancel during initialization');
      cleanupFailure = failCleanup ? new Error('controlled cleanup failure') : undefined;
      /** @type {number} */
      const before = closes;
      const operation = start(controller);
      await operation.initialized;
      controller.abort(reason);
      await operation.closing;
      assert.equal(operation.settled(), false, 'Cancellation must wait for owned cleanup');
      assert.equal(closes, before + 1);
      respond('close', { result: null });
      const outcome = await operation.outcome;
      assert.equal(outcome.ok, false);
      const error = 'error' in outcome ? outcome.error : undefined;
      if (failCleanup) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [reason, cleanupFailure]);
      } else assert.equal(error, reason);
      assert.equal(closes, before + 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      // An obsolete init rejection must remain observed after cancellation.
      respond('init', { error: { message: 'late init failure', code: 91 } });
      await new Promise((resolve) => setImmediate(resolve));
    }
    cleanupFailure = undefined;

    // The init failure already won; cancellation while it cleans up cannot replace it.
    const failed = new AbortController();
    const failureOperation = start(failed);
    await failureOperation.initialized;
    respond('init', { error: { message: 'original init failure', code: 92 } });
    await failureOperation.closing;
    failed.abort(new Error('later cancellation'));
    respond('close', { result: null });
    const failure = await failureOperation.outcome;
    assert.equal(failure.ok, false);
    assert.ok('error' in failure && failure.error instanceof Error);
    assert.match(failure.error.message, /original init failure/);
    assert.equal(getEventListeners(failed.signal, 'abort').length, 0);

    // Abort between successful IPC delivery and factory publication still owns cleanup.
    const racing = new AbortController();
    const racingReason = 'cancel before client publication';
    const race = start(racing);
    await race.initialized;
    respond('init', { result: { exports: ['fixture'] } });
    queueMicrotask(() => racing.abort(racingReason));
    await race.closing;
    respond('close', { result: null });
    const raced = await race.outcome;
    assert.equal(raced.ok, false);
    assert.ok('error' in raced);
    assert.equal(raced.error, racingReason);
    assert.equal(getEventListeners(racing.signal, 'abort').length, 0);

    const complete = new AbortController();
    const success = start(complete);
    await success.initialized;
    respond('init', { result: { exports: ['fixture'] } });
    const completed = await success.outcome;
    assert.ok(completed.ok && 'client' in completed);
    const client = completed.client;
    assert.equal(getEventListeners(complete.signal, 'abort').length, 0);
    const before = closes;
    complete.abort(new Error('creation already completed'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes, before);
    assert.equal(client.state, 'idle');
    assert.deepEqual(client.nativeExports, ['fixture']);
    const closing = client.close();
    await success.closing;
    respond('close', { result: null });
    await closing;
    assert.equal(closes, before + 1);
    return { clientFactoryCancellationContract: true };
  } finally {
    QQClient.prototype.close = originalClose;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
    if (worker?.exitCode === null) worker.kill();
  }
}
