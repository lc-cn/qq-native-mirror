import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Installed compiled modules and fake callbacks only, without native/client/account initialization.
export async function verifyReceivedConsumer(packagePath) {
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createNativeServices } = await load('native-services.js');
  const { decodeNativeMessages } = await load('features/messages/inbound-messages.js');
  const exact = '900719925474099312345',
    peer = { type: 'private', userId: '456' };
  const mention = () => ({
    elementType: 1,
    textElement: { atType: 2, atUid: '0', atNtUid: 'u_sender', content: '@fixture' },
  });
  const raw = (change = {}) => ({
    chatType: 1,
    peerUid: 'u_peer',
    peerUin: '0',
    senderUid: 'u_sender',
    senderUin: '',
    msgId: '0001',
    msgSeq: '0009',
    msgTime: '100',
    elements: [mention()],
    ...change,
  });
  const resolved = () => ({
    uinInfo: new Map([
      ['u_peer', '000456'],
      ['u_sender', exact],
    ]),
  });
  function fixture(records, resolver = async () => resolved()) {
    let listener;
    const calls = [],
      events = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(value) {
            listener = value;
          },
          getMsgsByMsgId: () => ({ result: 0, msgList: records }),
          getMsgsIncludeSelf: () => ({ result: 0, msgList: records }),
          getMultiMsg: () => ({ result: 0, msgList: records }),
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getUixConvertService: () => ({
          getUid: () => ({ uidInfo: new Map([['456', 'u_peer']]) }),
          getUin(ids) {
            calls.push(ids);
            return resolver(ids);
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: (event, value) => events.push([event, value]) },
    });
    return { services, calls, events, listener: () => listener };
  }
  const payload = {
    peer,
    messageId: '0001',
    rootMessageId: '10',
    parentMessageId: '20',
    options: {},
  };
  for (const method of ['getMessage', 'getHistory', 'getForwardMessages']) {
    const native = raw(),
      f = fixture([native]);
    try {
      const value = await f.services.invokeOperation(method, payload),
        message = Array.isArray(value) ? value[0] : value;
      assert.deepEqual(message.peer, { type: 'private', userId: '000456' });
      assert.deepEqual(message.sender, { userId: exact, uid: 'u_sender', nickname: '' });
      assert.equal(message.messageId, '0001');
      assert.equal(message.sequence, '0009');
      assert.equal(message.raw, native);
      assert.deepEqual(message.elements, [{ type: 'at', userId: exact, text: '@fixture' }]);
      assert.deepEqual(
        f.calls,
        [['u_peer', 'u_sender']],
        'Sender mention and required identity share one deduplicated lookup',
      );
    } finally {
      f.services.close();
    }
    for (const response of [
      { uinInfo: new Map() },
      {
        uinInfo: new Map([
          ['u_peer', '0'],
          ['u_sender', 456],
        ]),
      },
      { uinInfo: {} },
    ]) {
      const failed = fixture([raw()], async () => response);
      try {
        await assert.rejects(
          failed.services.invokeOperation(method, payload),
          /unresolved.*identity/i,
        );
        assert.equal(failed.calls.length, 1);
      } finally {
        failed.services.close();
      }
    }
  }
  for (const change of [
    { msgSeq: undefined },
    { msgTime: '9007199254740993' },
    { senderUin: {} },
    { sendNickName: {} },
    { peerUid: '' },
  ]) {
    const f = fixture([raw(), raw({ msgId: '2', ...change })]);
    try {
      await assert.rejects(
        f.services.invokeOperation('getHistory', payload),
        /invalid|metadata|native|nickname/i,
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.services.close();
    }
  }
  const known = fixture([
    raw({
      peerUin: '000456',
      senderUin: exact,
      senderUid: undefined,
      elements: [],
      sendNickName: undefined,
    }),
  ]);
  try {
    const message = await known.services.invokeOperation('getMessage', payload);
    assert.deepEqual(message.sender, { userId: exact, uid: '', nickname: '' });
    assert.equal(known.calls.length, 0);
  } finally {
    known.services.close();
  }
  const flush = async () => {
    for (let n = 0; n < 4; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  const mixed = fixture([], async () => ({ uinInfo: new Map() }));
  try {
    mixed
      .listener()
      .onRecvMsg([raw(), raw({ msgId: '2', peerUin: '456', senderUin: exact, elements: [] })]);
    await flush();
    assert.deepEqual(
      mixed.events.filter(([event]) => event === 'message').map(([, message]) => message.messageId),
      ['2'],
    );
    assert.ok(
      mixed.events.some(
        ([event, value]) =>
          event === 'diagnostic' && value.stage === 'unresolved-native-message-identity',
      ),
    );
  } finally {
    mixed.services.close();
  }
  let release,
    n = 0;
  const queued = fixture([], () =>
    ++n === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(resolved()),
  );
  try {
    const second = raw({ msgId: '2' });
    queued.listener().onRecvMsg([raw()]);
    queued.listener().onRecvMsg([second]);
    second.msgId = '999';
    second.peerUid = 'u_changed';
    second.senderUid = 'u_changed';
    second.elements[0].textElement.content = 'changed';
    await flush();
    release(resolved());
    await flush();
    const delivered = queued.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => message);
    assert.deepEqual(
      delivered.map((message) => message.messageId),
      ['0001', '2'],
    );
    for (const message of delivered) {
      assert.deepEqual(message.peer, { type: 'private', userId: '000456' });
      assert.equal(message.sender.userId, exact);
      assert.equal(message.elements[0].text, '@fixture');
    }
    assert.equal(delivered[1].raw, second);
    assert.deepEqual(queued.calls, [
      ['u_peer', 'u_sender'],
      ['u_peer', 'u_sender'],
    ]);
    queued.listener().onRecvMsg([raw({ msgId: '2' })]);
    await flush();
    assert.equal(queued.calls.length, 2);
  } finally {
    queued.services.close();
  }
  // Valid UIN-only private callbacks do not need synthetic UIDs for projection/dedup.
  const uinOnly = fixture([]);
  try {
    const record = raw({
      peerUid: undefined,
      senderUid: undefined,
      peerUin: '000456',
      senderUin: exact,
      elements: [],
    });
    uinOnly.listener().onRecvMsg([record]);
    await flush();
    uinOnly.listener().onRecvMsg([{ ...record }]);
    await flush();
    uinOnly.listener().onRecvMsg([{ ...record, peerUin: '789' }]);
    await flush();
    const messages = uinOnly.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => message);
    assert.deepEqual(
      messages.map((message) => message.peer),
      [
        { type: 'private', userId: '000456' },
        { type: 'private', userId: '789' },
      ],
    );
    assert.equal(messages[0].sender.uid, '');
    assert.equal(uinOnly.calls.length, 0);
  } finally {
    uinOnly.services.close();
  }
  // Query DTO fields are captured before an identity lookup can yield control.
  let finishPicture;
  const pictureRaw = raw({
    elements: [{ elementType: 2, picElement: { filePath: '/fixture/original.png' } }],
  });
  const picture = fixture(
    [pictureRaw],
    () =>
      new Promise((resolve) => {
        finishPicture = resolve;
      }),
  );
  try {
    const pending = picture.services.invokeOperation('getMessage', payload);
    await flush();
    pictureRaw.msgId = '999';
    pictureRaw.peerUid = 'u_changed';
    pictureRaw.senderUid = 'u_changed';
    pictureRaw.elements[0].picElement.filePath = '/fixture/changed.png';
    finishPicture(resolved());
    const message = await pending;
    assert.equal(message.messageId, '0001');
    assert.deepEqual(message.peer, { type: 'private', userId: '000456' });
    assert.equal(message.sender.uid, 'u_sender');
    assert.equal(message.sender.userId, exact);
    assert.deepEqual(message.elements, [{ type: 'image', file: '/fixture/original.png' }]);
    assert.equal(message.raw, pictureRaw);
    assert.deepEqual(picture.calls, [['u_peer', 'u_sender']]);
  } finally {
    picture.services.close();
  }
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    decodeNativeMessages(
      [raw()],
      [raw()],
      async () => {
        calls++;
        return new Map();
      },
      before.signal,
      () => {},
    ),
    /abort/i,
  );
  assert.equal(calls, 0);
  const canceled = fixture([raw()], () => new Promise(() => {}));
  const pending = canceled.services.invokeOperation('getMessage', payload),
    checked = assert.rejects(pending, /abort|closed/i);
  await flush();
  canceled.services.close();
  let timer;
  try {
    await Promise.race([
      checked,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Identity close did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    canceled.services.close();
  }
  assert.equal(canceled.calls.length, 1);
  const unknownElement = { elementType: 999, fixture: { preserved: true } },
    nativeUnknown = raw({ elements: [unknownElement] });
  const unknown = fixture([nativeUnknown]);
  try {
    const message = await unknown.services.invokeOperation('getMessage', payload);
    assert.equal(message.elements[0].data, unknownElement);
    assert.equal(message.raw, nativeUnknown);
    unknown.listener().onRecvMsg([nativeUnknown]);
    await flush();
    assert.equal(
      unknown.events.find(([event]) => event === 'message')[1].elements[0].data,
      unknownElement,
    );
  } finally {
    unknown.services.close();
  }
  // Receipt projection and dedup share one capture, even if raw properties have
  // side effects. Only the fields used by projection are acquired; raw identity
  // remains available to the application without evaluating unrelated members.
  const snapshots = fixture([]);
  try {
    let unrelatedReads = 0;
    const record = raw({ msgId: '1', peerUin: '456', senderUin: exact, elements: [] });
    Object.defineProperty(record, 'unrelatedEnumerable', {
      enumerable: true,
      get() {
        unrelatedReads++;
        record.msgId = '2';
        return null;
      },
    });
    snapshots.listener().onRecvMsg([record]);
    snapshots
      .listener()
      .onRecvMsg([raw({ msgId: '1', peerUin: '456', senderUin: exact, elements: [] })]);
    snapshots
      .listener()
      .onRecvMsg([raw({ msgId: '2', peerUin: '456', senderUin: exact, elements: [] })]);
    await flush();
    const delivered = snapshots.events
      .filter(([event]) => event === 'message')
      .map(([, message]) => message);
    assert.deepEqual(
      delivered.map((message) => message.messageId),
      ['1', '2'],
    );
    assert.equal(delivered[0].raw, record);
    assert.equal(unrelatedReads, 0, 'No unrelated raw getter is acquired');
    const counters = new Map();
    const once = raw({ msgId: '3', peerUin: '456', senderUin: exact, elements: [] });
    for (const name of [
      'msgId',
      'msgSeq',
      'msgTime',
      'peerUid',
      'peerUin',
      'senderUid',
      'senderUin',
      'sendNickName',
      'elements',
    ]) {
      const value = once[name];
      Object.defineProperty(once, name, {
        enumerable: true,
        get() {
          counters.set(name, (counters.get(name) ?? 0) + 1);
          return value;
        },
      });
    }
    snapshots.listener().onRecvMsg([once]);
    await flush();
    for (const count of counters.values()) assert.equal(count, 1);
    assert.equal(counters.size, 9);
    assert.equal(snapshots.events.filter(([event]) => event === 'message').length, 3);
    assert.equal(snapshots.calls.length, 0);
  } finally {
    snapshots.services.close();
  }
  return {
    receivedMessageContract: true,
    receivedMessageSnapshotContract: true,
    nativeReceivedIdentityLookupAttempted: false,
  };
}
