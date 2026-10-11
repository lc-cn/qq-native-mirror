/** @typedef {{'features/messages/inbound-elements.js':typeof import('../../src/features/messages/inbound-elements.ts'),
'features/messages/inbound-mentions.js':typeof import('../../src/features/messages/inbound-mentions.ts'),
'native-services.js':typeof import('../../src/native-services.ts')}} InstalledModules */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compiled installed SDK, synthetic services only. No native client or account.
/** @param {string} packagePath */
export async function verifyMentionConsumer(packagePath) {
  /** @template {keyof InstalledModules} Name @param {Name} name @returns {Promise<InstalledModules[Name]>} */
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { decodeElements } = await load('features/messages/inbound-elements.js');
  const { decodeResolvedElementBatches } = await load('features/messages/inbound-mentions.js');
  const { createNativeServices } = await load('native-services.js');
  const element = (/** @type {Record<string,unknown>} */ text = {}) => ({
    elementType: 1,
    textElement: { content: '@fixture', atType: 2, atUid: '0', atNtUid: 'u_target', ...text },
  });
  const exact = '900719925474099312345';
  for (const [text, expected] of /** @type {[Record<string,unknown>,string][]} */ ([
    [{ atType: 1 }, 'all'],
    [{ atUid: exact }, exact],
    [{ atType: 4, atUid: '00123' }, '00123'],
    [{ atUid: '-1' }, '4294967295'],
    [{ atUid: '-2147483648' }, '2147483648'],
  ]))
    assert.deepEqual(decodeElements([element(text)]), [
      { type: 'at', userId: expected, text: '@fixture' },
    ]);
  for (const text of [
    { atType: 99 },
    { atUid: '-2147483649' },
    { atUid: 123 },
    { atNtUid: undefined },
  ]) {
    const raw = element(text),
      decoded = decodeElements([raw]);
    assert.equal(decoded[0].type, 'unknown');
    assert.ok(decoded[0].type === 'unknown');
    assert.equal(decoded[0].data, raw);
  }
  const controller = new AbortController();
  /** @type {string[]} */ const diagnostic = [];
  let lookups = 0;
  const resolved = await decodeResolvedElementBatches(
    [[element()], [element({ atType: 4 })]],
    async (ids) => {
      lookups++;
      assert.deepEqual(ids, ['u_target']);
      return new Map([['u_target', exact]]);
    },
    controller.signal,
    (stage) => diagnostic.push(stage),
  );
  assert.deepEqual(resolved, [
    [{ type: 'at', userId: exact, text: '@fixture' }],
    [{ type: 'at', userId: exact, text: '@fixture' }],
  ]);
  assert.equal(lookups, 1);
  assert.deepEqual(diagnostic, []);
  for (const resolver of [
    async () => {
      throw Error('private fixture');
    },
    async () => ({}),
    async () => new Map([['wrong_uid', exact]]),
    async () => new Map([['u_target', '0']]),
    async () => new Map([['u_target', 123]]),
  ]) {
    let attempts = 0;
    /** @type {string[]} */ const stages = [];
    const raw = element();
    const values = await Reflect.apply(decodeResolvedElementBatches, undefined, [
      [[raw]],
      async (/** @type {string[]} */ ids) => {
        attempts++;
        assert.deepEqual(ids, ['u_target']);
        return resolver();
      },
      controller.signal,
      (/** @type {string} */ stage) => stages.push(stage),
    ]);
    assert.equal(values[0][0].type, 'unknown');
    assert.ok(values[0][0].type === 'unknown');
    assert.equal(values[0][0].data, raw);
    assert.equal(attempts, 1);
    assert.equal(stages.length, 1);
    assert.ok(!stages.join().includes('private fixture'));
  }
  // Cancellation must settle even when the resolver never completes.
  const stopped = new AbortController();
  /** @type {()=>void} */ let started = () => assert.fail('start not installed');
  const began = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      started = resolve;
    })
  );
  const canceled = decodeResolvedElementBatches(
    [[element()]],
    async () => {
      started();
      return new Promise(() => {});
    },
    stopped.signal,
    () => {
      throw Error('Abort must not emit diagnostic');
    },
  );
  await began;
  stopped.abort();
  await assert.rejects(canceled, /abort/i);

  const raw = (/** @type {string} */ id, /** @type {unknown[]} */ elements = [element()]) => ({
    msgId: id,
    msgSeq: '9',
    msgTime: '100',
    chatType: 2,
    peerUid: '123',
    peerUin: '123',
    senderUid: 'u_friend',
    senderUin: '456',
    elements,
  });
  /** @param {(ids:string[])=>unknown} resolve */
  function fixture(resolve) {
    /** @type {{onRecvMsg(value:unknown):void}|undefined} */ let callback;
    /** @type {[string,unknown][]} */ const events = [];
    /** @type {string[][]} */ const requests = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(/** @type {NonNullable<typeof callback>} */ value) {
            callback = value;
          },
          getMsgsByMsgId: () => ({ result: 0, msgList: [raw('1')] }),
          getMsgsIncludeSelf: () => ({ result: 0, msgList: [raw('1'), raw('2')] }),
          getMultiMsg: () => ({
            result: 0,
            msgList: [raw('1'), { ...raw('2'), chatType: 1, peerUid: 'u_other', peerUin: '789' }],
          }),
        }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getUixConvertService: () => ({
          getUin(/** @type {string[]} */ ids) {
            requests.push(ids);
            return resolve(ids);
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: (event, payload) => events.push([event, payload]) },
    });
    return {
      services,
      events,
      requests,
      callback: () => {
        assert.ok(callback);
        return callback;
      },
    };
  }
  const peer = { type: 'group', groupId: '123' };
  for (const method of /** @type {const} */ (['getMessage', 'getHistory', 'getForwardMessages'])) {
    const f = fixture(async () => ({ uinInfo: new Map([['u_target', exact]]) }));
    try {
      const value = await f.services.invokeOperation(method, {
        peer,
        messageId: '1',
        rootMessageId: '10',
        parentMessageId: '20',
        options: { limit: 2 },
      });
      for (const message of Array.isArray(value) ? value : [value]) {
        assertMessage(message);
        assert.deepEqual(message.elements, [{ type: 'at', userId: exact, text: '@fixture' }]);
      }
      assert.deepEqual(f.requests, [['u_target']]);
    } finally {
      f.services.close();
    }
    const failed = fixture(async () => {
      throw Error('private identity lookup failure');
    });
    try {
      const value = await failed.services.invokeOperation(method, {
        peer,
        messageId: '1',
        rootMessageId: '10',
        parentMessageId: '20',
        options: { limit: 2 },
      });
      for (const message of Array.isArray(value) ? value : [value])
        assert.equal(message.elements[0].type, 'unknown');
      assert.equal(failed.requests.length, 1);
      assert.deepEqual(
        failed.events.filter(([event]) => event === 'diagnostic'),
        [['diagnostic', { stage: 'native-mention-lookup-failed' }]],
      );
    } finally {
      failed.services.close();
    }
  }
  const flush = async () => {
    for (let n = 0; n < 4; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** @type {(value:unknown)=>void} */ let finish = () => assert.fail('finish not installed');
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    f.callback().onRecvMsg([raw('1'), raw('2')]);
    f.callback().onRecvMsg([
      raw('3', [{ elementType: 1, textElement: { atType: 0, content: 'plain' } }]),
    ]);
    await flush();
    assert.equal(f.events.filter(([event]) => event === 'message').length, 0);
    finish({ uinInfo: new Map([['u_target', exact]]) });
    await flush();
    assert.deepEqual(
      f.events
        .filter(([event]) => event === 'message')
        .map(([, message]) => {
          assertMessage(message);
          return message.messageId;
        }),
      ['1', '2', '3'],
    );
    f.callback().onRecvMsg([raw('1'), raw('2')]);
    await flush();
    assert.equal(f.requests.length, 1);
  } finally {
    f.services.close();
  }
  // Native callback records may be reused before queued identity work starts.
  /** @type {(value:unknown)=>void} */ let releaseFirst = () => assert.fail('resolver missing');
  let lookupCount = 0;
  const captured = fixture(() =>
    ++lookupCount === 1
      ? new Promise((resolve) => {
          releaseFirst = resolve;
        })
      : Promise.resolve({ uinInfo: new Map([['u_target', exact]]) }),
  );
  try {
    const first = raw('1'),
      second = raw('2');
    captured.callback().onRecvMsg([first]);
    captured.callback().onRecvMsg([second]);
    second.msgId = '999';
    second.peerUid = '999';
    textElement(second.elements[0]).atNtUid = 'u_mutated';
    textElement(second.elements[0]).content = 'mutated callback object';
    await flush();
    assert.deepEqual(captured.requests, [['u_target']]);
    releaseFirst({ uinInfo: new Map([['u_target', exact]]) });
    await flush();
    const messages = captured.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => {
        assertMessage(message);
        return message;
      });
    assert.deepEqual(
      messages.map((message) => message.messageId),
      ['1', '2'],
    );
    for (const message of messages) {
      assert.deepEqual(message.peer, { type: 'group', groupId: '123' });
      assert.deepEqual(message.elements, [{ type: 'at', userId: exact, text: '@fixture' }]);
    }
    assert.equal(messages[1].raw, second, 'Raw remains the original native evidence object');
    assert.deepEqual(captured.requests, [['u_target'], ['u_target']]);
    captured.callback().onRecvMsg([raw('2')]);
    await flush();
    assert.equal(captured.requests.length, 2, 'Replay uses captured original identity');
    assert.equal(captured.events.filter(([event]) => event === 'message').length, 2);
  } finally {
    captured.services.close();
  }
  const closed = fixture(() => new Promise(() => {}));
  closed.callback().onRecvMsg([raw('4')]);
  await flush();
  closed.services.close();
  await flush();
  assert.equal(closed.events.filter(([event]) => event === 'message').length, 0);
  return { inboundMentionContract: true, nativeMentionLookupAttempted: false };
}

/** @param {unknown} value @returns {asserts value is import('../../src/contracts/messages.ts').Message} */
function assertMessage(value) {
  assert.ok(
    value &&
      typeof value === 'object' &&
      'messageId' in value &&
      typeof value.messageId === 'string' &&
      'sequence' in value &&
      typeof value.sequence === 'string' &&
      'time' in value &&
      typeof value.time === 'number' &&
      'peer' in value &&
      value.peer &&
      typeof value.peer === 'object' &&
      'sender' in value &&
      value.sender &&
      typeof value.sender === 'object' &&
      'elements' in value &&
      Array.isArray(value.elements) &&
      'raw' in value,
  );
}

/** @param {unknown} value @returns {Record<string,unknown>} */
function textElement(value) {
  assertRecord(value);
  assertRecord(value.textElement);
  return value.textElement;
}
/** @param {unknown} value @returns {asserts value is Record<string,unknown>} */
function assertRecord(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
}
