import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compiled installed SDK, synthetic services only. No native client or account.
export async function verifyMentionConsumer(packagePath) {
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { decodeElements } = await load('features/messages/message-elements.js');
  const { decodeResolvedElementBatches } = await load('features/messages/inbound-mentions.js');
  const { createNativeServices } = await load('native-services.js');
  const element = (text = {}) => ({
    elementType: 1,
    textElement: { content: '@fixture', atType: 2, atUid: '0', atNtUid: 'u_target', ...text },
  });
  const exact = '900719925474099312345';
  for (const [text, expected] of [
    [{ atType: 1 }, 'all'],
    [{ atUid: exact }, exact],
    [{ atType: 4, atUid: '00123' }, '00123'],
    [{ atUid: '-1' }, '4294967295'],
    [{ atUid: '-2147483648' }, '2147483648'],
  ])
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
    assert.equal(decoded[0].data, raw);
  }
  const controller = new AbortController(),
    diagnostic = [];
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
    const stages = [],
      raw = element();
    const values = await decodeResolvedElementBatches(
      [[raw]],
      async (ids) => {
        attempts++;
        assert.deepEqual(ids, ['u_target']);
        return resolver();
      },
      controller.signal,
      (stage) => stages.push(stage),
    );
    assert.equal(values[0][0].type, 'unknown');
    assert.equal(values[0][0].data, raw);
    assert.equal(attempts, 1);
    assert.equal(stages.length, 1);
    assert.ok(!stages.join().includes('private fixture'));
  }
  // Cancellation must settle even when the resolver never completes.
  const stopped = new AbortController();
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
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

  const raw = (id, elements = [element()]) => ({
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
  function fixture(resolve) {
    let callback;
    const events = [],
      requests = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(value) {
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
          getUin(ids) {
            requests.push(ids);
            return resolve(ids);
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: (event, payload) => events.push([event, payload]) },
    });
    return { services, events, requests, callback: () => callback };
  }
  const peer = { type: 'group', groupId: '123' };
  for (const method of ['getMessage', 'getHistory', 'getForwardMessages']) {
    const f = fixture(async () => ({ uinInfo: new Map([['u_target', exact]]) }));
    try {
      const value = await f.services.invokeOperation(method, {
        peer,
        messageId: '1',
        rootMessageId: '10',
        parentMessageId: '20',
        options: { limit: 2 },
      });
      for (const message of Array.isArray(value) ? value : [value])
        assert.deepEqual(message.elements, [{ type: 'at', userId: exact, text: '@fixture' }]);
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
  let finish;
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
      f.events.filter(([event]) => event === 'message').map(([, message]) => message.messageId),
      ['1', '2', '3'],
    );
    f.callback().onRecvMsg([raw('1'), raw('2')]);
    await flush();
    assert.equal(f.requests.length, 1);
  } finally {
    f.services.close();
  }
  // Native callback records may be reused before queued identity work starts.
  let releaseFirst,
    lookupCount = 0;
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
    second.elements[0].textElement.atNtUid = 'u_mutated';
    second.elements[0].textElement.content = 'mutated callback object';
    await flush();
    assert.deepEqual(captured.requests, [['u_target']]);
    releaseFirst({ uinInfo: new Map([['u_target', exact]]) });
    await flush();
    const messages = captured.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => message);
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
