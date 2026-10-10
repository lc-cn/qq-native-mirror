import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGroupRequests as createWithContext,
  type GroupRequestPort,
  type GroupRequestListener,
} from '../src/features/groups/group-requests.ts';
function createGroupRequests(
  session: { getGroupService(): GroupRequestPort },
  emit: (event: string, payload: unknown) => void,
) {
  return createWithContext({
    getGroupService: () => session.getGroupService(),
    emit,
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
  });
}

const notify = (type: number, seq = '123', status = 1) => ({
  seq,
  type,
  status,
  group: { groupCode: '456', groupName: 'name' },
  postscript: 'message',
});
function fixture() {
  let listener: GroupRequestListener | undefined;
  let result: unknown = { result: 0 };
  const calls: unknown[][] = [];
  const events: { event: string; payload: unknown }[] = [];
  const service = {
    addKernelGroupListener: (value: GroupRequestListener) => {
      listener = value;
      return 9;
    },
    removeKernelGroupListener: (id: unknown) => {
      calls.push(['remove', id]);
    },
    getSingleScreenNotifies: (...args: unknown[]) => {
      calls.push(['get', ...args]);
      return result;
    },
    operateSysNotify: (...args: unknown[]): unknown => {
      calls.push(['operate', ...args]);
      return undefined;
    },
  };
  const module = createGroupRequests({ getGroupService: () => service }, (event, payload) =>
    events.push({ event, payload }),
  );
  return {
    module,
    calls,
    events,
    service,
    result: (value: unknown) => {
      result = value;
    },
    page: (doubt: boolean, next: string, values: unknown[]) =>
      listener!.onGroupSingleScreenNotifies(doubt, next, values),
    update: (doubt: boolean, values: unknown[]) => listener!.onGroupNotifiesUpdated(doubt, values),
  };
}

test('group request pages await matching native events and preserve next cursor', async () => {
  const f = fixture();
  let resolved = false;
  const pending = f.module
    .invokeOperation('listGroupRequests', { options: { doubt: true, before: '10', limit: 3 } })
    .then((value) => {
      resolved = true;
      return value;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, [['get', true, '10', 3]]);
  f.page(false, '12', [notify(7)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  f.page(true, '20', [notify(1), notify(5, '124'), notify(7, '125'), notify(8, '126')]);
  const page = await pending;
  assert.ok(page);
  assert.equal(page.next, '20');
  assert.deepEqual(
    page.requests.map((request) => request.kind),
    ['invite', 'invite-approval', 'join'],
  );
  assert.ok(page.requests.every((request) => request.doubt));
  f.module.close();
  assert.deepEqual(f.calls.at(-1), ['remove', 9]);
});

test('only unhandled actionable types emit, with per-request deduplication', () => {
  const f = fixture();
  f.update(false, [
    notify(1),
    notify(5, '124'),
    notify(7, '125'),
    notify(7, '126', 2),
    notify(8, '127'),
  ]);
  f.update(false, [notify(1)]);
  assert.equal(f.events.length, 3);
  assert.ok(f.events.every((event) => event.event === 'request.group'));
  assert.equal(f.calls.length, 0, 'notifications never automatically approve');
  f.module.close();
  f.update(true, [notify(1)]);
  assert.equal(f.events.length, 3);
});

test('sparse notification pages reject as a whole and invalidate the uncorrelated query channel', async () => {
  const partial: unknown[] = [notify(1)];
  partial.length = 2;
  for (const values of [new Array(1), partial]) {
    const f = fixture();
    try {
      const pending = f.module.invokeOperation('listGroupRequests');
      const rejected = assert.rejects(pending, /Invalid native group notification/);
      await new Promise((resolve) => setImmediate(resolve));
      f.page(false, '', values);
      await rejected;
      assert.deepEqual(f.events, [], 'a rejected batch emits no partial applications');
      await assert.rejects(
        f.module.invokeOperation('listGroupRequests'),
        /query channel is invalid/,
      );
      assert.deepEqual(
        f.calls,
        [['get', false, '', 20]],
        'failure does not dispatch a later query',
      );
    } finally {
      f.module.close();
    }
  }
});

test('malformed unsolicited sparse updates emit nothing and do not poison deduplication', () => {
  const f = fixture(),
    partial: unknown[] = [notify(1)];
  partial.length = 2;
  try {
    f.update(false, partial);
    assert.deepEqual(f.events, []);
    f.update(false, [notify(1)]);
    assert.equal(f.events.length, 1, 'the valid notification remains deliverable');
  } finally {
    f.module.close();
  }
});

test('explicit accept and reject preserve native request type/doubt and reason defaults', async () => {
  const f = fixture();
  await f.module.invokeOperation('handleGroupRequest', {
    request: { groupId: '456', sequence: '123', type: 1, doubt: false },
    accept: true,
  });
  await f.module.invokeOperation('handleGroupRequest', {
    request: { groupId: '456', sequence: '124', type: 7, doubt: true },
    accept: false,
    reason: 'reason',
  });
  assert.deepEqual(f.calls, [
    [
      'operate',
      false,
      { operateType: 1, targetMsg: { seq: '123', type: 1, groupCode: '456', postscript: ' ' } },
    ],
    [
      'operate',
      true,
      {
        operateType: 2,
        targetMsg: { seq: '124', type: 7, groupCode: '456', postscript: 'reason' },
      },
    ],
  ]);
  const valid = { groupId: '456', sequence: '123', type: 1, doubt: false };
  for (const payload of [
    { request: { ...valid, type: 8 }, accept: true },
    { request: valid, accept: 'true' },
    { request: { ...valid, sequence: 'bad' }, accept: false },
    { request: valid, accept: true, reason: 1 },
  ])
    await assert.rejects(f.module.invokeOperation('handleGroupRequest', payload));
  assert.equal(f.calls.length, 2);
  f.service.operateSysNotify = () => ({ result: 5 });
  await assert.rejects(
    f.module.invokeOperation('handleGroupRequest', { request: valid, accept: true }),
    /failed/,
  );
  f.module.close();
});

test('list failures and closure reject; concurrent cursors serialize native requests', async () => {
  const f = fixture();
  const first = f.module.invokeOperation('listGroupRequests');
  const second = f.module.invokeOperation('listGroupRequests', { options: { before: '123' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  f.page(false, '123', []);
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls[1], ['get', false, '123', 20]);
  f.page(false, '', []);
  await second;
  f.result({ result: 5 });
  await assert.rejects(f.module.invokeOperation('listGroupRequests'), /failed/);
  f.module.close();
  const closing = fixture();
  const pending = closing.module.invokeOperation('listGroupRequests');
  await new Promise((resolve) => setImmediate(resolve));
  closing.module.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(f.module.invokeOperation('listGroupRequests'), /closed/);
});

test('timed-out pages invalidate queries; late callbacks cannot satisfy a later cursor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.module.invokeOperation('listGroupRequests');
  const rejected = assert.rejects(pending, /timed out.*recreate the Session/);
  await new Promise((resolve) => setImmediate(resolve));
  // A malformed unsolicited update does not reject or complete the list query.
  f.update(false, [{ ...notify(1), status: 'invalid' }]);
  t.mock.timers.tick(10001);
  await rejected;
  f.page(false, '200', [notify(1)]);
  await assert.rejects(
    f.module.invokeOperation('listGroupRequests', { options: { before: '200' } }),
    /query channel is invalid/,
  );
  assert.deepEqual(f.calls, [['get', false, '', 20]], 'no later native query is dispatched');
  f.module.close();
});

const handle = {
  request: { groupId: '456', sequence: '123', type: 1, doubt: false },
  accept: true,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const method of ['listGroupRequests', 'handleGroupRequest'] as const) {
  test(`${method} local close interrupts pending native invocation and observes late rejection`, async () => {
    let listener!: GroupRequestListener;
    let reject!: (error: Error) => void;
    const native = new Promise<never>((_, fail) => {
      reject = fail;
    });
    let calls = 0,
      removed = 0;
    const controller = new AbortController();
    const module = createWithContext({
      signal: controller.signal,
      awaitAlive: async (value) => value,
      emit() {},
      getGroupService: () => ({
        addKernelGroupListener(value) {
          listener = value;
          return 'opaque';
        },
        removeKernelGroupListener(id) {
          assert.equal(id, 'opaque');
          removed++;
        },
        getSingleScreenNotifies() {
          calls++;
          listener.onGroupSingleScreenNotifies(false, '', []);
          return native;
        },
        operateSysNotify() {
          calls++;
          return native;
        },
      }),
    });
    const pending = assert.rejects(
      module.invokeOperation(method, method === 'handleGroupRequest' ? handle : {}),
      /closed/,
    );
    await tick();
    module.close();
    await pending;
    assert.equal(controller.signal.aborted, false);
    reject(Error('late rejected'));
    await tick();
    assert.equal(calls, 1);
    assert.equal(removed, 1);
    module.close();
    assert.equal(removed, 1);
  });
  test(`${method} status getter closes owner and cannot report success`, async () => {
    let listener!: GroupRequestListener;
    let calls = 0;
    const result = {
      get result() {
        module.close();
        return 0;
      },
    };
    const module = createWithContext({
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
      emit() {},
      getGroupService: () => ({
        addKernelGroupListener(value) {
          listener = value;
          return 1;
        },
        removeKernelGroupListener() {},
        getSingleScreenNotifies() {
          calls++;
          listener.onGroupSingleScreenNotifies(false, '', []);
          return result;
        },
        operateSysNotify() {
          calls++;
          return result;
        },
      }),
    });
    await assert.rejects(
      module.invokeOperation(method, method === 'handleGroupRequest' ? handle : {}),
      /closed/,
    );
    assert.equal(calls, 1);
  });
}
for (const stage of ['service', 'add-getter', 'registration'] as const) {
  test(`synchronous abort during ${stage} never exposes a live owner and removes acquired ID once`, () => {
    const controller = new AbortController(),
      reason = Error('fixture aborted');
    let adds = 0,
      removes = 0;
    const service: GroupRequestPort = {
      get addKernelGroupListener() {
        if (stage === 'add-getter') controller.abort(reason);
        return function (this: GroupRequestPort) {
          assert.equal(this, service);
          adds++;
          if (stage === 'registration') controller.abort(reason);
          return 11;
        };
      },
      removeKernelGroupListener(id) {
        assert.equal(this, service);
        assert.equal(id, 11);
        removes++;
      },
    };
    assert.throws(
      () =>
        createWithContext({
          signal: controller.signal,
          awaitAlive: async (value) => value,
          emit() {},
          getGroupService() {
            if (stage === 'service') controller.abort(reason);
            return service;
          },
        }),
      (error) => error === reason,
    );
    assert.equal(adds, stage === 'registration' ? 1 : 0);
    assert.equal(removes, stage === 'registration' ? 1 : 0);
  });
}
for (const method of ['getSingleScreenNotifies', 'operateSysNotify'] as const) {
  test(`${method} method getter captured once; close in getter prevents dispatch`, async () => {
    let calls = 0,
      reads = 0;
    const service: GroupRequestPort = {
      addKernelGroupListener() {
        return 1;
      },
      removeKernelGroupListener() {},
    };
    Object.defineProperty(service, method, {
      get() {
        reads++;
        module.close();
        return function () {
          calls++;
        };
      },
    });
    const module = createWithContext({
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
      emit() {},
      getGroupService: () => service,
    });
    await assert.rejects(
      module.invokeOperation(
        method === 'getSingleScreenNotifies' ? 'listGroupRequests' : 'handleGroupRequest',
        method === 'operateSysNotify' ? handle : {},
      ),
      /closed/,
    );
    assert.equal(calls, 0);
    assert.equal(reads, 1);
  });
}
test('observer close stops remaining events and removes listener only once', () => {
  let listener!: GroupRequestListener;
  const events: unknown[] = [],
    removed: unknown[] = [];
  const module = createWithContext({
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
    getGroupService: () => ({
      addKernelGroupListener(value) {
        listener = value;
        return 5;
      },
      removeKernelGroupListener(id) {
        removed.push(id);
      },
    }),
    emit(_event, value) {
      events.push(value);
      module.close();
    },
  });
  listener.onGroupNotifiesUpdated(false, [notify(1, '1'), notify(1, '2')]);
  listener.onGroupNotifiesUpdated(false, [notify(1, '3')]);
  assert.equal(events.length, 1);
  assert.deepEqual(removed, [5]);
});
test('cleanup throws once with original identity but pending list still settles and later callbacks stay inert', async () => {
  let listener!: GroupRequestListener;
  const error = Error('cleanup failed');
  let removed = 0;
  const module = createWithContext({
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
    emit() {
      assert.fail('late event');
    },
    getGroupService: () => ({
      addKernelGroupListener(value) {
        listener = value;
        return 1;
      },
      removeKernelGroupListener() {
        removed++;
        throw error;
      },
      getSingleScreenNotifies() {
        return new Promise(() => {});
      },
    }),
  });
  const pending = assert.rejects(module.invokeOperation('listGroupRequests'), /closed/);
  await tick();
  assert.throws(
    () => module.close(),
    (value) => value === error,
  );
  await pending;
  module.close();
  listener.onGroupSingleScreenNotifies(false, '', []);
  assert.equal(removed, 1);
});
test('queued requests snapshot options once and closed queue cannot dispatch another cursor', async () => {
  const f = fixture();
  let optionReads = 0,
    beforeReads = 0;
  const options = {
    get before() {
      beforeReads++;
      return '100';
    },
  };
  const first = f.module.invokeOperation('listGroupRequests');
  const pending = assert.rejects(
    f.module.invokeOperation('listGroupRequests', {
      get options() {
        optionReads++;
        return options;
      },
    }),
    /closed/,
  );
  await tick();
  f.page(false, '', []);
  await first;
  f.module.close();
  await pending;
  assert.equal(optionReads, 1);
  assert.equal(beforeReads, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'get').length, 1);
});
test('approval captures request/reason/accept once and keeps exact service receiver', async () => {
  let requestReads = 0,
    reasonReads = 0,
    acceptReads = 0,
    methodReads = 0;
  const calls: unknown[][] = [];
  const service: GroupRequestPort = {
    addKernelGroupListener() {
      return 9;
    },
    removeKernelGroupListener() {},
    get operateSysNotify() {
      methodReads++;
      return function (this: GroupRequestPort, ...args: unknown[]) {
        assert.equal(this, service);
        calls.push(args);
      };
    },
  };
  const module = createWithContext({
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
    emit() {},
    getGroupService: () => service,
  });
  await module.invokeOperation('handleGroupRequest', {
    get request() {
      requestReads++;
      return handle.request;
    },
    get reason() {
      reasonReads++;
      return reasonReads > 1 ? 'mutated' : 'captured';
    },
    get accept() {
      acceptReads++;
      return true;
    },
  });
  assert.deepEqual(calls, [
    [
      false,
      {
        operateType: 1,
        targetMsg: { seq: '123', type: 1, groupCode: '456', postscript: 'captured' },
      },
    ],
  ]);
  assert.deepEqual([requestReads, reasonReads, acceptReads, methodReads], [1, 1, 1, 1]);
  module.close();
});

for (const name of ['getSingleScreenNotifies', 'operateSysNotify'] as const) {
  test(`${name} missing method preserves fixed failure and native throw identity`, async () => {
    const service: GroupRequestPort = {
      addKernelGroupListener() {
        return 1;
      },
      removeKernelGroupListener() {},
    };
    const module = createWithContext({
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
      emit() {},
      getGroupService: () => service,
    });
    const operation = name === 'operateSysNotify' ? 'handleGroupRequest' : 'listGroupRequests';
    await assert.rejects(
      module.invokeOperation(operation, operation === 'handleGroupRequest' ? handle : {}),
      { message: `Native Group service is missing ${name}` },
    );
    module.close();
    const original = { opaque: true };
    service[name] = () => {
      throw original;
    };
    const next = createWithContext({
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
      emit() {},
      getGroupService: () => service,
    });
    await assert.rejects(
      next.invokeOperation(operation, operation === 'handleGroupRequest' ? handle : {}),
      (error) => error === original,
    );
    next.close();
  });
}
test('listener removal never-settling return does not block pending operation cancellation', async () => {
  let removes = 0;
  const module = createWithContext({
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
    emit() {},
    getGroupService: () => ({
      addKernelGroupListener() {
        return 1;
      },
      removeKernelGroupListener() {
        removes++;
        return new Promise(() => {});
      },
      operateSysNotify() {
        return new Promise(() => {});
      },
    }),
  });
  const pending = assert.rejects(module.invokeOperation('handleGroupRequest', handle), /closed/);
  module.close();
  await pending;
  module.close();
  assert.equal(removes, 1);
});
