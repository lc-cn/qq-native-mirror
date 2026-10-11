import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMessageRecalls,
  type RecallMessagePort,
} from '../src/features/messages/recall-operation.ts';
import type { NativePeer } from '../src/native/message-contracts.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const peer = { chatType: 2 as const, peerUid: '123' };
const update = { ...peer, msgId: '42', recallTime: '101' };
function fixture(service: RecallMessagePort, resolvePeer = async () => peer) {
  const lifetime = new NativeServiceLifetime();
  const channel = createNativeEventChannel(lifetime.signal);
  let acquisitions = 0;
  const owner = createMessageRecalls({
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    resolvePeer,
    getMessageService() {
      acquisitions++;
      return service;
    },
    eventCall: channel.call,
  });
  return {
    owner,
    channel,
    lifetime,
    get acquisitions() {
      return acquisitions;
    },
    close() {
      owner.close();
      channel.close();
      lifetime.close();
    },
  };
}
test('whole input snapshot precedes pending UID, single method capture preserves receiver', async () => {
  let finish!: (value: typeof peer) => void;
  let reads = 0;
  let calls = 0;
  const service: RecallMessagePort = {
    get recallMsg() {
      reads++;
      return function (this: RecallMessagePort, selected: NativePeer, ids: string[]) {
        assert.equal(this, service);
        assert.deepEqual(selected, peer);
        assert.deepEqual(ids, ['42']);
        calls++;
        f.channel.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
        return { result: 0 };
      };
    },
  };
  const f = fixture(
    service,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const payload = { peer: { type: 'group', groupId: '123' }, messageId: '42' };
    const p = f.owner.recall(payload);
    payload.messageId = '99';
    finish(peer);
    await p;
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test('invalid input preflight and closed owner never acquire', async () => {
  const f = fixture({});
  try {
    await assert.rejects(
      f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: 42 }),
    );
    f.owner.close();
    await assert.rejects(
      f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' }),
      /closed/,
    );
    assert.equal(f.acquisitions, 0);
  } finally {
    f.close();
  }
});
test('local close immediately cancels pending UID and observes late rejection', async () => {
  let reject!: (value: unknown) => void;
  const f = fixture(
    {},
    () =>
      new Promise((_r, j) => {
        reject = j;
      }),
  );
  try {
    const p = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    const check = assert.rejects(p, /closed/);
    f.owner.close();
    await check;
    reject(Error('late UID'));
    await tick();
    assert.equal(f.acquisitions, 0);
  } finally {
    f.close();
  }
});
test('getter closing owner prevents dispatch', async () => {
  let reads = 0,
    calls = 0;
  const f = fixture({
    get recallMsg() {
      reads++;
      f.owner.close();
      return () => {
        calls++;
      };
    },
  });
  try {
    await assert.rejects(
      f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' }),
      /closed/,
    );
    assert.equal(reads, 1);
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});
test('early callback waits ACK; native failure identity wins', async () => {
  let reject!: (value: unknown) => void;
  let settled = false;
  const failure = Error('native');
  const f = fixture({
    recallMsg() {
      f.channel.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
      return new Promise((_r, j) => {
        reject = j;
      });
    },
  });
  try {
    const p = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    p.then(
      () => {
        settled = true;
      },
      () => {},
    );
    await tick();
    assert.equal(settled, false);
    const check = assert.rejects(p, (e) => e === failure);
    reject(failure);
    await check;
  } finally {
    f.close();
  }
});
test('malformed recall times/accessors cannot complete; valid callback does', async () => {
  let reads = 0;
  const f = fixture({
    recallMsg() {
      return { result: 0 };
    },
  });
  try {
    const p = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    await tick();
    for (const time of ['00', false, 101])
      f.channel.dispatch('Msg/onMsgInfoListUpdate', [[{ ...update, recallTime: time }]]);
    f.channel.dispatch('Msg/onMsgInfoListUpdate', [
      [
        {
          ...update,
          get recallTime() {
            reads++;
            return '101';
          },
        },
      ],
    ]);
    f.channel.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
    await p;
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});
test('ACK accessor is not executed and nonzero code remains safe', async () => {
  for (const result of [
    Object.defineProperty({}, 'result', {
      get() {
        throw Error('sensitive');
      },
    }),
    { result: 7 },
  ]) {
    const f = fixture({
      recallMsg() {
        return result;
      },
    });
    try {
      await assert.rejects(
        f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' }),
        (e) =>
          e instanceof Error &&
          'code' in e &&
          e.code ===
            (Object.hasOwn(result, 'result') &&
            Object.getOwnPropertyDescriptor(result, 'result')?.value === 7
              ? 7
              : 'invalid-result'),
      );
    } finally {
      f.close();
    }
  }
});
test('account cancellation and local cancellation preserve sibling channel waits', async () => {
  let reject!: (value: unknown) => void;
  const f = fixture(
    {},
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  try {
    const pending = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    const check = assert.rejects(pending);
    const sibling = f.channel.call(
      'Other',
      (value: number) => value === 1 || undefined,
      () => ({ result: 0 }),
    );
    f.owner.close();
    await check;
    f.channel.dispatch('Other', [1]);
    await sibling;
    reject(Error('late'));
    await tick();
    assert.equal(f.acquisitions, 0);
  } finally {
    f.close();
  }
  const account = fixture({}, () => new Promise(() => {}));
  const pending = account.owner.recall({
    peer: { type: 'group', groupId: '123' },
    messageId: '42',
  });
  const check = assert.rejects(pending);
  account.lifetime.close();
  await check;
  assert.equal(account.acquisitions, 0);
  account.close();
});
test('native peer and ACK malformed structures cannot acquire or succeed', async () => {
  for (const resolved of [
    { chatType: 1, peerUid: '123' },
    { chatType: 2, peerUid: ' ' },
    {
      get chatType() {
        throw Error('getter');
      },
      peerUid: '123',
    },
  ]) {
    const f = fixture({}, async () => resolved as typeof peer);
    try {
      await assert.rejects(
        f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' }),
      );
      assert.equal(f.acquisitions, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture({
    recallMsg() {
      return Object.assign([], { result: 0 });
    },
  });
  try {
    await assert.rejects(
      f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' }),
      /Native operation rejected/,
    );
  } finally {
    f.close();
  }
});
test('closing pending native recall observes late failure without retry', async () => {
  let reject!: (value: unknown) => void;
  let calls = 0;
  const f = fixture({
    recallMsg() {
      calls++;
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    },
  });
  try {
    const pending = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    const check = assert.rejects(pending, /closed/);
    await tick();
    f.owner.close();
    await check;
    reject(Error('late native failure'));
    f.channel.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
    await tick();
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test('callback array length is captured without property getter execution', async () => {
  let reads = 0;
  const rows = new Proxy([update], {
    get(target, key, receiver) {
      if (key === 'length') {
        reads++;
        throw Error('must not read');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const f = fixture({
    recallMsg() {
      return { result: 0 };
    },
  });
  try {
    const p = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    await tick();
    f.channel.dispatch('Msg/onMsgInfoListUpdate', [rows]);
    await p;
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});
test('native peer mutation cannot change the captured conversation correlation', async () => {
  let settled = false;
  const f = fixture({
    recallMsg(selected) {
      selected.peerUid = '999';
      f.channel.dispatch('Msg/onMsgInfoListUpdate', [[{ ...update, peerUid: '999' }]]);
      return { result: 0 };
    },
  });
  try {
    const pending = f.owner.recall({ peer: { type: 'group', groupId: '123' }, messageId: '42' });
    pending.then(
      () => {
        settled = true;
      },
      () => {},
    );
    await tick();
    assert.equal(settled, false);
    f.channel.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
    await pending;
    assert.equal(settled, true);
  } finally {
    f.close();
  }
});
