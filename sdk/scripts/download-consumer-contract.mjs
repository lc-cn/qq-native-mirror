import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Synthetic services and real temporary filesystem only; no native addon/account. */
export async function checkDownloadContract({ QQClient, createNativeServices, prepareCommand }) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-download-contract-'));
  const make = (download, lookup) => {
    let listener;
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(value) {
            listener = value;
          },
          downloadRichMedia(request) {
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
    let releaseUid,
      uidCalls = 0,
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

    let entered,
      rejectLate,
      stalledCalls = 0;
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
    const requests = [],
      worker = new EventEmitter();
    Object.assign(worker, {
      connected: true,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send(request, done) {
        requests.push(request);
        done(null);
        if (request.method === 'close')
          queueMicrotask(() => worker.emit('message', { id: request.id, result: null }));
      },
      kill() {
        this.connected = false;
        queueMicrotask(() => this.emit('exit', 0, null));
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
      const peer = { type: 'group', groupId: '123' };
      const promise = client.downloadAttachment(peer, '0009', '02', destination);
      peer.groupId = '999';
      const request = requests.at(-1);
      assert.equal(request.method, 'downloadAttachment');
      assert.deepEqual(request.peer, { type: 'group', groupId: '123' });
      assert.equal(request.messageId, '0009');
      worker.emit('message', { id: request.id, result: { file: destination } });
      assert.deepEqual(await promise, { file: destination });
    } finally {
      await client.close();
    }
    const calls = [];
    await (
      await prepareCommand('download', {
        kind: 'group',
        target: '123',
        'message-id': '0009',
        'element-id': '02',
        destination,
      })
    )({
      downloadAttachment(...args) {
        calls.push(args);
        return { file: destination };
      },
    });
    assert.deepEqual(calls, [[{ type: 'group', groupId: '123' }, '0009', '02', destination]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function verifyDownloadConsumer(packageRoot) {
  const load = (file) => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js'),
    { createNativeServices } = await load('native-services.js'),
    { prepareCommand } = await load('cli.js');
  await checkDownloadContract({ QQClient, createNativeServices, prepareCommand });
  return { attachmentDownloadContract: true, nativeAttachmentDownloadAttempted: false };
}
