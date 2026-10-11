/** @typedef {{'features/forward/merged-forward-card.js':typeof import('../../src/features/forward/merged-forward-card.ts'),
'native-services.js':typeof import('../../src/native-services.ts')}} InstalledModules */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Owned fixtures only; no QQ loading, login, transport, or attachment query.
/** @param {string} packagePath */
export async function verifyReceivedForwardConsumer(packagePath) {
  /** @template {keyof InstalledModules} Name @param {Name} name @returns {Promise<InstalledModules[Name]>} */
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createNativeServices } = await load('native-services.js');
  const { buildMergedForwardCard } = await load('features/forward/merged-forward-card.js');
  await checkReceivedForwardServices({ createNativeServices, buildMergedForwardCard });
  return { receivedForwardContract: true, nativeReceivedForwardObserved: false };
}
/** @param {{createNativeServices:InstalledModules['native-services.js']['createNativeServices'],buildMergedForwardCard:InstalledModules['features/forward/merged-forward-card.js']['buildMergedForwardCard']}} dependencies */
export async function checkReceivedForwardServices({
  createNativeServices,
  buildMergedForwardCard,
}) {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  };
  const card = () =>
    buildMergedForwardCard({
      resourceId: 'r',
      cardId: '00000000-0000-4000-8000-000000000000',
      nodes: [{ displayName: 'fixture', text: 'text' }],
    });
  const native16 = () => ({
    elementType: 16,
    multiForwardMsgElement: {
      resId: 'native-r',
      fileName: 'native-file',
      xmlContent: '<opaque-fixture />',
    },
  });
  /** @returns {Record<string,unknown>[]} */
  const elements = () => [
    { elementType: 1, textElement: { content: 'before', atType: 0 } },
    { ...card() },
    native16(),
    { elementType: 10, arkElement: { bytesData: '{"app":"unrelated"}' } },
    { elementType: 1, textElement: { content: 'after', atType: 0 } },
  ];
  const raw = (id = '1', missing = false) => ({
    msgId: id,
    msgSeq: '9',
    msgTime: '100',
    chatType: 2,
    peerUid: '123',
    senderUin: missing ? '0' : '456',
    senderUid: 'u_sender',
    elements: elements(),
  });
  /** @param {unknown[]} records @param {(ids:string[])=>unknown} resolver */
  function fixture(records = [], resolver = () => ({ uinInfo: new Map([['u_sender', '456']]) })) {
    /** @type {{onRecvMsg(value:unknown):void}|undefined} */
    let listener;
    /** @type {[string,unknown[]][]} */
    const calls = [];
    /** @type {[string,unknown][]} */
    const events = [];
    /** @type {string[][]} */
    const lookups = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          /** @param {{onRecvMsg(value:unknown):void}} value */
          addKernelMsgListener(value) {
            listener = value;
          },
          /** @param {unknown[]} args */
          getMsgsByMsgId(...args) {
            calls.push(['getMessage', args]);
            return { result: 0, msgList: records };
          },
          /** @param {unknown[]} args */
          getMsgsIncludeSelf(...args) {
            calls.push(['getHistory', args]);
            return { result: 0, msgList: records };
          },
          /** @param {unknown[]} args */
          getMultiMsg(...args) {
            calls.push(['getForwardMessages', args]);
            return { result: 0, msgList: records };
          },
        }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getUixConvertService: () => ({
          /** @param {string[]} ids */
          getUin(ids) {
            lookups.push(ids);
            return resolver(ids);
          },
          getUid() {
            throw Error('Unexpected recipient query');
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: (event, value) => events.push([event, value]) },
    });
    return {
      services,
      calls,
      events,
      lookups,
      listener: () => {
        assert.ok(listener);
        return listener;
      },
    };
  }
  const payload = {
    peer: { type: 'group', groupId: '123' },
    messageId: '1',
    rootMessageId: '10',
    parentMessageId: '20',
    options: { limit: 3 },
  };
  /** @param {unknown} message @param {{elements:Record<string,unknown>[]}} original */
  function check(message, original) {
    assertMessage(message);
    assert.equal(message.raw, original);
    assertMessage(message);
    assert.deepEqual(
      message.elements.map((e) => e.type),
      ['text', 'forward', 'forward', 'unknown', 'text'],
    );
    assert.equal(message.elements[0].type, 'text');
    assert.ok(message.elements[0].type === 'text');
    assert.equal(message.elements[0].text, 'before');
    assert.ok(message.elements[4].type === 'text');
    assert.equal(message.elements[4].text, 'after');
    assert.deepEqual(message.elements[1], {
      type: 'forward',
      format: 'ark',
      resourceId: 'r',
      cardId: '00000000-0000-4000-8000-000000000000',
      title: '聊天记录',
      summary: '查看1条消息',
      prompt: '[聊天记录]',
      count: 1,
      previews: ['fixture:text'],
    });
    assert.deepEqual(message.elements[2], {
      type: 'forward',
      format: 'native',
      resourceId: 'native-r',
      cardId: 'native-file',
    });
    assert.ok(message.elements[3].type === 'unknown');
    assert.equal(message.elements[3].data, original.elements[3]);
  }
  for (const method of /** @type {const} */ (['getMessage', 'getHistory', 'getForwardMessages'])) {
    const original = raw(),
      f = fixture([original]);
    try {
      const value = await f.services.invokeOperation(method, payload);
      check(Array.isArray(value) ? value[0] : value, original);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0][0], method);
      assert.equal(f.lookups.length, 0);
    } finally {
      f.services.close();
    }
  }
  const live = fixture();
  try {
    const original = raw();
    live.listener().onRecvMsg([original]);
    await flush();
    const delivered = live.events.filter(([event]) => event === 'message');
    assert.equal(delivered.length, 1);
    check(delivered[0][1], original);
    assert.equal(live.calls.length, 0);
    assert.equal(live.lookups.length, 0);
  } finally {
    live.services.close();
  }
  const invalidRaw = raw('4');
  invalidRaw.elements = [
    { elementType: 10, arkElement: { bytesData: '{' } },
    { elementType: 16, multiForwardMsgElement: { resId: 'x', fileName: 'file' } },
    {
      elementType: 10,
      arkElement: { bytesData: '{"app":"com.tencent.multimsg","meta":{"detail":{"resid":0}}}' },
    },
  ];
  const invalid = fixture([invalidRaw]);
  try {
    const message = await invalid.services.invokeOperation('getMessage', {
      ...payload,
      messageId: '4',
    });
    assertMessage(message);
    assert.deepEqual(
      message.elements.map((e) => e.type),
      ['unknown', 'unknown', 'unknown'],
    );
    for (let i = 0; i < 3; i++) {
      /** @type {import('../../src/types.ts').MessageElement} */
      const entry = message.elements[i];
      assert.ok(entry.type === 'unknown');
      assert.equal(entry.data, invalidRaw.elements[i]);
    }
    assert.equal(invalid.calls.length, 1);
    assert.equal(invalid.lookups.length, 0);
  } finally {
    invalid.services.close();
  }
  let accessorReads = 0,
    coercions = 0;
  const getter = () => {
    accessorReads++;
    return card().arkElement.bytesData;
  };
  const unsafe = raw('5');
  unsafe.elements = [
    {
      elementType: 10,
      arkElement: Object.defineProperty({}, 'bytesData', { get: getter, enumerable: true }),
    },
    Object.defineProperty({ elementType: 10 }, 'arkElement', {
      get() {
        accessorReads++;
        return card().arkElement;
      },
      enumerable: true,
    }),
    Object.defineProperty({}, 'elementType', {
      get() {
        accessorReads++;
        return 10;
      },
      enumerable: true,
    }),
    {
      elementType: {
        valueOf() {
          coercions++;
          return 10;
        },
      },
      arkElement: card().arkElement,
    },
    {
      elementType: 16,
      multiForwardMsgElement: Object.defineProperty({ fileName: 'f', xmlContent: '' }, 'resId', {
        get() {
          accessorReads++;
          return 'r';
        },
        enumerable: true,
      }),
    },
    ...['10', '1e1', '16'].map((elementType) =>
      Object.defineProperty({ elementType, arkElement: card().arkElement }, 'textElement', {
        get() {
          accessorReads++;
          return { content: 'invalid-card-type', atType: 0 };
        },
        enumerable: true,
      }),
    ),
  ];
  for (const method of /** @type {const} */ (['getMessage', 'getHistory', 'getForwardMessages'])) {
    const f = fixture([unsafe]);
    try {
      const value = await f.services.invokeOperation(method, { ...payload, messageId: '5' });
      const message = Array.isArray(value) ? value[0] : value;
      assertMessage(message);
      assert.deepEqual(
        message.elements.map((e) => e.type),
        Array(unsafe.elements.length).fill('unknown'),
      );
      for (let i = 0; i < unsafe.elements.length; i++) {
        /** @type {import('../../src/types.ts').MessageElement} */
        const entry = message.elements[i];
        assert.ok(entry.type === 'unknown');
        assert.equal(entry.data, unsafe.elements[i]);
      }
      assert.equal(accessorReads, 0);
      assert.equal(coercions, 0);
      assert.equal(f.lookups.length, 0);
    } finally {
      f.services.close();
    }
  }
  const unsafeLive = fixture();
  try {
    unsafeLive.listener().onRecvMsg([unsafe]);
    await flush();
    const messages = unsafeLive.events.filter(([event]) => event === 'message');
    assert.equal(messages.length, 1);
    assertMessage(messages[0][1]);
    assert.deepEqual(
      messages[0][1].elements.map((e) => e.type),
      Array(unsafe.elements.length).fill('unknown'),
    );
    assert.equal(accessorReads, 0);
    assert.equal(coercions, 0);
  } finally {
    unsafeLive.services.close();
  }
  /** @type {(value:unknown)=>void} */
  let finish = () => assert.fail('Resolver not started');
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const queued = fixture([], () => pending);
  try {
    const first = raw('2', true),
      second = raw('3');
    queued.listener().onRecvMsg([first]);
    await flush();
    queued.listener().onRecvMsg([second]);
    assertRecord(first.elements[1].arkElement);
    assertRecord(first.elements[2].multiForwardMsgElement);
    assertRecord(second.elements[1].arkElement);
    assertRecord(second.elements[2].multiForwardMsgElement);
    first.elements[1].arkElement.bytesData = '{}';
    first.elements[2].multiForwardMsgElement.resId = 'mutated';
    first.elements[2].multiForwardMsgElement.fileName = 'mutated';
    second.elements[1].arkElement.bytesData = '{}';
    second.elements[2].multiForwardMsgElement.resId = 'mutated';
    second.elements[2].multiForwardMsgElement.fileName = 'mutated';
    finish({ uinInfo: new Map([['u_sender', '456']]) });
    await flush();
    const messages = queued.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => {
        assertMessage(message);
        return message;
      });
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => message.messageId),
      ['2', '3'],
    );
    for (const message of messages) {
      assert.deepEqual(message.elements[1], {
        type: 'forward',
        format: 'ark',
        resourceId: 'r',
        cardId: '00000000-0000-4000-8000-000000000000',
        title: '聊天记录',
        summary: '查看1条消息',
        prompt: '[聊天记录]',
        count: 1,
        previews: ['fixture:text'],
      });
      assert.deepEqual(message.elements[2], {
        type: 'forward',
        format: 'native',
        resourceId: 'native-r',
        cardId: 'native-file',
      });
    }
    assert.equal(messages[0].raw, first);
    assert.equal(messages[1].raw, second);
    assert.equal(queued.calls.length, 0);
    assert.equal(queued.lookups.length, 1);
  } finally {
    queued.services.close();
  }
}

/** @param {unknown} value @returns {asserts value is Record<string,unknown>} */
function assertRecord(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
}
/** @param {unknown} value @returns {asserts value is import('../../src/types.ts').Message} */
function assertMessage(value) {
  assertRecord(value);
  assert.equal(typeof value.messageId, 'string');
  assert.ok(Array.isArray(value.elements));
  assert.ok('raw' in value);
}
