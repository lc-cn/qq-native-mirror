import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGroupEssenceRequest } from '../src/features/groups/group-essence-input.ts';
import {
  setGroupEssenceMessage,
  type GroupEssenceContext,
} from '../src/features/groups/group-essence.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
import { createNativeServices } from '../src/native-services.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';

const messageId = '9876543210123456789';
const message = () => ({
  msgId: messageId,
  chatType: 2,
  peerUid: '123',
  msgSeq: '9',
  msgRandom: '4294967295',
  elements: [],
});
const receipt = () => ({ errCode: 0, errMsg: '', result: { errorCode: 0 } });
function fixture(raw: unknown = message(), response: unknown = receipt()) {
  const lifetime = new NativeServiceLifetime();
  const queries: unknown[] = [],
    mutations: unknown[] = [];
  const context: GroupEssenceContext = {
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    async query(...args) {
      queries.push(args);
      return raw;
    },
    invoke(...args) {
      mutations.push(args);
      return response;
    },
  };
  return { context, lifetime, queries, mutations };
}

for (const enabled of [true, false])
  test(`essence ${enabled} resolves the exact message before one native mutation`, async () => {
    const f = fixture();
    await setGroupEssenceMessage(f.context, '123', messageId, enabled);
    assert.deepEqual(f.queries, [['123', messageId]]);
    assert.deepEqual(f.mutations, [
      [
        enabled ? 'addGroupEssence' : 'removeGroupEssence',
        { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 },
      ],
    ]);
    f.lifetime.close();
  });

for (const args of [
  ['', messageId, true],
  ['0', messageId, true],
  ['18446744073709551616', messageId, true],
  [123, messageId, true],
  ['123', 9, true],
  ['123', '', true],
  ['123', '9x', true],
  ['123', messageId, 'true'],
  ['123', messageId, undefined],
])
  test(`invalid essence input rejects before lookup ${JSON.stringify(args)}`, async () => {
    const f = fixture();
    await assert.rejects(
      setGroupEssenceMessage(f.context, ...(args as [unknown, unknown, unknown])),
    );
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.mutations, []);
    f.lifetime.close();
  });

test('input capture keeps decimal identifiers as strings and accepts the native uint64 ceiling', () => {
  assert.deepEqual(captureGroupEssenceRequest('18446744073709551615', messageId, false), {
    groupId: '18446744073709551615',
    messageId,
    enabled: false,
  });
});

for (const raw of [
  undefined,
  null,
  [],
  {},
  { ...message(), msgId: '9' },
  { ...message(), chatType: 1 },
  { ...message(), peerUid: '456' },
])
  test(`absent or mismatched essence lookup never mutates ${JSON.stringify(raw)}`, async () => {
    const f = fixture(raw === undefined ? null : raw);
    await assert.rejects(
      setGroupEssenceMessage(f.context, '123', messageId, true),
      /requested group message/,
    );
    assert.equal(f.queries.length, 1);
    assert.deepEqual(f.mutations, []);
    f.lifetime.close();
  });

for (const key of ['msgSeq', 'msgRandom'])
  for (const value of ['4294967296', '-1', '1.5', '9x', '', 9, undefined])
    test(`malformed ${key}=${String(value)} never dispatches mutation`, async () => {
      const f = fixture({ ...message(), [key]: value });
      await assert.rejects(
        setGroupEssenceMessage(f.context, '123', messageId, true),
        /Invalid native essence/,
      );
      assert.deepEqual(f.mutations, []);
      f.lifetime.close();
    });

test('message accessors cannot supply wire identifiers or perform side effects', async () => {
  let read = 0;
  const raw = message();
  Object.defineProperty(raw, 'msgSeq', {
    get() {
      read++;
      return '9';
    },
  });
  const f = fixture(raw);
  await assert.rejects(setGroupEssenceMessage(f.context, '123', messageId, true));
  assert.equal(read, 0);
  assert.deepEqual(f.mutations, []);
  f.lifetime.close();
});

for (const [response, code] of [
  [{ errCode: -7, errMsg: 'private wording' }, -7],
  [{ errCode: 71, result: { errorCode: 0 } }, 71],
  [{ errCode: 0, result: { errorCode: 9, wording: 'private wording' } }, 9],
  [{ errCode: 0, result: { errorCode: 4294967295 } }, 4294967295],
  [{ errCode: 0, result: { errorCode: 11002 } }, 11002],
  [{ errCode: 0, result: { errorCode: 11007 } }, 11007],
  [{ result: 0 }, 'invalid-result'],
  [undefined, 'invalid-result'],
  [{ errCode: '0', result: { errorCode: 0 } }, 'invalid-result'],
  [{ errCode: 0 }, 'invalid-result'],
  [{ errCode: 0, result: { errorCode: '0' } }, 'invalid-result'],
  [{ errCode: 0, result: { errorCode: -1 } }, 'invalid-result'],
  [{ errCode: 0, result: { errorCode: 4294967296 } }, 'invalid-result'],
] as const)
  test(`both essence status layers are validated without retry ${JSON.stringify(response)}`, async () => {
    const f = fixture(message(), response === undefined ? null : response);
    await assert.rejects(
      setGroupEssenceMessage(f.context, '123', messageId, true),
      (error: Error & { code?: unknown }) =>
        error.code === code && !error.message.includes('private wording'),
    );
    assert.equal(f.mutations.length, 1);
    f.lifetime.close();
  });

test('receipt accessors are not invoked or treated as successful statuses', async () => {
  let read = 0;
  const response = Object.defineProperty({}, 'errCode', {
    get() {
      read++;
      return 0;
    },
  });
  const f = fixture(message(), response);
  await assert.rejects(setGroupEssenceMessage(f.context, '123', messageId, false));
  assert.equal(read, 0);
  assert.equal(f.mutations.length, 1);
  f.lifetime.close();
});

test('close during lookup rejects immediately and late lookup cannot dispatch', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.context.query = () =>
    new Promise((done) => {
      resolve = done;
    });
  const operation = setGroupEssenceMessage(f.context, '123', messageId, true);
  const rejected = assert.rejects(operation);
  f.lifetime.close();
  await rejected;
  resolve(message());
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(f.mutations, []);
});

test('close during native mutation consumes late rejection without replay', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  let issued!: () => void;
  const started = new Promise<void>((done) => {
    issued = done;
  });
  f.context.invoke = (...args) => {
    f.mutations.push(args);
    issued();
    return new Promise((_, fail) => {
      reject = fail;
    });
  };
  const operation = setGroupEssenceMessage(f.context, '123', messageId, false);
  const rejected = assert.rejects(operation);
  await started;
  f.lifetime.close();
  await rejected;
  reject(new Error('late native failure'));
  await new Promise((done) => setImmediate(done));
  assert.equal(f.mutations.length, 1);
});

test('actual Session dispatch uses message lookup and the guarded Group service, without UID conversion', async () => {
  const calls: unknown[] = [];
  const services = createNativeServices({
    session: {
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getProfileService: () => ({}),
      getMsgService: () => ({
        addKernelMsgListener() {},
        getMsgsByMsgId(peer: unknown, ids: unknown) {
          calls.push(['lookup', peer, ids]);
          return { result: 0, msgList: [message()] };
        },
      }),
      getGroupService: () => ({
        addKernelGroupListener() {},
        addGroupEssence(request: unknown) {
          calls.push(['add', request]);
          return receipt();
        },
        removeGroupEssence(request: unknown) {
          calls.push(['remove', request]);
          return receipt();
        },
      }),
    },
    version: 'fixture',
    events: {
      emit() {
        throw new Error('No business event expected');
      },
    },
  });
  try {
    for (const enabled of [true, false])
      await services.invokeOperation('setGroupEssenceMessage', {
        groupId: '123',
        messageId,
        enabled,
      });
    assert.deepEqual(calls, [
      ['lookup', { chatType: 2, peerUid: '123' }, [messageId]],
      ['add', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
      ['lookup', { chatType: 2, peerUid: '123' }, [messageId]],
      ['remove', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
    ]);
  } finally {
    services.close();
  }
});

test('CLI captures the complete essence intent before login and rejects malformed flags', async () => {
  const flags = { 'group-id': '123', 'message-id': messageId, enabled: 'false' };
  validateCommandFlags('group-essence', flags);
  const action = await prepareCommand('group-essence', flags);
  flags.enabled = 'true';
  flags['message-id'] = '9';
  const calls: unknown[] = [];
  await action({
    setGroupEssenceMessage: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as any);
  assert.deepEqual(calls, [['123', messageId, false]]);
  await assert.rejects(
    prepareCommand('group-essence', { 'group-id': '123', 'message-id': messageId, enabled: '1' }),
    /true or false/,
  );
  await assert.rejects(
    prepareCommand('group-essence', { 'group-id': '123', enabled: 'true' }),
    /message-id/,
  );
  assert.throws(
    () => validateCommandFlags('group-essence', { ...flags, extra: 'value' }),
    /Unknown option/,
  );
});
