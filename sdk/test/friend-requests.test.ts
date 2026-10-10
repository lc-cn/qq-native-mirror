import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFriendRequests as createWithContext,
  type FriendBuddyPort,
  type FriendBuddyListener,
} from '../src/features/contacts/friend-requests.ts';
function createFriendRequests(
  session: { getBuddyService(): FriendBuddyPort },
  emit: (event: string, payload: unknown) => void,
) {
  return createWithContext({
    getBuddyService: session.getBuddyService,
    emit,
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
  });
}
const incoming = {
  friendUid: 'u_request',
  reqTime: '123',
  friendNick: 'nick',
  extWords: 'hello',
  isDecide: false,
  isUnread: true,
};
test('friend metadata shares the Buddy listener without completing or invalidating request queries', async () => {
  let listener: any,
    registrations = 0,
    queries = 0;
  const removed: unknown[] = [],
    events: [string, any][] = [];
  const operations = createFriendRequests(
    {
      getBuddyService: () => ({
        addKernelBuddyListener(value: any) {
          registrations++;
          listener = value;
          return 7;
        },
        removeKernelBuddyListener(id: unknown) {
          removed.push(id);
        },
        getBuddyReq() {
          queries++;
          return { result: 0 };
        },
      }),
    },
    (name, value) => events.push([name, value]),
  );
  try {
    let resolved = false;
    const query = operations.invokeOperation('listFriendRequests').then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    listener.onBuddyListChange([
      { categoryId: 0, categoryName: '', categoryMbCount: 0, buddyList: [] },
    ]);
    listener.onBuddyListChange([{ categoryId: 0, buddyList: [] }]);
    listener.onBuddyListChangedV2({ credential: 'fixture-secret' });
    listener.onBuddyInfoChange({ credential: 'fixture-secret' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    listener.onBuddyReqChange({ buddyReqs: [incoming] });
    assert.equal(((await query) as any[]).length, 1);
    assert.deepEqual(
      events.map(([name]) => name),
      ['friend-list-updated', 'diagnostic', 'friend-request'],
    );
    assert.equal(registrations, 1);
    assert.equal(queries, 1);
    operations.close();
    listener.onBuddyListChange([]);
    listener.onBuddyReqChange({ buddyReqs: [{ ...incoming, reqTime: '124' }] });
    assert.equal(events.length, 3);
    assert.deepEqual(removed, [7]);
    assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
  } finally {
    operations.close();
  }
});
function fixture() {
  let listener: any;
  const emitted: { event: string; payload: any }[] = [];
  const calls: any[] = [];
  let result: unknown = { result: 0 };
  const service = {
    addKernelBuddyListener: (value: any) => {
      listener = value;
      return 7;
    },
    removeKernelBuddyListener: (id: unknown) => {
      calls.push(['remove', id]);
    },
    getBuddyReq: () => {
      calls.push(['get']);
      return result;
    },
    approvalFriendRequest: (value: unknown) => {
      calls.push(['approve', value]);
      return undefined;
    },
  };
  const operations = createFriendRequests({ getBuddyService: () => service }, (event, payload) =>
    emitted.push({ event, payload }),
  );
  return {
    operations,
    emitted,
    calls,
    service,
    notify: (requests: unknown[]) =>
      listener.onBuddyReqChange({ unreadNums: 1, buddyReqs: requests }),
    result: (value: unknown) => {
      result = value;
    },
  };
}

test('lists wait for actual native notification and coalesce concurrent callers', async () => {
  const f = fixture();
  let resolved = false;
  const first = f.operations.invokeOperation('listFriendRequests').then((value) => {
    resolved = true;
    return value;
  });
  const second = f.operations.invokeOperation('listFriendRequests');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, 'native call success alone is insufficient');
  assert.deepEqual(f.calls, [['get']]);
  f.notify([incoming]);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [
    {
      uid: 'u_request',
      time: '123',
      nickname: 'nick',
      message: 'hello',
      decided: false,
      unread: true,
      initiator: false,
      raw: incoming,
    },
  ]);
  f.operations.close();
  assert.deepEqual(f.calls.at(-1), ['remove', 7]);
});

test('only undecided incoming notifications emit, deduplicated by UID and time', () => {
  const f = fixture();
  f.notify([
    incoming,
    { ...incoming, friendUid: 'u_decided', isDecide: true },
    { ...incoming, friendUid: 'u_outgoing', isInitiator: true },
  ]);
  f.notify([incoming]);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].event, 'friend-request');
  assert.ok(!f.calls.some((call) => call[0] === 'approve'), 'never auto-approves');
  f.operations.close();
  f.notify([{ ...incoming, reqTime: '124' }]);
  assert.equal(f.emitted.length, 1);
});

test('explicit approval/rejection validates native payload and handles void dispatch', async () => {
  const f = fixture();
  await f.operations.invokeOperation('handleFriendRequest', {
    request: { uid: 'u_request', time: '123' },
    accept: false,
  });
  assert.deepEqual(f.calls, [
    ['approve', { friendUid: 'u_request', reqTime: '123', accept: false }],
  ]);
  for (const payload of [
    {},
    { request: { uid: '', time: '123' }, accept: true },
    { request: { uid: 'u', time: 'bad' }, accept: false },
    { request: { uid: 'u', time: '123' }, accept: 1 },
  ]) {
    await assert.rejects(f.operations.invokeOperation('handleFriendRequest', payload));
  }
  assert.equal(f.calls.length, 1);
  f.service.approvalFriendRequest = () => ({ result: 5 }) as any;
  await assert.rejects(
    f.operations.invokeOperation('handleFriendRequest', {
      request: { uid: 'u', time: '123' },
      accept: true,
    }),
    /failed/,
  );
  f.operations.close();
});

test('list errors, invalid notifications and shutdown reject rather than fabricate empty lists', async () => {
  const failed = fixture();
  failed.result({ result: 5 });
  await assert.rejects(failed.operations.invokeOperation('listFriendRequests'), /failed/);
  failed.operations.close();
  const invalid = fixture();
  const invalidList = invalid.operations.invokeOperation('listFriendRequests');
  invalid.notify([{ ...incoming, isDecide: 'false' }]);
  await assert.rejects(invalidList, /flags/);
  invalid.operations.close();
  const closing = fixture();
  const pending = closing.operations.invokeOperation('listFriendRequests');
  closing.operations.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(closing.operations.invokeOperation('listFriendRequests'), /closed/);
});

test('timed-out friend queries reject later lists before dispatch; unsolicited events still arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const pending = f.operations.invokeOperation('listFriendRequests');
    const rejected = assert.rejects(pending, /timed out/);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10_001);
    await rejected;
    const nextRejected = assert.rejects(
      f.operations.invokeOperation('listFriendRequests'),
      /query channel is invalid.*recreate the Session/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    // This can be the first query's late callback; it cannot identify a new query.
    f.notify([incoming]);
    await nextRejected;
    assert.deepEqual(f.calls, [['get']], 'no uncorrelatable later query is dispatched');
    assert.equal(f.emitted.length, 1, 'unsolicited requests remain observable');
  } finally {
    f.operations.close();
  }
});

test('native friend query failure overrides early notification and invalidates only listing', async () => {
  const f = fixture();
  try {
    f.service.getBuddyReq = () => {
      f.calls.push(['get']);
      f.notify([incoming]);
      return { result: 73 };
    };
    await assert.rejects(
      f.operations.invokeOperation('listFriendRequests'),
      (error) => (error as any).code === 73,
    );
    await assert.rejects(
      f.operations.invokeOperation('listFriendRequests'),
      /query channel is invalid/,
    );
    await f.operations.invokeOperation('handleFriendRequest', {
      request: { uid: 'u_request', time: '123' },
      accept: false,
    });
    assert.deepEqual(f.calls, [
      ['get'],
      ['approve', { friendUid: 'u_request', reqTime: '123', accept: false }],
    ]);
  } finally {
    f.operations.close();
  }
});

for (const stage of ['service', 'registration', 'method'] as const) {
  test(`synchronous abort at ${stage} prevents approval and removes completed registration once`, async () => {
    const controller = new AbortController();
    const reason = new Error('fixture closed');
    let calls = 0;
    const removed: unknown[] = [];
    const service: FriendBuddyPort = {
      addKernelBuddyListener() {
        assert.equal(this, service);
        if (stage === 'registration') controller.abort(reason);
        return 73;
      },
      removeKernelBuddyListener(id) {
        assert.equal(this, service);
        removed.push(id);
      },
      get approvalFriendRequest() {
        if (stage === 'method') controller.abort(reason);
        return () => {
          calls++;
        };
      },
    };
    const factory = () =>
      createWithContext({
        signal: controller.signal,
        getBuddyService() {
          if (stage === 'service') controller.abort(reason);
          return service;
        },
        emit() {
          assert.fail('no events');
        },
        awaitAlive: async (value) => value,
      });
    if (stage !== 'method') assert.throws(factory, (error) => error === reason);
    else {
      const operations = factory();
      await assert.rejects(
        operations.invokeOperation('handleFriendRequest', {
          request: { uid: 'u_fixture', time: '123' },
          accept: true,
        }),
        (error) => error === reason,
      );
      operations.close();
    }
    assert.equal(calls, 0);
    assert.deepEqual(removed, stage === 'service' ? [] : [73]);
  });
}

test('approval pending at close rejects and observes late native failure without retry', async () => {
  const controller = new AbortController();
  let fail!: (error: unknown) => void;
  let calls = 0;
  const response = new Promise<unknown>((_, reject) => {
    fail = reject;
  });
  const service: FriendBuddyPort = {
    addKernelBuddyListener: () => 7,
    approvalFriendRequest(request) {
      assert.equal(this, service);
      assert.deepEqual(request, { friendUid: 'u_fixture', reqTime: '123', accept: false });
      calls++;
      return response;
    },
  };
  const operations = createWithContext({
    signal: controller.signal,
    getBuddyService: () => service,
    emit() {},
    awaitAlive(value) {
      return Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
      ]);
    },
  });
  const pending = operations.invokeOperation('handleFriendRequest', {
    request: { uid: 'u_fixture', time: '123' },
    accept: false,
  });
  operations.close();
  await assert.rejects(pending, /closed/);
  fail(new Error('late native failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  operations.close();
});

test('sparse notification rejects whole batch before any event or successful list', async () => {
  let listener!: FriendBuddyListener;
  const events: string[] = [];
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener(value) {
        listener = value as typeof listener;
        return 1;
      },
      getBuddyReq: () => ({ result: 0 }),
    }),
    emit: (event) => events.push(event),
    awaitAlive: async (value) => value,
  });
  try {
    const pending = operations.invokeOperation('listFriendRequests');
    const rejected = assert.rejects(pending, /Invalid native friend request/);
    const rows = [incoming];
    rows.length = 3;
    rows[2] = incoming;
    listener.onBuddyReqChange({ buddyReqs: rows });
    await rejected;
    assert.deepEqual(events, []);
  } finally {
    operations.close();
  }
});

test('approval captures request and accept once before native dispatch', async () => {
  let requestReads = 0,
    acceptReads = 0,
    calls = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener: () => 1,
      approvalFriendRequest(value) {
        calls++;
        assert.deepEqual(value, { friendUid: 'u_fixture', reqTime: '123', accept: true });
      },
    }),
    emit() {},
    awaitAlive: async (value) => value,
  });
  try {
    await operations.invokeOperation('handleFriendRequest', {
      get request() {
        requestReads++;
        return { uid: 'u_fixture', time: '123' };
      },
      get accept() {
        return ++acceptReads === 1 ? true : 'invalid';
      },
    });
    assert.equal(requestReads, 1);
    assert.equal(acceptReads, 1);
    assert.equal(calls, 1);
  } finally {
    operations.close();
  }
});

test('event observer reentrant close stops the remaining batch and removes listener once', () => {
  let listener!: FriendBuddyListener;
  let events = 0,
    removed = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener(value) {
        listener = value as typeof listener;
        return 9;
      },
      removeKernelBuddyListener(id) {
        assert.equal(id, 9);
        removed++;
      },
    }),
    emit() {
      events++;
      operations.close();
    },
    awaitAlive: async (value) => value,
  });
  listener.onBuddyReqChange({ buddyReqs: [incoming, { ...incoming, reqTime: '124' }] });
  listener.onBuddyReqChange({ buddyReqs: [incoming] });
  operations.close();
  assert.equal(events, 1);
  assert.equal(removed, 1);
});

test('native ack getter retiring module cannot publish early notification to any joined caller', async () => {
  let listener!: { onBuddyReqChange(value: unknown): void };
  let queries = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener(value) {
        listener = value as typeof listener;
        return 1;
      },
      getBuddyReq() {
        queries++;
        listener.onBuddyReqChange({ buddyReqs: [incoming] });
        return {
          get result() {
            operations.close();
            return 0;
          },
        };
      },
    }),
    emit() {},
    awaitAlive: async (value) => value,
  });
  const first = operations.invokeOperation('listFriendRequests');
  const joined = operations.invokeOperation('listFriendRequests');
  await Promise.all([assert.rejects(first, /closed/), assert.rejects(joined, /closed/)]);
  assert.equal(queries, 1);
});

test('approval result getter retirement rejects after a single dispatch', async () => {
  let calls = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener: () => 1,
      approvalFriendRequest() {
        calls++;
        return {
          get result() {
            operations.close();
            return 0;
          },
        };
      },
    }),
    emit() {},
    awaitAlive: async (value) => value,
  });
  await assert.rejects(
    operations.invokeOperation('handleFriendRequest', {
      request: { uid: 'u_fixture', time: '123' },
      accept: true,
    }),
    /closed/,
  );
  assert.equal(calls, 1);
});

test('completed approvals release per-wait cancellation listeners in a long-lived module', async () => {
  const originalAdd = AbortSignal.prototype.addEventListener;
  const originalRemove = AbortSignal.prototype.removeEventListener;
  const active = new Map<AbortSignal, Set<EventListenerOrEventListenerObject>>();
  AbortSignal.prototype.addEventListener = function (
    this: AbortSignal,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'abort' && listener) {
      const listeners = active.get(this) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      active.set(this, listeners);
    }
    return originalAdd.call(this, type, listener, options);
  };
  AbortSignal.prototype.removeEventListener = function (
    this: AbortSignal,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    if (type === 'abort' && listener) active.get(this)?.delete(listener);
    return originalRemove.call(this, type, listener, options);
  };
  let operations: ReturnType<typeof createWithContext> | undefined;
  const count = () => [...active.values()].reduce((sum, set) => sum + set.size, 0);
  try {
    operations = createWithContext({
      signal: new AbortController().signal,
      getBuddyService: () => ({ addKernelBuddyListener: () => 1, approvalFriendRequest() {} }),
      emit() {},
      awaitAlive: async (value) => value,
    });
    for (let index = 0; index < 100; index++) {
      await operations.invokeOperation('handleFriendRequest', {
        request: { uid: 'u_fixture', time: '123' },
        accept: true,
      });
      assert.equal(count(), 1, 'only the module parent lifetime handler remains');
    }
    operations.close();
    assert.equal(count(), 0);
  } finally {
    operations?.close();
    AbortSignal.prototype.addEventListener = originalAdd;
    AbortSignal.prototype.removeEventListener = originalRemove;
  }
});

test('approval synchronously closes then returns rejection which is observed', async () => {
  let calls = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      addKernelBuddyListener: () => 1,
      approvalFriendRequest() {
        calls++;
        operations.close();
        return Promise.reject(new Error('late native rejection'));
      },
    }),
    emit() {},
    awaitAlive: async (value) => value,
  });
  await assert.rejects(
    operations.invokeOperation('handleFriendRequest', {
      request: { uid: 'u_fixture', time: '123' },
      accept: true,
    }),
    /closed/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
