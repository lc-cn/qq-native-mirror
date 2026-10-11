/**
 * @typedef {object} ConsumerResources
 * @property {{close(): Promise<void>}} [client]
 * @property {{close(callback:(error?:Error)=>void):unknown, closeAllConnections():void}} server
 * @property {()=>Promise<void>} removeDirectory
 * @property {number} [serverCloseTimeoutMs]
 */

/** Throw one original value unchanged; multiple failures keep their ordering.
 * @param {unknown[]} errors
 */
function finish(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Consumer execution and cleanup failed');
}

/** Stop accepting first, then end retained connections, with a bounded wait.
 * @param {ConsumerResources['server']} server
 * @param {number} timeoutMs
 */
async function closeRegistry(server, timeoutMs) {
  /** @type {{error:unknown}|undefined} */
  let closeFailure;
  /** @type {{error:unknown}|undefined} */
  let invocationFailure;
  /** @type {{error:unknown}|undefined} */
  let connectionFailure;
  let settled = false;
  /** @type {()=>void} */
  let resolve = () => {};
  /** @type {(reason:unknown)=>void} */
  let reject = () => {};
  /** @type {Promise<void>} */
  const closed = new Promise((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  // Observe immediately, including synchronous failures from the close port.
  const observed = closed.catch((error) => {
    closeFailure = { error };
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error('Consumer registry did not close before its deadline'));
  }, timeoutMs);
  try {
    try {
      server.close((error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      invocationFailure = { error };
      settled = true;
      reject(error);
    }
    try {
      server.closeAllConnections();
    } catch (error) {
      connectionFailure = { error };
    }
    await observed;
  } finally {
    clearTimeout(timeout);
  }
  finish([
    ...(closeFailure ? [closeFailure.error] : []),
    ...(invocationFailure && (!closeFailure || invocationFailure.error !== closeFailure.error)
      ? [invocationFailure.error]
      : []),
    ...(connectionFailure ? [connectionFailure.error] : []),
  ]);
}

/** Release all consumer-owned resources once, preserving an existing failure.
 * A wrapped primary distinguishes success from JavaScript's `throw undefined`.
 * No native module, account, registry or filesystem is acquired here.
 * @param {ConsumerResources} resources
 * @param {{error:unknown}} [primary]
 */
export async function closeConsumerResources(resources, primary) {
  /** @type {unknown[]} */
  const errors = primary ? [primary.error] : [];
  try {
    await resources.client?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeRegistry(resources.server, resources.serverCloseTimeoutMs ?? 2000);
  } catch (error) {
    errors.push(error);
  }
  try {
    await resources.removeDirectory();
  } catch (error) {
    errors.push(error);
  }
  finish(errors);
}
