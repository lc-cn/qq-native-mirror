import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AccountSessionLifecycle,
  type AccountSessionContext,
  type AccountSessionServices,
} from '../src/runtime/account-session-lifecycle.ts';
import type { NativeObject } from '../src/native/native-object.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(overrides: Partial<AccountSessionContext> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-session-owner-'));
  const initialized = deferred<void>();
  const starting = deferred<void>();
  const callbacks: { session?: NativeObject; depends?: NativeObject; dispatcher?: NativeObject } =
    {};
  const calls: string[] = [];
  const errors: Error[] = [];
  const cleanupErrors: unknown[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const ready: unknown[] = [];
  let current = true;
  let pending = true;
  const services: AccountSessionServices = {
    async invokeOperation(method, payload) {
      calls.push(method);
      return payload;
    },
    close() {
      calls.push('service-close');
    },
  };
  const context: AccountSessionContext = {
    session: {
      init(
        _config: unknown,
        depends: NativeObject,
        dispatcher: NativeObject,
        listener: NativeObject,
      ) {
        calls.push('init');
        callbacks.session = listener;
        callbacks.depends = depends;
        callbacks.dispatcher = dispatcher;
        initialized.resolve();
      },
    },
    account: { uin: '123', uid: 'u_fixture' },
    options: { dataDir, version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' } },
    machineGuid: () => '0123456789abcdef0123456789abcdef',
    startNative: () => {
      calls.push('start');
      starting.resolve();
    },
    isCurrent: () => current,
    isPending: () => pending,
    depends: {
      onMSFStatusChange: (...args: unknown[]) => events.push({ event: 'msf', payload: args }),
    },
    createServices: () => {
      calls.push('compose');
      return services;
    },
    emit: (event, payload) => events.push({ event, payload }),
    ready: (account) => {
      ready.push(account);
      pending = false;
    },
    failed: (error) => {
      errors.push(error);
      current = false;
      owner.close();
    },
    cleanupFailed: (error) => cleanupErrors.push(error),
    ...overrides,
  };
  const owner = new AccountSessionLifecycle(context);
  return {
    owner,
    context,
    callbacks,
    calls,
    errors,
    cleanupErrors,
    events,
    ready,
    initialized: initialized.promise,
    starting: starting.promise,
    invalidate: () => {
      current = false;
    },
    async dispose() {
      owner.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('readiness is independent of successful start and acquisition happens exactly once', async () => {
  const start = deferred<void>();
  const f = await fixture({ startNative: () => start.promise });
  try {
    f.owner.begin();
    f.owner.begin();
    await f.initialized;
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    assert.deepEqual(f.ready, []);
    assert.deepEqual(f.calls, ['init']);
    await assert.rejects(f.owner.invokeOperation('listFriends', {}), /not online/);
    start.resolve();
    await flush();
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    f.owner.begin();
    assert.deepEqual(f.ready, [{ uin: '123', uid: 'u_fixture' }]);
    assert.deepEqual(f.calls, ['init', 'compose']);
    assert.deepEqual(await f.owner.invokeOperation('listFriends', { limit: 1 }), { limit: 1 });
  } finally {
    await f.dispose();
  }
});

for (const completion of ['throw', 'reject'] as const)
  test(`early native readiness cannot mask start ${completion}`, async () => {
    const failure = Object.assign(new Error('native start failed'), { code: -7101 });
    let listener: NativeObject = {};
    const actual = await fixture({
      session: {
        init(_config: unknown, _depends: unknown, _dispatcher: unknown, value: NativeObject) {
          listener = value;
        },
      },
      startNative: () => {
        listener.onOpentelemetryInit({ is_init: true });
        if (completion === 'throw') throw failure;
        return Promise.reject(failure);
      },
    });
    try {
      actual.owner.begin();
      while (actual.errors.length === 0) await flush();
      assert.equal(actual.errors[0], failure);
      assert.deepEqual(actual.ready, []);
      assert.deepEqual(actual.calls, []);
    } finally {
      await actual.dispose();
    }
  });

test('late start rejection after close is observed without publishing failure or readiness', async () => {
  const start = deferred<void>();
  const f = await fixture({ startNative: () => start.promise });
  try {
    f.owner.begin();
    await f.initialized;
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    f.owner.close();
    start.reject(new Error('late native failure'));
    await flush();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.ready, []);
    assert.deepEqual(f.calls, ['init']);
  } finally {
    await f.dispose();
  }
});

test('closing before directory preparation completes prevents init and start', async () => {
  const f = await fixture();
  try {
    f.owner.begin();
    f.owner.close();
    await flush();
    await flush();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.ready, []);
  } finally {
    await f.dispose();
  }
});

for (const cancel of ['close', 'generation'] as const)
  test(`${cancel} scopes retained Session, Depends, Dispatcher and business callbacks`, async () => {
    let business!: (event: string, payload: unknown) => void;
    let audit!: (info: { family: string; name: string; argumentTypes: string[] }) => void;
    const f = await fixture({
      createServices: (context) => {
        business = context.events.emit;
        audit = context.auditCallback!;
        return { async invokeOperation() {}, close() {} };
      },
    });
    try {
      f.owner.begin();
      await f.starting;
      await flush();
      f.callbacks.session!.onOpentelemetryInit({ is_init: true });
      assert.equal(f.ready.length, 1);
      f.callbacks.depends!.onMSFStatusChange(2, 1);
      assert.equal(f.events.at(-1)?.event, 'msf');
      const count = f.events.length;
      if (cancel === 'close') f.owner.close();
      else f.invalidate();
      f.callbacks.depends!.onMSFStatusChange(1, 2);
      f.callbacks.dispatcher!.unknownCallback({ ticket: 'synthetic-secret' });
      f.callbacks.session!.onOpentelemetryInit({ is_init: false });
      business('message', { id: 'late' });
      audit({ family: 'Msg', name: 'late', argumentTypes: ['object'] });
      assert.equal(f.events.length, count);
      assert.equal(f.ready.length, 1);
      assert.deepEqual(f.errors, []);
      await assert.rejects(f.owner.invokeOperation('listFriends', {}), /not online/);
    } finally {
      await f.dispose();
    }
  });

test('service construction reentrancy releases a late acquisition once and retains cleanup failure', async () => {
  const failure = Object.assign(new Error('late release failed'), { code: 77 });
  let closes = 0;
  const f = await fixture({
    createServices: () => {
      f.owner.close();
      return {
        async invokeOperation() {},
        close() {
          closes++;
          throw failure;
        },
      };
    },
  });
  try {
    f.owner.begin();
    await f.starting;
    await flush();
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    f.owner.close();
    assert.equal(closes, 1);
    assert.deepEqual(f.cleanupErrors, [failure]);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.ready, []);
  } finally {
    await f.dispose();
  }
});

test('reentrant readiness while composing cannot construct a second business adapter', async () => {
  let constructions = 0;
  const f = await fixture({
    createServices: () => {
      constructions++;
      f.callbacks.session!.onOpentelemetryInit({ is_init: true });
      return { async invokeOperation() {}, close() {} };
    },
  });
  try {
    f.owner.begin();
    await f.starting;
    await flush();
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    assert.equal(constructions, 1);
    assert.equal(f.ready.length, 1);
  } finally {
    await f.dispose();
  }
});

test('close detaches service before fallible reentrant cleanup and preserves error identity', async () => {
  const failure = Object.assign(new Error('native removal failed'), { code: 78 });
  let closes = 0;
  const f = await fixture({
    createServices: () => ({
      async invokeOperation() {},
      close() {
        closes++;
        f.owner.close();
        throw failure;
      },
    }),
  });
  try {
    f.owner.begin();
    await f.starting;
    await flush();
    f.callbacks.session!.onOpentelemetryInit({ is_init: true });
    assert.throws(
      () => f.owner.close(),
      (error) => error === failure,
    );
    f.owner.close();
    assert.equal(closes, 1);
    await assert.rejects(f.owner.invokeOperation('listFriends', {}), /not online/);
  } finally {
    await f.dispose();
  }
});

for (const failureAt of ['start', 'compose']) {
  test(`opaque ${failureAt} failure settles the Session without coercion or replay`, async () => {
    let projections = 0;
    let dispatches = 0;
    const opaque = {
      toString() {
        projections++;
        throw Error('private');
      },
    };
    const f = await fixture({
      ...(failureAt === 'start'
        ? {
            startNative() {
              dispatches++;
              throw opaque;
            },
          }
        : {
            createServices() {
              dispatches++;
              throw opaque;
            },
          }),
    });
    try {
      f.owner.begin();
      await f.initialized;
      f.callbacks.session!.onOpentelemetryInit({ is_init: true });
      await flush();
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0]!.message, 'Kernel request failed');
      assert.equal(projections, 0);
      assert.equal(dispatches, 1);
      assert.equal(f.ready.length, 0);
      f.owner.begin();
      await flush();
      assert.equal(dispatches, 1);
      assert.equal(f.errors.length, 1);
    } finally {
      await f.dispose();
    }
  });
}
