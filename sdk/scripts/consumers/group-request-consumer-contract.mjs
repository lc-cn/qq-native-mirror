import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed compiled composition with controlled group notifications. No addon
 * is loaded and no account is restored or request approved remotely. */
/** @param {string} installedRoot */
export async function verifyGroupRequestConsumer(installedRoot) {
  const [{ createNativeServices }, { prepareCommand }, { QQClient }] = await Promise.all([
    /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/native-services.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/cli.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/index.js')).href)
    ),
  ]);
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  /** @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>} */
  const settleWithin = async (promise) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Group request settlement deadline exceeded')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const deferred = () => {
    /** @type {(value:unknown)=>void} */
    let resolve = () => assert.fail('Deferred resolver not initialized');
    /** @type {(reason:unknown)=>void} */
    let reject = () => assert.fail('Deferred rejecter not initialized');
    /** @type {Promise<unknown>} */
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const notice = (sequence = '11', type = 7) => ({
    seq: sequence,
    type,
    status: 1,
    group: { groupCode: '123' },
    postscript: 'controlled request',
  });
  /** @param {(name:string,payload:unknown)=>void} [onEvent] */
  const fixture = (onEvent = () => {}) => {
    /** @type {Map<unknown,import('../../src/features/groups/group-requests.ts').GroupRequestListener>} */
    const listeners = new Map();
    /** @type {unknown[]} */
    const removed = [];
    /** @type {unknown[][]} */
    const calls = [];
    /** @type {[string,unknown][]} */
    const events = [];
    /** @type {Required<import('../../src/features/groups/group-requests.ts').GroupRequestPort>} */
    const group = {
      addKernelGroupListener(listener) {
        const id = Object.freeze({ registration: listeners.size + 1 });
        listeners.set(id, listener);
        return id;
      },
      removeKernelGroupListener(id) {
        removed.push(id);
      },
      getSingleScreenNotifies(...args) {
        calls.push(['get', ...args]);
        return { result: 0 };
      },
      operateSysNotify(...args) {
        calls.push(['operate', ...args]);
        return undefined;
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => group,
      },
      version: '7.0.2-53644',
      events: {
        emit(/** @type {string} */ name, /** @type {unknown} */ payload) {
          events.push([name, payload]);
          onEvent(name, payload);
        },
      },
    });
    const application = [...listeners.entries()].find(([, listener]) =>
      Object.hasOwn(listener, 'onGroupSingleScreenNotifies'),
    );
    assert.ok(application, 'composition must register its application listener');
    const [listenerId, listener] = application;
    return { services, group, calls, events, removed, listenerId, listener };
  };
  for (const method of /** @type {const} */ (['listGroupRequests', 'handleGroupRequest']))
    assert.equal(typeof QQClient.prototype[method], 'function');

  // An early page is insufficient: the native acknowledgement also must succeed.
  const serial = fixture();
  const acknowledgement = deferred();
  serial.group.getSingleScreenNotifies = (...args) => {
    serial.calls.push(['get', ...args]);
    serial.listener.onGroupSingleScreenNotifies(args[0], '20', [notice()]);
    return serial.calls.length === 1 ? acknowledgement.promise : { result: 0 };
  };
  try {
    const action = await prepareCommand('group-requests', {
      doubt: 'true',
      before: '10',
      limit: '3',
    });
    const facadeWorker = new ChildProcess();
    Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
    const facade = new QQClient(facadeWorker, 5000);
    facadeWorker.emit('exit', 0, null);
    try {
      facade.listGroupRequests = async (options) => {
        const value = await serial.services.invokeOperation('listGroupRequests', { options });
        assert.ok(value && typeof value === 'object' && 'requests' in value && 'next' in value);
        assert.ok(Array.isArray(value.requests) && typeof value.next === 'string');
        // Composition was exercised above; retain its actual page through the public port.
        return /** @type {import('../../src/contracts/groups.ts').GroupRequestPage} */ (value);
      };
      const first = action(facade);
      const options = { doubt: false, before: '20', limit: 2 };
      const second = serial.services.invokeOperation('listGroupRequests', { options });
      options.before = '999';
      await turn();
      assert.deepEqual(serial.calls, [['get', true, '10', 3]]);
      acknowledgement.resolve({ result: 0 });
      const page = await first;
      assert.ok(page && typeof page === 'object' && 'next' in page && 'requests' in page);
      assert.ok(Array.isArray(page.requests));
      assert.equal(page.next, '20');
      assert.equal(page.requests[0].kind, 'join');
      assert.equal(page.requests[0].doubt, true);
      await second;
      assert.deepEqual(serial.calls[1], ['get', false, '20', 2]);
    } finally {
      await facade.close();
    }
  } finally {
    serial.services.close();
  }
  assert.equal(serial.removed.filter((id) => id === serial.listenerId).length, 1);

  const failed = fixture();
  failed.group.getSingleScreenNotifies = (...args) => {
    failed.calls.push(['get', ...args]);
    failed.listener.onGroupSingleScreenNotifies(false, '', []);
    return { result: 73 };
  };
  try {
    await assert.rejects(failed.services.invokeOperation('listGroupRequests'), { code: 73 });
    await assert.rejects(
      failed.services.invokeOperation('listGroupRequests'),
      /invalid.*recreate/i,
    );
    assert.equal(failed.calls.length, 1, 'failed uncorrelated queries cannot be replayed');
    failed.listener.onGroupNotifiesUpdated(false, [notice()]);
    assert.equal(failed.events.filter(([name]) => name === 'request.group').length, 1);
  } finally {
    failed.services.close();
  }

  const decision = fixture();
  try {
    const action = await prepareCommand('group-request', {
      'group-id': '123',
      sequence: '11',
      type: '7',
      accept: 'false',
      doubt: 'true',
      reason: '',
    });
    const facadeWorker = new ChildProcess();
    Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
    const facade = new QQClient(facadeWorker, 5000);
    facadeWorker.emit('exit', 0, null);
    try {
      facade.handleGroupRequest = async (request, accept, reason) => {
        await decision.services.invokeOperation('handleGroupRequest', { request, accept, reason });
      };
      await action(facade);
      assert.deepEqual(decision.calls, [
        [
          'operate',
          true,
          {
            operateType: 2,
            targetMsg: { seq: '11', type: 7, groupCode: '123', postscript: '' },
          },
        ],
      ]);
    } finally {
      await facade.close();
    }
  } finally {
    decision.services.close();
  }

  const closing = fixture();
  const late = deferred();
  closing.group.operateSysNotify = (...args) => {
    closing.calls.push(['operate', ...args]);
    return late.promise;
  };
  const waiting = closing.services.invokeOperation('handleGroupRequest', {
    request: { groupId: '123', sequence: '11', type: 7, doubt: false },
    accept: true,
  });
  const rejected = assert.rejects(settleWithin(waiting), /abort|closed/i);
  await turn();
  closing.services.close();
  await rejected;
  late.reject(new Error('controlled late native failure'));
  await turn();
  assert.equal(closing.calls.length, 1);
  assert.equal(closing.removed.filter((id) => id === closing.listenerId).length, 1);

  const accessor = fixture();
  accessor.group.operateSysNotify = () => {
    accessor.calls.push(['operate']);
    return {
      get result() {
        accessor.services.close();
        return 0;
      },
    };
  };
  await assert.rejects(
    accessor.services.invokeOperation('handleGroupRequest', {
      request: { groupId: '123', sequence: '11', type: 7, doubt: false },
      accept: true,
    }),
    /abort|closed/i,
  );
  assert.equal(accessor.calls.length, 1);

  const observer = fixture((name) => {
    if (name === 'request.group') observer.services.close();
  });
  observer.listener.onGroupNotifiesUpdated(false, [notice('11'), notice('12')]);
  assert.equal(observer.events.filter(([name]) => name === 'request.group').length, 1);

  return {
    groupRequestInstalledComposition: true,
    groupRequestSerialCursorContract: true,
    groupRequestDualCompletionContract: true,
    groupRequestFailureQuarantineContract: true,
    groupRequestDecisionCliContract: true,
    groupRequestPendingCloseContract: true,
    groupRequestStatusRetirementContract: true,
    groupRequestObserverCloseContract: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
