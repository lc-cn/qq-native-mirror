import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
// Hand-authored fixed-field fixture, not a native/server response.
const recordHex =
  '0a1808c8031208755f617574686f723a09320766697874757265120230641a0d0a0b12090a070a0568656c6c6f';
const vi = (value) => {
  const a = [];
  do {
    const n = value % 128;
    value = Math.floor(value / 128);
    a.push(n | (value ? 128 : 0));
  } while (value);
  return Buffer.from(a);
};
const bytes = (n, data) => Buffer.concat([vi(n * 8 + 2), vi(data.length), data]);
const scalar = (n, value) => Buffer.concat([vi(n * 8), vi(value)]);
const string = (n, value) => bytes(n, Buffer.from(value));
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
export async function checkForwardResourceTypedElements({ createNativeServices }) {
  // Independent hand-authored field fixtures, not native/account observations.
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
  const calls = [],
    effects = [];
  let reply = data.response;
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener() {},
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
export async function checkForwardResourceServices({ createNativeServices }) {
  const data = resourceFixture();
  const calls = [],
    sideEffects = [];
  let msgAccesses = 0;
  const create = (uid = 'u_self', sso = () => ({ rspbuffer: data.response })) =>
    createNativeServices({
      session: {
        getMsgService() {
          msgAccesses++;
          return {
            addKernelMsgListener() {},
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
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
  let rejectLate;
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
export async function verifyForwardResourceConsumer(packagePath) {
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createNativeServices } = await load('native-services.js');
  await checkForwardResourceServices({ createNativeServices });
  await checkForwardResourceTypedElements({ createNativeServices });
  const { QQClient } = await load('index.js');
  const { EventEmitter } = await import('node:events');
  const requests = [];
  const worker = new EventEmitter();
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    send(value, callback) {
      requests.push(value);
      callback(null);
      if (value.method === 'close')
        queueMicrotask(() => {
          worker.emit('message', { id: value.id, result: null });
          setImmediate(() => {
            worker.connected = false;
            worker.exitCode = 0;
            worker.emit('exit', 0, null);
          });
        });
    },
    kill() {
      this.connected = false;
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
      await assert.rejects(client.getForwardResource(invalid));
    assert.equal(requests.length, 0);
    const pending = client.getForwardResource('r');
    const request = requests.at(-1);
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
  const cliCalls = [];
  const action = await prepareCommand('forward-resource', { 'resource-id': 'r' });
  await action({
    getForwardResource(id) {
      cliCalls.push(id);
      return Promise.resolve({ resourceId: id, records: [], raw: Buffer.alloc(0) });
    },
  });
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
    forwardResourceTypedElementsContract: true,
    nativeForwardResourceAttempted: false,
  };
}
