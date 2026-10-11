/** @typedef {{'features/forward/forward-resource-owner.js':typeof import('../../src/features/forward/forward-resource-owner.ts'),
'cli.js':typeof import('../../src/cli.ts'),
'index.js':typeof import('../../src/index.ts'),
'native-services.js':typeof import('../../src/native-services.ts')}} InstalledModules */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChildProcess, spawnSync } from 'node:child_process';
// Hand-authored fixed-field fixture, not a native/server response.
const recordHex =
  '0a1808c8031208755f617574686f723a09320766697874757265120230641a0d0a0b12090a070a0568656c6c6f';
/** @param {number} value */
const vi = (value) => {
  const a = [];
  do {
    const n = value % 128;
    value = Math.floor(value / 128);
    a.push(n | (value ? 128 : 0));
  } while (value);
  return Buffer.from(a);
};
/** @param {number} n @param {Buffer} data */
const bytes = (n, data) => Buffer.concat([vi(n * 8 + 2), vi(data.length), data]);
/** @param {number} n @param {number} value */
const scalar = (n, value) => Buffer.concat([vi(n * 8), vi(value)]);
/** @param {number} n @param {string} value */
const string = (n, value) => bytes(n, Buffer.from(value));
/** @param {Buffer[]} [elements] */
export function resourceFixture(elements) {
  const record =
    elements === undefined
      ? Buffer.from(recordHex, 'hex')
      : Buffer.concat([
          bytes(1, Buffer.from('08c8031208755f617574686f723a09320766697874757265', 'hex')),
          bytes(2, scalar(6, 100)),
          bytes(3, bytes(1, Buffer.concat(elements.map((value) => bytes(2, value))))),
        ]);
  const raw = bytes(
    2,
    Buffer.concat([bytes(1, Buffer.from('MultiMsg')), bytes(2, bytes(1, record))]),
  );
  return {
    record,
    raw,
    response: bytes(1, Buffer.concat([bytes(3, Buffer.from('r')), bytes(4, gzipSync(raw))])),
  };
}
/** @param {{createNativeServices:InstalledModules['native-services.js']['createNativeServices']}} dependencies */
export async function checkForwardResourceTypedElements({ createNativeServices }) {
  // Independent hand-authored field fixtures, not native/account observations.
  /** @param {number} kind @param {number} [uin] @param {string} [uid] */
  const at = (kind, uin, uid) =>
    bytes(
      1,
      Buffer.concat([
        string(1, '@fixture'),
        bytes(
          12,
          Buffer.concat([
            scalar(3, kind),
            ...(uin === undefined ? [] : [scalar(4, uin)]),
            ...(uid === undefined ? [] : [string(9, uid)]),
          ]),
        ),
      ]),
    );
  /** @param {number} service @param {Buffer} inner */
  const face = (service, inner) =>
    bytes(53, Buffer.concat([scalar(1, service), bytes(2, inner), scalar(3, 1)]));
  const all = at(1, 0, ''),
    uid = at(2, 0, 'u_mentioned'),
    uin = at(2, 4294967295),
    both = at(2, 123, 'u_mentioned');
  const small = face(33, Buffer.concat([scalar(1, 0), string(2, 'preview')]));
  const big = face(37, Buffer.concat([scalar(3, 333), string(1, 'pack'), string(7, 'preview')]));
  const legacy = bytes(1, Buffer.concat([string(1, '@legacy'), bytes(3, Buffer.alloc(11))]));
  const extendedUnknown = face(33, Buffer.concat([scalar(1, 14), scalar(99, 1)]));
  const data = resourceFixture([
    bytes(1, string(1, 'hello')),
    all,
    uid,
    uin,
    both,
    bytes(2, scalar(1, 14)),
    small,
    big,
    legacy,
    extendedUnknown,
  ]);
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {string[]} */
  const effects = [];
  let reply = data.response;
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener() {},
        /** @param {unknown[]} args */
        sendSsoCmdReqByContend(...args) {
          calls.push(args);
          return { rspbuffer: reply };
        },
        sendMsg() {
          effects.push('send');
          throw Error('Unexpected send');
        },
      }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getUixConvertService: () => ({
        getUid() {
          effects.push('uid');
          throw Error('Unexpected UID lookup');
        },
        getUin() {
          effects.push('uin');
          throw Error('Unexpected UIN lookup');
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
    identity: { userId: '789', uid: 'u_self' },
  });
  try {
    const value = await services.invokeOperation('getForwardResource', { resourceId: 'r' });
    assertResource(value);
    assert.deepEqual(value.records[0].elements, [
      { type: 'text', text: 'hello' },
      { type: 'at', text: '@fixture', userId: 'all', raw: all },
      { type: 'at', text: '@fixture', uid: 'u_mentioned', raw: uid },
      { type: 'at', text: '@fixture', userId: '4294967295', raw: uin },
      { type: 'at', text: '@fixture', userId: '123', uid: 'u_mentioned', raw: both },
      { type: 'face', id: 14 },
      { type: 'face', id: 0, serviceType: 33, businessType: 1, raw: small },
      { type: 'face', id: 333, serviceType: 37, businessType: 1, raw: big },
      { type: 'unknown', fieldNumbers: [1], raw: legacy },
      { type: 'unknown', fieldNumbers: [53], raw: extendedUnknown },
    ]);
    assert.deepEqual(value.records[0].sender, {
      userId: '456',
      uid: 'u_author',
      nickname: 'fixture',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(effects, []);
    assert.deepEqual(value.raw, data.raw);
    assert.deepEqual(value.records[0].raw, data.record);
    data.response.fill(0);
    value.raw.fill(0);
    value.records[0].raw.fill(0);
    assert.deepEqual(value.records[0].elements[1].raw, all);
    assert.ok('raw' in value.records[0].elements[1]);
    value.records[0].elements[1].raw.fill(0);
    assert.deepEqual(value.records[0].elements[2].raw, uid);
    // One malformed projected element rejects the entire batch; no replay or lookup.
    const duplicate = bytes(
      1,
      Buffer.concat([string(1, '@bad'), bytes(12, Buffer.concat([scalar(3, 1), scalar(3, 1)]))]),
    );
    reply = resourceFixture([all, duplicate]).response;
    await assert.rejects(services.invokeOperation('getForwardResource', { resourceId: 'r' }), {
      name: 'ForwardResourceError',
      stage: 'protobuf',
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(effects, []);
  } finally {
    services.close();
  }
}
/** @param {{createNativeServices:InstalledModules['native-services.js']['createNativeServices']}} dependencies */
export async function checkForwardResourceServices({ createNativeServices }) {
  const data = resourceFixture();
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {string[]} */
  const sideEffects = [];
  let msgAccesses = 0;
  /** @param {string} uid @param {(...args:unknown[])=>unknown} sso */
  const create = (uid = 'u_self', sso = () => ({ rspbuffer: data.response })) =>
    createNativeServices({
      session: {
        getMsgService() {
          msgAccesses++;
          return {
            addKernelMsgListener() {},
            /** @param {unknown[]} args */
            sendSsoCmdReqByContend(...args) {
              calls.push(args);
              return sso(...args);
            },
            sendMsg() {
              sideEffects.push('send');
              throw Error('Unexpected send');
            },
            getMultiMsg() {
              sideEffects.push('native-id-query');
              throw Error('Unexpected native ID query');
            },
          };
        },
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getUixConvertService: () => ({
          getUid() {
            sideEffects.push('uid');
            throw Error('Unexpected UID lookup');
          },
          getUin() {
            sideEffects.push('uin');
            throw Error('Unexpected UIN lookup');
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
      identity: { userId: '789', uid: uid },
    });
  const services = create();
  try {
    const before = msgAccesses;
    for (const invalid of ['', null, {}, 42, '\ud800', 'x'.repeat(4097)])
      await assert.rejects(services.invokeOperation('getForwardResource', { resourceId: invalid }));
    assert.equal(msgAccesses, before);
    assert.equal(calls.length, 0);
    const value = await services.invokeOperation('getForwardResource', { resourceId: 'r' });
    assertResource(value);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
    assert.ok(Buffer.isBuffer(calls[0][1]));
    assert.equal(
      calls[0][1].toString('hex'),
      '0a0f0a081206755f73656c6612017218017a080802100018002000',
    );
    assert.equal(value.resourceId, 'r');
    assert.deepEqual(value.raw, data.raw);
    assert.deepEqual(value.records, [
      {
        sender: { userId: '456', uid: 'u_author', nickname: 'fixture' },
        time: 100,
        elements: [{ type: 'text', text: 'hello' }],
        raw: data.record,
      },
    ]);
    for (const key of ['messageId', 'peer', 'sequence'])
      assert.equal(Object.hasOwn(value.records[0], key), false);
    assert.deepEqual(sideEffects, []);
  } finally {
    services.close();
  }
  const missingUid = create('');
  try {
    const before = msgAccesses;
    await assert.rejects(missingUid.invokeOperation('getForwardResource', { resourceId: 'r' }));
    assert.equal(msgAccesses, before);
    assert.equal(calls.length, 1);
  } finally {
    missingUid.close();
  }
  /** @type {(reason:unknown)=>void} */
  let rejectLate = () => assert.fail('Read not started');
  const stalled = create(
    'u_self',
    () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
  );
  const request = stalled.invokeOperation('getForwardResource', { resourceId: 'r' });
  const checked = assert.rejects(request, /closed|canceled/);
  stalled.close();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    await Promise.race([
      checked,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Close did not terminate read')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  rejectLate(Error('late private native response'));
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 2);
  assert.deepEqual(sideEffects, []);
  await assert.rejects(
    stalled.invokeOperation('getForwardResource', { resourceId: 'r' }),
    /closed/,
  );
  assert.equal(calls.length, 2);
}
/** @param {string} packagePath */
export async function verifyForwardResourceConsumer(packagePath) {
  /** @template {keyof InstalledModules} Name @param {Name} name @returns {Promise<InstalledModules[Name]>} */
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createNativeServices } = await load('native-services.js');
  const { createForwardResourceOwner } = await load('features/forward/forward-resource-owner.js');
  await verifyOwnerRetirement(createForwardResourceOwner);
  await checkForwardResourceServices({ createNativeServices });
  await checkForwardResourceTypedElements({ createNativeServices });
  const { QQClient } = await load('index.js');
  /** @type {Record<string,unknown>[]} */
  const requests = [];
  const worker = new ChildProcess();
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    /** @param {unknown} value @param {(error:Error|null)=>void} callback */
    send(value, callback) {
      assertRecord(value);
      requests.push(value);
      callback(null);
      if (value.method === 'close')
        queueMicrotask(() => {
          worker.emit('message', { id: value.id, result: null });
          setImmediate(() => {
            Object.defineProperties(worker, {
              connected: { value: false, configurable: true },
              exitCode: { value: 0, configurable: true },
            });
            worker.emit('exit', 0, null);
          });
        });
    },
    /** @this {ChildProcess} */
    kill() {
      Object.defineProperty(this, 'connected', { value: false, configurable: true });
      queueMicrotask(() => this.emit('exit', 0, null));
      return true;
    },
  });
  const client = new QQClient(worker, 500);
  try {
    await assert.rejects(client.getForwardResource('r'), /not online/);
    assert.equal(requests.length, 0);
    worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
    for (const invalid of ['', 42, {}, '\ud800', 'x'.repeat(4097)])
      await assert.rejects(Reflect.apply(client.getForwardResource, client, [invalid]));
    assert.equal(requests.length, 0);
    const pending = client.getForwardResource('r');
    const request = requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, 'getForwardResource');
    assert.equal(request.resourceId, 'r');
    worker.emit('message', {
      id: request.id,
      result: { resourceId: 'r', records: [], raw: Buffer.alloc(0) },
    });
    assert.equal((await pending).resourceId, 'r');
  } finally {
    await client.close();
  }
  const { prepareCommand } = await load('cli.js');
  /** @type {string[]} */
  const cliCalls = [];
  const action = await prepareCommand('forward-resource', { 'resource-id': 'r' });
  const cliWorker = controlledCloseWorker();
  const cliClient = new QQClient(cliWorker, 500);
  cliClient.getForwardResource = async (id) => {
    cliCalls.push(id);
    return { resourceId: id, records: [], raw: Buffer.alloc(0) };
  };
  try {
    await action(cliClient);
  } finally {
    await cliClient.close();
  }
  assert.deepEqual(cliCalls, ['r']);
  await assert.rejects(prepareCommand('forward-resource', {}));
  await assert.rejects(prepareCommand('forward-resource', { 'resource-id': 'x'.repeat(4097) }));
  const cli = join(packagePath, 'dist/cli.js'),
    missing = join(packagePath, 'nonexistent-resource-fixture-config.json');
  const invalid = spawnSync(process.execPath, [cli, 'forward-resource', '--config', missing], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /resource-id/);
  assert.doesNotMatch(invalid.stderr, /Unknown command|ENOENT/);
  const recognized = spawnSync(
    process.execPath,
    [cli, 'forward-resource', '--config', missing, '--resource-id', 'r'],
    { encoding: 'utf8' },
  );
  assert.equal(recognized.status, 1);
  assert.match(recognized.stderr, /ENOENT/);
  assert.doesNotMatch(recognized.stderr, /Unknown command|Unknown option/);
  const batch = spawnSync(
    process.execPath,
    [
      cli,
      'messages',
      '--config',
      missing,
      '--kind',
      'group',
      '--target',
      '123',
      '--message-ids',
      'invalid',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(batch.status, 1);
  assert.match(batch.stderr, /message.?ids|numeric/i);
  assert.doesNotMatch(batch.stderr, /Unknown command|ENOENT/);
  const merged = spawnSync(
    process.execPath,
    [cli, 'send-forward', '--config', missing, '--kind', 'group', '--target', '123'],
    { encoding: 'utf8' },
  );
  assert.equal(merged.status, 1);
  assert.match(merged.stderr, /nodes-file/);
  assert.doesNotMatch(merged.stderr, /Unknown command|ENOENT/);
  return {
    forwardResourceContract: true,
    forwardResourceOwnerRetirementContract: true,
    forwardResourceTypedElementsContract: true,
    nativeForwardResourceAttempted: false,
  };
}

/** @param {unknown} value @returns {asserts value is Record<string,unknown>} */
function assertRecord(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
}
/** @param {unknown} value @returns {asserts value is import('../../src/types.ts').ForwardResource} */
function assertResource(value) {
  assertRecord(value);
  assert.equal(typeof value.resourceId, 'string');
  assert.ok(Array.isArray(value.records));
  assert.ok(Buffer.isBuffer(value.raw));
}

/** Genuine ChildProcess with synthetic close ACK/exit only; never spawns a process. */
function controlledCloseWorker() {
  const worker = new ChildProcess();
  Object.defineProperty(worker, 'connected', { value: true, configurable: true });
  Object.defineProperty(worker, 'send', {
    value(/** @type {unknown} */ value, /** @type {(error:Error|null)=>void} */ callback) {
      assert.ok(value !== null && typeof value === 'object' && 'id' in value && 'method' in value);
      assert.equal(value.method, 'close');
      callback(null);
      queueMicrotask(() => {
        worker.emit('message', { id: value.id, result: null });
        setImmediate(() => {
          Object.defineProperties(worker, {
            connected: { value: false, configurable: true },
            exitCode: { value: 0, configurable: true },
          });
          worker.emit('exit', 0, null);
        });
      });
      return true;
    },
  });
  return worker;
}

/** Installed owner uses synthetic ports only, never a client or account.
 * @param {InstalledModules['features/forward/forward-resource-owner.js']['createForwardResourceOwner']} createOwner */
async function verifyOwnerRetirement(createOwner) {
  const peer = { type: 'group', groupId: '123' };
  const nodes = [{ userId: '456', nickname: 'fixture', time: 1, text: 'text' }];
  const response = resourceFixture().response;
  /** @param {Partial<import('../../src/features/forward/forward-resource-owner.ts').ForwardResourceOwnerContext>} [overrides] */
  function fixture(overrides = {}) {
    const controller = new AbortController();
    /** @type {(()=>void)[]} */
    const cleanup = [];
    /** @type {string[]} */
    const effects = [];
    const owner = createOwner({
      selfUid: 'u_self',
      signal: controller.signal,
      resolvePeer: async () => {
        effects.push('resolve');
        return { chatType: 2, peerUid: '123' };
      },
      getMessageService() {
        effects.push('acquire');
        return {
          sendSsoCmdReqByContend(command) {
            effects.push(command.includes('SsoSend') ? 'upload' : 'read');
            return {
              rspbuffer: command.includes('SsoSend') ? Buffer.from('12031a0172', 'hex') : response,
            };
          },
        };
      },
      sendPrepared: async (_peer, _elements, onDispatch) => {
        effects.push('card');
        onDispatch();
        return { messageId: '42', sequence: '9', time: 100 };
      },
      defer: (step) => cleanup.push(step),
      ...overrides,
    });
    return {
      owner,
      controller,
      cleanup,
      effects,
      close: () => {
        for (const step of cleanup) step();
        controller.abort();
      },
    };
  }
  /** @param {Promise<unknown>} pending */
  async function rejectsPromptly(pending) {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      await Promise.race([
        assert.rejects(pending),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Installed forward owner cancellation stalled')),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const upload = fixture();
  try {
    upload.cleanup[0]();
    await rejectsPromptly(upload.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(upload.effects, []);
    assert.equal((await upload.owner.readResource('r')).resourceId, 'r');
    assert.deepEqual(upload.effects, ['acquire', 'read']);
  } finally {
    upload.close();
  }
  const read = fixture();
  try {
    read.cleanup[1]();
    await rejectsPromptly(read.owner.readResource('r'));
    assert.deepEqual(read.effects, []);
    assert.deepEqual(await read.owner.sendMerged(peer, nodes, {}), {
      messageId: '42',
      sequence: '9',
      time: 100,
      resourceId: 'r',
    });
    assert.deepEqual(read.effects, ['resolve', 'acquire', 'upload', 'card']);
  } finally {
    read.close();
  }
  /** @type {(reason:unknown)=>void} */
  let rejectLate = () => assert.fail('Resolver not called');
  let resolutions = 0;
  const stalled = fixture({
    resolvePeer: () => {
      resolutions++;
      return new Promise((_, reject) => {
        rejectLate = reject;
      });
    },
  });
  const pending = stalled.owner.sendMerged(peer, nodes, {});
  stalled.cleanup[0]();
  try {
    await rejectsPromptly(pending);
    assert.equal(resolutions, 1);
    assert.deepEqual(stalled.effects, []);
    rejectLate(Error('Late synthetic resolver failure'));
    await new Promise((done) => setImmediate(done));
  } finally {
    stalled.close();
  }
  for (const failed of [false, true]) {
    const controller = new AbortController();
    let submissions = 0;
    const settled = fixture({
      signal: controller.signal,
      sendPrepared: (_peer, _elements, onDispatch) => {
        submissions++;
        onDispatch();
        controller.abort(Error('Synthetic retirement during submission'));
        return failed
          ? Promise.reject(Object.assign(Error('Synthetic native failure'), { code: 7 }))
          : Promise.resolve({ messageId: '42', sequence: '9', time: 100 });
      },
    });
    try {
      await assert.rejects(settled.owner.sendMerged(peer, nodes, {}), (error) => {
        assert.ok(error instanceof Error && 'code' in error && 'progress' in error);
        assert.equal(error.code, failed ? 7 : undefined);
        assertRecord(error.progress);
        assert.equal(error.progress.resourceId, 'r');
        assert.equal(error.progress.cardCompletion, 'unknown');
        return true;
      });
      assert.equal(submissions, 1);
      assert.deepEqual(settled.effects, ['resolve', 'acquire', 'upload']);
    } finally {
      settled.close();
    }
  }
  const aborted = fixture();
  try {
    aborted.controller.abort();
    await rejectsPromptly(aborted.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(aborted.effects, []);
  } finally {
    aborted.close();
  }
}
