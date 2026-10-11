import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

// Synthetic services exercise installed compiled code, never a native client/account.
export async function verifySendConsumer(packagePath) {
  const { createNativeServices } = await import(
    pathToFileURL(join(packagePath, 'dist/native-services.js')).href
  );
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  async function bounded(promise) {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Synthetic send cancellation did not settle')),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function fixture(options = {}) {
    let listener,
      generated = 0;
    const calls = [],
      conversions = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(value) {
            listener = value;
          },
          generateMsgUniqueId() {
            generated++;
            return options.unique?.() ?? `fixture-${generated}`;
          },
          sendMsg(...args) {
            calls.push(args);
            if (options.send) return options.send(listener, args);
            listener.onMsgInfoListUpdate([
              { guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' },
            ]);
            return { result: 0 };
          },
        }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getUixConvertService: () => ({
          getUid(ids) {
            conversions.push(ids);
            return options.uid?.(ids) ?? { uidInfo: new Map(ids.map((id) => [id, `u_${id}`])) };
          },
        }),
        getMSFService: () => ({ getServerTime: () => '100' }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    return { services, calls, conversions, generated: () => generated, callback: () => listener };
  }
  const group = (message = 'synthetic fixture') => ({ groupId: '123', message });
  for (const [method, payload] of [
    ['sendPrivateMessage', { userId: '456', message: Array(1) }],
    [
      'sendPrivateMessage',
      {
        userId: '456',
        message: [
          { type: 'text', text: 'valid' },
          { type: 'text', text: {} },
        ],
      },
    ],
    [
      'sendGroupMessage',
      group([
        { type: 'at', userId: '456' },
        { type: 'text', text: {} },
      ]),
    ],
    ['sendGroupMessage', group([{ type: 'reply', messageId: '42' }, { type: 'unknown' }])],
    ['sendGroupMessage', group([{ type: 'at', userId: '0' }])],
  ]) {
    const f = fixture();
    try {
      await assert.rejects(
        f.services.invokeOperation(method, payload),
        /message|element|text|mention|identifier/i,
      );
      assert.deepEqual(f.conversions, []);
      assert.equal(f.generated(), 0);
      assert.equal(f.calls.length, 0);
    } finally {
      f.services.close();
    }
  }
  let resolveUid;
  const snapshot = fixture({
    uid: () =>
      new Promise((resolve) => {
        resolveUid = resolve;
      }),
  });
  try {
    const element = { type: 'text', text: 'original' },
      input = [element];
    const payload = { userId: '456', message: input };
    const pending = snapshot.services.invokeOperation('sendPrivateMessage', payload);
    await tick();
    payload.userId = '999';
    payload.message = 'replaced';
    element.text = 'mutated';
    input.push({ type: 'text', text: 'injected' });
    resolveUid({ uidInfo: new Map([['456', 'u_456']]) });
    await pending;
    assert.deepEqual(snapshot.conversions, [['456']]);
    assert.equal(snapshot.calls[0][1].chatType, 1);
    assert.equal(snapshot.calls[0][1].peerUid, 'u_456');
    assert.equal(snapshot.calls[0][2].length, 1);
    assert.equal(snapshot.calls[0][2][0].textElement.content, 'original');
  } finally {
    snapshot.services.close();
  }
  const immediate = fixture({
    send(listener, args) {
      const terminal = {
        guildId: args[1].guildId,
        chatType: 2,
        peerUid: '123',
        sendStatus: 2,
        msgId: '000900719925474099312345',
        msgSeq: '0009',
        msgTime: '100',
      };
      listener.onMsgInfoListUpdate([{ ...terminal, sendStatus: 1 }, terminal]);
      terminal.msgId = 'mutated';
      terminal.msgSeq = 'mutated';
      terminal.msgTime = 'mutated';
      return { result: 0 };
    },
  });
  try {
    assert.deepEqual(await immediate.services.invokeOperation('sendGroupMessage', group()), {
      messageId: '000900719925474099312345',
      sequence: '0009',
      time: 100,
    });
    assert.equal(immediate.calls.length, 1);
  } finally {
    immediate.services.close();
  }
  for (const change of [
    { msgId: 42 },
    { msgId: undefined },
    { msgSeq: {} },
    { msgTime: '9007199254740993' },
  ]) {
    const f = fixture({
      send(listener, args) {
        listener.onMsgInfoListUpdate([
          {
            guildId: args[1].guildId,
            sendStatus: 2,
            msgId: '42',
            msgSeq: '9',
            msgTime: '100',
            ...change,
          },
        ]);
        return { result: 0 };
      },
    });
    try {
      await assert.rejects(
        f.services.invokeOperation('sendGroupMessage', group()),
        /receipt|metadata|time/i,
      );
      assert.equal(f.calls.length, 1);
    } finally {
      f.services.close();
    }
  }
  const wrong = fixture({
    send(listener, args) {
      listener.onMsgInfoListUpdate([
        {
          guildId: args[1].guildId,
          chatType: 2,
          peerUid: '999',
          sendStatus: 2,
          msgId: '42',
          msgSeq: '9',
          msgTime: '100',
        },
      ]);
      return { result: 0 };
    },
  });
  let settled = false;
  const wrongPending = wrong.services.invokeOperation('sendGroupMessage', group());
  wrongPending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  await tick();
  assert.equal(settled, false);
  const wrongChecked = assert.rejects(wrongPending, /abort|closed/i);
  wrong.services.close();
  await bounded(wrongChecked);
  for (const fails of [false, true]) {
    const f = fixture({
      unique: () => 'same-token',
      send(listener, args) {
        listener.onMsgInfoListUpdate([
          { guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' },
        ]);
        return { result: fails ? 23 : 0 };
      },
    });
    try {
      const first = f.services.invokeOperation('sendGroupMessage', group());
      if (fails) await assert.rejects(first, { code: 23 });
      else await first;
      f.callback().onMsgInfoListUpdate([
        { guildId: 'same-token', sendStatus: 2, msgId: '999', msgSeq: '1', msgTime: '100' },
      ]);
      await assert.rejects(
        f.services.invokeOperation('sendGroupMessage', group()),
        /duplicate|correlation/i,
      );
      assert.equal(f.calls.length, 1);
    } finally {
      f.services.close();
    }
  }
  // A callback cannot bypass the still-pending native submission result.
  const callbackBeforeSubmission = fixture({
    send(listener, args) {
      listener.onMsgInfoListUpdate([
        { guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' },
      ]);
      return new Promise(() => {});
    },
  });
  let earlySettled = false;
  const callbackPending = callbackBeforeSubmission.services.invokeOperation(
    'sendGroupMessage',
    group(),
  );
  callbackPending.then(
    () => {
      earlySettled = true;
    },
    () => {
      earlySettled = true;
    },
  );
  const callbackChecked = assert.rejects(callbackPending, /abort|closed/i);
  try {
    await tick();
    await tick();
    assert.equal(earlySettled, false, 'Native submission must settle before success is accepted');
    callbackBeforeSubmission.services.close();
    await bounded(callbackChecked);
    assert.equal(callbackBeforeSubmission.calls.length, 1);
  } finally {
    callbackBeforeSubmission.services.close();
  }
  for (const uidPending of [false, true]) {
    let release;
    const f = fixture(
      uidPending
        ? {
            uid: () =>
              new Promise((resolve) => {
                release = resolve;
              }),
          }
        : { send: () => new Promise(() => {}) },
    );
    const pending = f.services.invokeOperation(
      uidPending ? 'sendPrivateMessage' : 'sendGroupMessage',
      uidPending ? { userId: '456', message: 'fixture' } : group(),
    );
    const checked = assert.rejects(pending, /abort|closed/i);
    await tick();
    f.services.close();
    await bounded(checked);
    if (uidPending) {
      release({ uidInfo: new Map([['456', 'u_456']]) });
      await tick();
      assert.equal(f.calls.length, 0);
      assert.equal(f.generated(), 0);
    } else assert.equal(f.calls.length, 1);
  }
  const publicChecks = await verifyPublicSendCapture(packagePath);
  return { ...publicChecks, sendMessageContract: true, nativeSendAttempted: false };
}

/** Public installed facade input capture before any controlled IPC is dispatched. */
async function verifyPublicSendCapture(packagePath) {
  const { QQClient } = await import(pathToFileURL(join(packagePath, 'dist/index.js')).href);
  const worker = new EventEmitter();
  const calls = [];
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    send(value, callback) {
      calls.push(value);
      callback(null);
      queueMicrotask(() =>
        worker.emit('message', {
          id: value.id,
          result: { messageId: '00042', sequence: '0009', time: 100 },
        }),
      );
    },
  });
  const client = new QQClient(worker, 500);
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    for (const action of [
      () => client.sendPrivateMessage('0', 'text'),
      () => client.sendGroupMessage('123', Array(1)),
      () =>
        client.sendPrivateMessage('456', [
          { type: 'text', text: 'valid' },
          { type: 'text', text: {} },
        ]),
      () =>
        client.sendGroupMessage('123', [
          { type: 'at', userId: '456' },
          { type: 'text', text: {} },
        ]),
    ])
      await assert.rejects(Promise.resolve().then(action));
    assert.deepEqual(calls, []);
    for (const [method, id] of [
      ['sendPrivateMessage', '000456'],
      ['sendGroupMessage', '000123'],
    ]) {
      const element = { type: 'text', text: 'captured' },
        input = [element];
      const before = calls.length;
      const pending = client[method](id, input);
      element.text = 'changed';
      input.push({ type: 'text', text: 'injected' });
      assert.deepEqual(await pending, { messageId: '00042', sequence: '0009', time: 100 });
      assert.equal(calls.length, before + 1);
      assert.equal(calls[before].method, method);
      assert.equal(calls[before][method === 'sendPrivateMessage' ? 'userId' : 'groupId'], id);
      assert.deepEqual(calls[before].message, [{ type: 'text', text: 'captured' }]);
    }
    return {
      publicSendPreflightContract: true,
      publicSendSnapshotContract: true,
      privateUidSenderRouteContract: true,
      sendUidCloseNoLateWriteContract: true,
    };
  } finally {
    Object.assign(worker, { connected: false, exitCode: 0 });
    worker.emit('exit', 0, null);
    await client.close();
  }
}
