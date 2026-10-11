import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Synthetic services and real temporary filesystem only; no native addon/account.
 * @param {{QQClient:typeof import('../../src/index.ts').QQClient,createNativeServices:typeof import('../../src/native-services.ts').createNativeServices,prepareCommand:typeof import('../../src/cli.ts').prepareCommand}} context */
export async function checkDownloadContract({ QQClient, createNativeServices, prepareCommand }) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-download-contract-'));
  /** @param {(request:Parameters<NonNullable<import('../../src/runtime/media-contracts.ts').AttachmentDownloadPort['downloadRichMedia']>>[0],listener:{onRichMediaDownloadComplete(value:unknown):void})=>unknown} download
   * @param {(ids:string[])=>unknown} [lookup] */
  const make = (download, lookup) => {
    /** @type {{onRichMediaDownloadComplete(value:unknown):void}|undefined} */
    let listener;
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(/** @type {NonNullable<typeof listener>} */ value) {
            listener = value;
          },
          downloadRichMedia(
            /** @type {Parameters<NonNullable<import('../../src/runtime/media-contracts.ts').AttachmentDownloadPort['downloadRichMedia']>>[0]} */ request,
          ) {
            assert.ok(listener);
            return download(request, listener);
          },
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getUixConvertService: () => ({
          getUid:
            lookup ??
            (() => {
              throw Error('Unexpected UID lookup');
            }),
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    return services;
  };
  try {
    const destination = join(directory, 'captured'),
      mutated = join(directory, 'mutated');
    /** @type {(value:unknown)=>void} */
    let releaseUid = () => assert.fail('UID resolver missing');
    let uidCalls = 0,
      downloads = 0;
    const uid = new Promise((resolve) => {
      releaseUid = resolve;
    });
    const services = make(
      async (request, listener) => {
        downloads++;
        assert.equal(request.chatType, 1);
        assert.equal(request.peerUid, 'u_456');
        assert.equal(request.msgId, '0009');
        assert.equal(request.elementId, '02');
        assert.notEqual(request.filePath, destination);
        await writeFile(request.filePath, 'owned attachment fixture');
        listener.onRichMediaDownloadComplete({ msgId: 'unrelated', msgElementId: '02' });
        listener.onRichMediaDownloadComplete({
          msgId: '0009',
          msgElementId: '02',
          chatType: 1,
          fileErrCode: '0',
          fileSrvErrCode: '0',
          filePath: request.filePath,
        });
      },
      (ids) => {
        uidCalls++;
        assert.deepEqual(ids, ['456']);
        return uid;
      },
    );
    try {
      let getters = 0;
      const accessor = {
        peer: { type: 'private', userId: '456' },
        get messageId() {
          getters++;
          return '9';
        },
        elementId: '2',
        destination,
      };
      const base = {
        peer: { type: 'private', userId: '456' },
        messageId: '9',
        elementId: '2',
        destination,
      };
      for (const invalid of [
        accessor,
        { ...base, messageId: 42 },
        { ...base, elementId: 'bad' },
        { ...base, destination: 'relative' },
        { ...base, destination: destination + '\0' },
        { ...base, peer: Object.create({ type: 'private', userId: '456' }) },
      ]) {
        await assert.rejects(services.invokeOperation('downloadAttachment', invalid));
      }
      assert.equal(getters, 0);
      assert.equal(uidCalls, 0);
      assert.equal(downloads, 0);
      assert.deepEqual(await readdir(directory), []);
      const payload = {
        peer: { type: 'private', userId: '456' },
        messageId: '0009',
        elementId: '02',
        destination,
      };
      const pending = services.invokeOperation('downloadAttachment', payload);
      assert.equal(uidCalls, 1);
      payload.peer.userId = '999';
      payload.messageId = '99';
      payload.elementId = '22';
      payload.destination = mutated;
      releaseUid({ uidInfo: new Map([['456', 'u_456']]) });
      assert.deepEqual(await pending, { file: destination });
      assert.equal(downloads, 1);
      assert.equal(await readFile(destination, 'utf8'), 'owned attachment fixture');
      assert.deepEqual(await readdir(directory), ['captured']);
    } finally {
      services.close();
    }

    // A native cache path can differ from requested staging; it is not deleted.
    const cache = join(directory, 'native-cache');
    await writeFile(cache, 'native cache fixture');
    let getterCalls = 0;
    const complete = {
      msgId: '9',
      msgElementId: '2',
      fileErrCode: '0',
      fileSrvErrCode: '0',
      filePath: cache,
      chatType: 2,
    };
    for (const [shape, code] of [
      [{ ...complete, fileErrCode: undefined }, 'invalid-result'],
      [{ ...complete, fileSrvErrCode: undefined }, 'invalid-result'],
      [{ ...complete, fileSrvErrCode: NaN }, 'invalid-result'],
      [{ ...complete, chatType: 1 }, 'invalid-result'],
      [{ ...complete, filePath: cache + '\0private' }, 'invalid-result'],
      [{ ...complete, filePath: join(directory, 'native-private-missing') }, 'ENOENT'],
      [
        {
          ...complete,
          get filePath() {
            getterCalls++;
            return cache;
          },
        },
        'invalid-result',
      ],
      [{ ...complete, fileErrCode: '73' }, '73'],
      [{ ...complete, fileSrvErrCode: 42 }, 42],
    ]) {
      let calls = 0;
      const failed = make((_request, listener) => {
        calls++;
        listener.onRichMediaDownloadComplete(shape);
      });
      try {
        await assert.rejects(
          failed.invokeOperation('downloadAttachment', {
            peer: { type: 'group', groupId: '123' },
            messageId: '9',
            elementId: '2',
            destination: join(directory, 'rejected'),
          }),
          (error) => {
            assert.ok(error instanceof Error && 'code' in error);
            assert.equal(error.code, code);
            assert.doesNotMatch(error.message, /native-private-missing|private|native-cache/);
            return true;
          },
        );
        assert.equal(calls, 1);
      } finally {
        failed.close();
      }
      assert.deepEqual((await readdir(directory)).sort(), ['captured', 'native-cache']);
    }
    assert.equal(getterCalls, 0);
    const cacheConsumer = make((_request, listener) => {
      listener.onRichMediaDownloadComplete(complete);
    });
    try {
      assert.deepEqual(
        await cacheConsumer.invokeOperation('downloadAttachment', {
          peer: { type: 'group', groupId: '123' },
          messageId: '9',
          elementId: '2',
          destination: join(directory, 'cache-copy'),
        }),
        { file: join(directory, 'cache-copy') },
      );
    } finally {
      cacheConsumer.close();
    }
    assert.equal(await readFile(cache, 'utf8'), 'native cache fixture');

    // Destination created during transfer remains intact (exclusive publication).
    const owned = join(directory, 'already-owned');
    let collisionCalls = 0;
    const collision = make(async (request, listener) => {
      collisionCalls++;
      await writeFile(owned, 'caller file');
      await writeFile(request.filePath, 'replacement');
      listener.onRichMediaDownloadComplete({ ...complete, filePath: request.filePath });
    });
    try {
      await assert.rejects(
        collision.invokeOperation('downloadAttachment', {
          peer: { type: 'group', groupId: '123' },
          messageId: '9',
          elementId: '2',
          destination: owned,
        }),
        { code: 'EEXIST' },
      );
      assert.equal(collisionCalls, 1);
      assert.equal(await readFile(owned, 'utf8'), 'caller file');
    } finally {
      collision.close();
    }

    /** @type {()=>void} */
    let entered = () => assert.fail('Begin resolver missing');
    /** @type {(reason:unknown)=>void} */
    let rejectLate = () => assert.fail('Late rejecter missing');
    let stalledCalls = 0;
    /** @type {Promise<void>} */
    /** @type {Promise<void>} */
    const began = new Promise((resolve) => {
      entered = resolve;
    });
    const late = new Promise((_resolve, reject) => {
      rejectLate = reject;
    });
    const stopped = make(() => {
      stalledCalls++;
      entered();
      return late;
    });
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      const pending = stopped.invokeOperation('downloadAttachment', {
        peer: { type: 'group', groupId: '123' },
        messageId: '9',
        elementId: '2',
        destination: join(directory, 'closed'),
      });
      const rejected = assert.rejects(pending, /closed|abort/i);
      await began;
      stopped.close();
      await Promise.race([
        rejected,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('Download remained pending after close')), 1000);
        }),
      ]);
      rejectLate(Error('late native download rejection'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stalledCalls, 1);
    } finally {
      clearTimeout(timer);
      stopped.close();
    }
    assert.equal(
      (await readdir(directory)).some((n) => n.startsWith('.qq-download-')),
      false,
    );

    // Public preflight captures peer before sending any IPC.
    /** @type {(Record<string,unknown>&{id:number,method:string})[]} */
    const requests = [];
    const worker = new ChildProcess();
    Object.defineProperty(worker, 'connected', { value: true, configurable: true });
    Object.defineProperty(worker, 'send', {
      value: (
        /** @type {Record<string,unknown>&{id:number,method:string}} */ request,
        /** @type {(error:Error|null)=>void} */ done,
      ) => {
        requests.push(request);
        done(null);
        if (request.method === 'close')
          queueMicrotask(() => {
            worker.emit('message', { id: request.id, result: null });
            setImmediate(() => {
              Object.defineProperty(worker, 'connected', { value: false, configurable: true });
              Object.defineProperty(worker, 'exitCode', { value: 0, configurable: true });
              worker.emit('exit', 0, null);
            });
          });
        return true;
      },
    });
    Object.defineProperty(worker, 'kill', {
      value: () => {
        Object.defineProperty(worker, 'connected', { value: false, configurable: true });
        queueMicrotask(() => worker.emit('exit', 0, null));
        return true;
      },
    });
    const client = new QQClient(worker, 500);
    worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
    try {
      await assert.rejects(
        client.downloadAttachment({ type: 'group', groupId: '123' }, 'bad', '2', destination),
      );
      assert.equal(requests.length, 0);
      /** @type {Extract<import('../../src/contracts/messages.ts').Peer,{type:'group'}>} */
      const peer = { type: 'group', groupId: '123' };
      const promise = client.downloadAttachment(peer, '0009', '02', destination);
      peer.groupId = '999';
      const request = requests.at(-1);
      assert.ok(request);
      assert.equal(request.method, 'downloadAttachment');
      assert.deepEqual(request.peer, { type: 'group', groupId: '123' });
      assert.equal(request.messageId, '0009');
      worker.emit('message', { id: request.id, result: { file: destination } });
      assert.deepEqual(await promise, { file: destination });
    } finally {
      await client.close();
    }
    /** @type {Parameters<import('../../src/index.ts').QQClient['downloadAttachment']>[]} */
    const calls = [];
    const facadeWorker = new ChildProcess();
    Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
    const facade = new QQClient(facadeWorker, 5000);
    facadeWorker.emit('exit', 0, null);
    try {
      facade.downloadAttachment = async (...args) => {
        calls.push(args);
        return { file: destination };
      };
      await (
        await prepareCommand('download', {
          kind: 'group',
          target: '123',
          'message-id': '0009',
          'element-id': '02',
          destination,
        })
      )(facade);
      assert.deepEqual(calls, [[{ type: 'group', groupId: '123' }, '0009', '02', destination]]);
    } finally {
      await facade.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** @param {string} packageRoot */
export async function verifyDownloadConsumer(packageRoot) {
  const { QQClient } = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
    ),
    { createNativeServices } =
      await /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href)
      ),
    { prepareCommand } = await /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
    );
  await checkDownloadContract({ QQClient, createNativeServices, prepareCommand });
  const ownerChecks = await verifyDownloadOwner(packageRoot);
  return {
    ...ownerChecks,
    attachmentDownloadContract: true,
    nativeAttachmentDownloadAttempted: false,
  };
}

/** Local owner cancellation uses the installed shared channel without closing sibling waits. */
/** @param {string} packageRoot */
async function verifyDownloadOwner(packageRoot) {
  const { createAttachmentDownloads } =
    await /** @type {Promise<typeof import('../../src/features/media/attachment-downloads.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/media/attachment-downloads.js')).href)
    );
  const { createNativeEventChannel } =
    await /** @type {Promise<typeof import('../../src/runtime/native-event-channel.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/runtime/native-event-channel.js')).href)
    );
  const directory = await mkdtemp(join(tmpdir(), 'qq-download-owner-'));
  const account = new AbortController();
  const channel = createNativeEventChannel(account.signal);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** @template T
   * @param {T|PromiseLike<T>} value
   * @param {AbortSignal} signal
   * @returns {Promise<T>} */
  const awaitAlive = (value, signal) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const pending = Promise.resolve(value);
      pending
        .then(
          (result) => {
            signal.removeEventListener('abort', abort);
            resolve(result);
          },
          (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        )
        .catch(reject);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  /** @template T
   * @param {Promise<T>} promise
   * @returns {Promise<void>} */
  const bounded = async (promise) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Owner cancellation remained pending')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** @param {string} name
   * @returns {{peer:Extract<import('../../src/contracts/messages.ts').Peer,{type:'private'}>,messageId:string,elementId:string,destination:string}} */
  const payload = (name) => ({
    peer: { type: 'private', userId: '456' },
    messageId: '9',
    elementId: '2',
    destination: join(directory, name),
  });
  /** @type {(value:import('../../src/native/message-contracts.ts').NativePeer)=>void} */
  let releasePeer = () => assert.fail('Peer resolver missing');
  let acquisitions = 0,
    writes = 0,
    resolutions = 0;
  const peerOwner = createAttachmentDownloads({
    signal: account.signal,
    resolvePeer(peer) {
      resolutions++;
      assert.deepEqual(peer, { type: 'private', userId: '456' });
      return new Promise((resolve) => {
        releasePeer = resolve;
      });
    },
    awaitAlive,
    getMessageService() {
      acquisitions++;
      return {
        downloadRichMedia() {
          writes++;
        },
      };
    },
    eventCall: channel.call,
  });
  /** @type {(value:unknown)=>void} */
  let releaseNative = () => assert.fail('Native resolver missing');
  /** @type {()=>void} */
  let entered = () => assert.fail('Begin resolver missing');
  /** @type {Promise<void>} */
  const began = new Promise((resolve) => {
    entered = resolve;
  });
  const nativeOwner = createAttachmentDownloads({
    signal: account.signal,
    resolvePeer: async () => ({ chatType: 1, peerUid: 'u_456' }),
    awaitAlive,
    getMessageService: () => ({
      downloadRichMedia() {
        writes++;
        entered();
        return new Promise((resolve) => {
          releaseNative = resolve;
        });
      },
    }),
    eventCall: channel.call,
  });
  const sibling = createAttachmentDownloads({
    signal: account.signal,
    resolvePeer: async () => ({ chatType: 1, peerUid: 'u_456' }),
    awaitAlive,
    getMessageService() {
      const service = {
        async downloadRichMedia(
          /** @type {Parameters<NonNullable<import('../../src/runtime/media-contracts.ts').AttachmentDownloadPort['downloadRichMedia']>>[0]} */ request,
        ) {
          assert.equal(this, service);
          await writeFile(request.filePath, 'sibling bytes');
          channel.dispatch('Msg/onRichMediaDownloadComplete', [
            {
              msgId: '9',
              msgElementId: '2',
              chatType: 1,
              fileErrCode: '0',
              fileSrvErrCode: '0',
              filePath: request.filePath,
            },
          ]);
        },
      };
      return service;
    },
    eventCall: channel.call,
  });
  try {
    const otherWait = channel.call(
      'fixture/other',
      (value) => value,
      () => ({ result: 0 }),
      1000,
    );
    const requestAbort = new AbortController();
    const requestPending = peerOwner.download(payload('request-cancelled'), requestAbort.signal);
    const requestRejected = assert.rejects(requestPending, /cancel/i);
    requestAbort.abort(new Error('fixture request cancelled'));
    await bounded(requestRejected);
    releasePeer({ chatType: 1, peerUid: 'u_456' });
    await tick();
    assert.equal(acquisitions, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(directory), []);
    const request = payload('peer-closed'),
      pending = peerOwner.download(request),
      rejected = assert.rejects(pending, /closed|abort/i);
    request.peer.userId = '999';
    request.destination = join(directory, 'mutated');
    peerOwner.close();
    await bounded(rejected);
    releasePeer({ chatType: 1, peerUid: 'u_456' });
    await tick();
    assert.equal(resolutions, 2);
    assert.equal(acquisitions, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(account.signal.aborted, false);
    channel.dispatch('fixture/other', ['still alive']);
    assert.equal(await otherWait, 'still alive');
    const nativePending = nativeOwner.download(payload('native-closed')),
      nativeRejected = assert.rejects(nativePending, /closed|abort/i);
    await began;
    nativeOwner.close();
    await bounded(nativeRejected);
    releaseNative({ result: 0 });
    await tick();
    assert.equal(writes, 1);
    assert.equal(account.signal.aborted, false);
    assert.deepEqual(await sibling.download(payload('sibling')), {
      file: join(directory, 'sibling'),
    });
    assert.equal(await readFile(join(directory, 'sibling'), 'utf8'), 'sibling bytes');
    assert.deepEqual(await readdir(directory), ['sibling']);
    return {
      attachmentDownloadRequestCancellationContract: true,
      attachmentDownloadOwnerCloseContract: true,
      attachmentDownloadOwnerSiblingContract: true,
      attachmentDownloadLateUidNoWriteContract: true,
    };
  } finally {
    peerOwner.close();
    nativeOwner.close();
    sibling.close();
    channel.close();
    await rm(directory, { recursive: true, force: true });
  }
}
