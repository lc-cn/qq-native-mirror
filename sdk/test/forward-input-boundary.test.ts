import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createForwardMessages } from '../src/features/forward/forward-messages.ts';
const source = () => ({ type: 'private', userId: '00123' });
const destination = () => ({ type: 'group', groupId: '000456' });
function fixture() {
  const controller = new AbortController(),
    calls: unknown[][] = [],
    resolutions: unknown[] = [];
  const service = {
    forwardMsg(...args: unknown[]) {
      assert.equal(this, service);
      calls.push(args);
      return { result: 0 };
    },
  };
  const owner = createForwardMessages({
    signal: controller.signal,
    awaitAlive: async (value) => value,
    getMessageService: () => service,
    resolvePeer: async (peer) => {
      resolutions.push(peer);
      return {
        chatType: peer.type === 'private' ? 1 : 2,
        peerUid: peer.type === 'private' ? peer.userId : peer.groupId,
      };
    },
    decodeMessage: () => undefined,
  });
  return { owner, calls, resolutions };
}
function hide(input: unknown[], replacement: unknown[]) {
  let reads = 0;
  Object.defineProperty(input, Symbol.iterator, {
    value() {
      reads++;
      return replacement[Symbol.iterator]();
    },
  });
  return () => reads;
}
function invalidArrays() {
  let reads = 0;
  const accessor = Object.defineProperty(new Array(1), '0', {
    get() {
      reads++;
      return '42';
    },
  });
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, {
    0: '42',
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  });
  const hidden = ['42', null];
  hide(hidden, ['42']);
  return { arrays: [accessor, inherited, new Array(1), hidden], reads: () => reads };
}
test('forward invalid ID own slots cannot resolve or dispatch, including iterator-hidden invalid later slot', async () => {
  const inputs = invalidArrays();
  for (const messageIds of inputs.arrays) {
    const f = fixture();
    try {
      await assert.rejects(
        f.owner.invokeOperation('forwardMessages', {
          source: source(),
          destination: destination(),
          messageIds,
        }),
      );
      assert.equal(f.resolutions.length, 0);
      assert.equal(f.calls.length, 0);
    } finally {
      f.owner.close();
    }
  }
  assert.equal(inputs.reads(), 0);
});
class Worker extends ChildProcess {
  override connected = true;
  override exitCode: number | null = null;
  requests: Record<string, unknown>[] = [];
  constructor() {
    super();
    this.connected = true;
  }
  override send: ChildProcess['send'] = (value: unknown, ...args: unknown[]) => {
    assert.ok(value && typeof value === 'object');
    const request = value as Record<string, unknown>;
    this.requests.push(request);
    const callback = args.find((arg) => typeof arg === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    queueMicrotask(() => {
      this.emit('message', { id: request.id, result: undefined });
      if (request.method === 'close') {
        this.exitCode = 0;
        this.connected = false;
        this.emit('exit', 0, null);
      }
    });
    return true;
  };
  override kill() {
    this.exitCode = 0;
    this.connected = false;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}
test('public forward invalid IDs reject before IPC', async () => {
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  try {
    for (const ids of invalidArrays().arrays) {
      await assert.rejects(async () =>
        Reflect.apply(client.forwardMessages, client, [source(), destination(), ids]),
      );
      assert.equal(worker.requests.length, 0);
    }
  } finally {
    await client.close();
  }
});
test('forward legal ID iterator is ignored, duplicates and over100 retain old policy', async () => {
  const f = fixture(),
    ids = Array.from({ length: 101 }, () => '00042'),
    reads = hide(ids, ['99']);
  try {
    await f.owner.invokeOperation('forwardMessages', {
      source: source(),
      destination: destination(),
      messageIds: ids,
    });
    assert.deepEqual(
      f.calls[0]?.[0],
      ids.map(() => '00042'),
    );
    assert.equal(reads(), 0);
  } finally {
    f.owner.close();
  }
});
test('forward payload and applicable peer getters remain accepted and captured once', async () => {
  const f = fixture(),
    counts = new Map<string, number>();
  const get =
    <T>(key: string, value: T) =>
    () => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return value;
    };
  const from = {
    get type() {
      return get('type', 'private')();
    },
    get userId() {
      return get('userId', '00123')();
    },
  };
  const payload = {
    get source() {
      return get('source', from)();
    },
    get destination() {
      return get('destination', destination())();
    },
    get messageIds() {
      return get('messageIds', ['00042'])();
    },
  };
  try {
    await f.owner.invokeOperation('forwardMessages', payload);
    assert.deepEqual([...counts.values()], [1, 1, 1, 1, 1]);
    assert.deepEqual(f.resolutions[0], { type: 'private', userId: '00123' });
  } finally {
    f.owner.close();
  }
});
test('forward class and null-prototype own peer fields remain legal', async () => {
  class PrivatePeer {
    type = 'private';
    userId = '00123';
  }
  const f = fixture(),
    to = Object.assign(Object.create(null) as Record<string, unknown>, destination());
  try {
    await f.owner.invokeOperation('forwardMessages', {
      source: new PrivatePeer(),
      destination: to,
      messageIds: ['00042', '00042'],
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]?.[0], ['00042', '00042']);
  } finally {
    f.owner.close();
  }
});
