import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ClientLifecycle } from '../src/runtime/client-lifecycle.ts';
import { KernelRequestError } from '../src/errors.ts';
function workerFixture() {
  const events = new EventEmitter();
  const sent: { id: number; method: string }[] = [];
  const worker = Object.assign(events, {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send(message: { id: number; method: string }, callback: (error: Error | null) => void) {
      sent.push(message);
      callback(null);
      if (message.method === 'close' || message.method === 'init')
        queueMicrotask(() => {
          events.emit('message', {
            id: message.id,
            result: message.method === 'init' ? { exports: ['fixture-export'] } : null,
          });
          if (message.method === 'close')
            setImmediate(() => {
              worker.connected = false;
              worker.exitCode = 0;
              events.emit('exit', 0, null);
            });
        });
    },
    kill() {
      worker.exitCode = 0;
      events.emit('exit', 0, null);
      return true;
    },
  });
  return { worker: worker as unknown as ChildProcess, events, sent };
}
test('module coalesces login promises and owns account state before emitting raw ready', async () => {
  const f = workerFixture();
  const events: string[] = [];
  const lifecycle: ClientLifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, _payload) {
      events.push(event);
    },
    forward(event, payload) {
      events.push(event);
      if (event === 'ready') assert.deepEqual(lifecycle.account, payload);
    },
    exportsUpdated() {},
  });
  const first = lifecycle.login({ method: 'quick', uin: '123' });
  assert.equal(lifecycle.login({ method: 'quick', uin: '123' }), first);
  await assert.rejects(lifecycle.login({ method: 'quick', uin: '456' }), /different login/);
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await first;
  const snapshot = lifecycle.account!;
  Object.assign(snapshot, { uin: '999' });
  assert.equal(lifecycle.account?.uin, '123');
  assert.deepEqual(events.slice(0, 3), ['state', 'state', 'ready']);
  await lifecycle.close();
});
test('reconnect filters retired-generation events and updates exports without replaying requests', async () => {
  const old = workerFixture(),
    next = workerFixture();
  const exports: string[][] = [];
  const events: string[] = [];
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: { spawn: () => next.worker, payload: {} },
    emit: (event, _payload) => {
      events.push(event);
    },
    forward: (event) => events.push(event),
    exportsUpdated: (value) => exports.push(value),
  });
  const login = lifecycle.login();
  old.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
  old.events.emit('message', { id: old.sent[0].id, result: { uin: '123', uid: 'u_fixture' } });
  await login;
  const reconnect = lifecycle.reconnect();
  assert.equal(lifecycle.reconnect(), reconnect);
  await new Promise((resolve) => setImmediate(resolve));
  old.events.emit('message', { event: 'ready', payload: { uin: '999', uid: 'u_old' } });
  assert.equal(lifecycle.account, undefined);
  assert.deepEqual(
    next.sent.map((value) => value.method),
    ['init', 'login'],
  );
  next.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
  next.events.emit('message', { id: next.sent[1].id, result: { uin: '123', uid: 'u_fixture' } });
  await reconnect;
  assert.deepEqual(exports, [['fixture-export']]);
  assert.equal(events.filter((value) => value === 'ready').length, 2);
  await lifecycle.close();
});
test('offline settles submitted merged forward as unknown and leaves callback presentation to facade', async () => {
  const f = workerFixture();
  const rawEvents: { event: string; payload: unknown }[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit: (event, payload) => rawEvents.push({ event, payload }),
    forward: (event, payload) => rawEvents.push({ event, payload }),
    exportsUpdated() {},
  });
  const raw = { image: 'YmFzZTY0' };
  f.events.emit('message', { event: 'qrcode', payload: raw });
  assert.equal(rawEvents[0].payload, raw);
  assert.equal(raw.image, 'YmFzZTY0');
  const pending = assert.rejects(
    lifecycle.request('sendMergedForward', {}),
    (error) =>
      error instanceof KernelRequestError &&
      error.mergedForward?.uploadCompletion === 'unknown' &&
      error.mergedForward.cardCompletion === 'unknown',
  );
  f.events.emit('message', { event: 'kicked', payload: { retryable: false } });
  await pending;
  assert.equal(lifecycle.state, 'disconnected');
  const close = lifecycle.close();
  assert.equal(lifecycle.close(), close);
  await close;
});

test('SDK state and termination use the typed outlet while unknown worker events retain identity', () => {
  const f = workerFixture();
  const observed: { outlet: string; event: string; payload: unknown }[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit: (event, payload) => observed.push({ outlet: 'typed', event, payload }),
    forward: (event, payload) => observed.push({ outlet: 'unknown', event, payload }),
    exportsUpdated() {},
  });
  const opaque = { untouched: true };
  f.events.emit('message', { event: 'vendor-extension', payload: opaque });
  const failure = new Error('controlled worker failure');
  f.events.emit('error', failure);
  assert.deepEqual(
    observed.map(({ outlet, event }) => [outlet, event]),
    [
      ['unknown', 'vendor-extension'],
      ['typed', 'state'],
      ['typed', 'terminated'],
    ],
  );
  assert.equal(observed[0].payload, opaque);
  assert.equal(observed[1].payload, 'failed');
  assert.equal(observed[2].payload, failure);
  assert.equal(lifecycle.state, 'failed');
});

test('automatic reconnect preserves an opaque rejection on the unknown outlet', async () => {
  const f = workerFixture();
  const opaque = { retryable: false, identity: 'opaque-rejection' };
  let settle!: (value: unknown) => void;
  const observed = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    restart: {
      spawn() {
        throw opaque;
      },
      payload: {},
    },
    autoReconnect: { delayMs: 1, maxAttempts: 1 },
    emit() {},
    forward(event, payload) {
      if (event === 'reconnect-error') settle(payload);
    },
    exportsUpdated() {},
  });
  const login = lifecycle.login();
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await login;
  f.events.emit('message', { event: 'disconnected', payload: { retryable: true } });
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture reconnect did not settle')), 1000);
    });
    assert.equal(await Promise.race([observed, deadline]), opaque);
  } finally {
    clearTimeout(timer);
    await lifecycle.close();
  }
});

test('synchronous closing observer receives the same promise until actual worker exit', async () => {
  const f = workerFixture();
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    f.sent.push(message);
    callback(null);
    return true;
  }) as typeof f.worker.send;
  let nested: Promise<void> | undefined;
  const states: unknown[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, value) {
      if (event === 'state') {
        states.push(value);
        if (value === 'closing') nested = lifecycle.close();
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  assert.equal(nested, closing);
  let settled = false;
  closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  f.events.emit('message', { id: f.sent[0].id, result: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(states, ['closing']);
  assert.equal(f.sent.length, 1);
  Object.assign(f.worker, { exitCode: 0 });
  f.events.emit('exit', 0, null);
  await closing;
  assert.deepEqual(states, ['closing', 'closed']);
  assert.equal(lifecycle.close(), closing);
});
test('reentrant close shares the original cleanup rejection without another attempt', async () => {
  const f = workerFixture();
  const failure = new Error('Controlled cleanup failure');
  let kills = 0;
  f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
    callback(new Error('Controlled close send failure'));
    return true;
  }) as typeof f.worker.send;
  f.worker.kill = () => {
    kills++;
    throw failure;
  };
  let nested: Promise<void> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, value) {
      if (event === 'state' && value === 'closing') nested = lifecycle.close();
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  assert.equal(nested, closing);
  await assert.rejects(closing, (error: unknown) => error === failure);
  assert.equal(lifecycle.close(), closing);
  assert.equal(kills, 1);
});

test('connecting observers join the reserved login and wait while another account rejects before IPC', async () => {
  const f = workerFixture();
  let same: Promise<unknown> | undefined;
  let waiting: Promise<unknown> | undefined;
  let different: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event !== 'state' || state !== 'connecting') return;
      assert.equal(f.sent.length, 0, 'State still precedes login IPC');
      same = lifecycle.login({ method: 'quick', uin: '123' });
      waiting = lifecycle.waitForLogin();
      different = lifecycle.login({ method: 'quick', uin: '456' });
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login({ method: 'quick', uin: '123' });
  assert.equal(same, first);
  assert.equal(waiting, first);
  await assert.rejects(different!, /different login request/);
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['login'],
  );
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { id: f.sent[0].id, result: account });
  assert.deepEqual(await first, account);
  await lifecycle.close();
});

test('close in connecting presentation cancels all joined login callers without dispatch', async () => {
  const f = workerFixture();
  let joined: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting') {
        joined = lifecycle.waitForLogin();
        closing = lifecycle.close();
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(first, joined);
  await assert.rejects(first, /closed/);
  await closing;
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['close'],
  );
});

test('connecting observer throw rejects the reserved attempt by identity and permits explicit recovery', async () => {
  const f = workerFixture();
  const original = { failure: 'Opaque observer failure' };
  let shouldThrow = true;
  let joined: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting' && shouldThrow) {
        joined = lifecycle.waitForLogin();
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(joined, first);
  await assert.rejects(first, (error: unknown) => error === original);
  assert.equal(lifecycle.state, 'idle');
  assert.equal(f.sent.length, 0);
  shouldThrow = false;
  const recovered = lifecycle.login();
  assert.notEqual(first, recovered);
  assert.equal(f.sent.length, 1);
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { id: f.sent[0].id, result: account });
  assert.deepEqual(await recovered, account);
  await lifecycle.close();
});

test('synchronous worker login reply settles the already reserved shared promise', async () => {
  const f = workerFixture();
  const account = { uin: '123', uid: 'u_fixture' };
  const originalSend = f.worker.send.bind(f.worker);
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    if (message.method !== 'login') return originalSend(message, callback);
    f.sent.push(message);
    f.events.emit('message', { id: message.id, result: account });
    callback(null);
    return true;
  }) as typeof f.worker.send;
  let joined: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting') joined = lifecycle.login();
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(first, joined);
  assert.deepEqual(await first, account);
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['login'],
  );
  await lifecycle.close();
});

test('throwing closing observer cannot skip shutdown or settle before actual exit', async () => {
  const f = workerFixture();
  const original = { failure: 'Opaque closing observer' };
  let nested: Promise<void> | undefined;
  const order: string[] = [];
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    order.push(message.method);
    f.sent.push(message);
    callback(null);
    return true;
  }) as typeof f.worker.send;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'closing') {
        order.push('closing');
        nested = lifecycle.close();
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const pending = lifecycle.request('listFriends');
  const observedPending = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  const closing = lifecycle.close();
  const observedClose = closing.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(nested, closing);
  assert.deepEqual(order, ['listFriends', 'closing', 'close']);
  let settled = false;
  void observedClose.then(() => {
    settled = true;
  });
  f.events.emit('message', { id: f.sent[1].id, result: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.match(String(await observedPending), /closed/);
  Object.assign(f.worker, { exitCode: 0, connected: false });
  f.events.emit('exit', 0, null);
  assert.equal(await observedClose, original);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(lifecycle.close(), closing);
});

test('closing observer failure retains cleanup failure and never retries shutdown', async () => {
  const f = workerFixture();
  const original = undefined;
  const cleanup = new Error('Controlled worker kill failure');
  let kills = 0;
  f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
    callback(new Error('Controlled close IPC failure'));
    return true;
  }) as typeof f.worker.send;
  f.worker.kill = () => {
    kills++;
    throw cleanup;
  };
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'closing') throw original;
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
  assert.equal(kills, 1);
  assert.equal(lifecycle.state, 'failed');
  assert.equal(lifecycle.close(), closing);
});

for (const offline of ['disconnected', 'logout', 'kicked'] as const) {
  for (const throws of [false, true]) {
    test(`${offline} retires pending requests before a ${throws ? 'throwing' : 'reentrant'} state observer`, async () => {
      const f = workerFixture();
      const opaque = { observer: offline };
      f.worker.send = ((
        message: { id: number; method: string },
        callback: (error: Error | null) => void,
      ) => {
        f.sent.push(message);
        callback(null);
        return true;
      }) as typeof f.worker.send;
      const lifecycle = new ClientLifecycle({
        worker: f.worker,
        timeout: 1000,
        emit(event, state) {
          if (event !== 'state' || state !== 'disconnected') return;
          for (const sent of f.sent.slice())
            if (
              sent.method === 'listFriends' ||
              sent.method === 'sendMergedForward' ||
              sent.method === 'close'
            )
              f.events.emit('message', { id: sent.id, result: 'late' });
          if (throws) throw opaque;
        },
        forward() {},
        exportsUpdated() {},
      });
      const readOutcome = lifecycle.request('listFriends').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const mergedOutcome = lifecycle.request('sendMergedForward').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const closeOutcome = lifecycle.request('close').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (throws)
          assert.throws(
            () => f.events.emit('message', { event: offline, payload: { retryable: false } }),
            (error) => error === opaque,
          );
        else f.events.emit('message', { event: offline, payload: { retryable: false } });
        const readResult = await readOutcome;
        assert.ok('error' in readResult);
        assert.match(String(readResult.error), /offline/);
        const mergedResult = await mergedOutcome;
        assert.ok('error' in mergedResult && mergedResult.error instanceof KernelRequestError);
        assert.equal(mergedResult.error.mergedForward?.uploadCompletion, 'unknown');
        assert.equal(mergedResult.error.mergedForward?.cardCompletion, 'unknown');
        assert.deepEqual(await closeOutcome, { value: 'late' });
      } finally {
        Object.assign(f.worker, { exitCode: 0 });
        const closing = lifecycle.close();
        const sent = f.sent.at(-1);
        assert.ok(sent && sent.method === 'close');
        f.events.emit('message', { id: sent.id, result: null });
        await closing;
      }
    });
  }
}

for (const offline of ['logout', 'kicked'] as const) {
  test(`${offline} clears the old restoration account before reentrant reconnect`, async () => {
    const old = workerFixture(),
      next = workerFixture();
    let reconnect: Promise<unknown> | undefined;
    let submittedLogin: unknown;
    const send = next.worker.send.bind(next.worker);
    next.worker.send = ((
      message: { id: number; method: string; login?: unknown },
      callback: (error: Error | null) => void,
    ) => {
      if (message.method === 'login') submittedLogin = message.login;
      return send(message, callback);
    }) as typeof next.worker.send;
    const lifecycle = new ClientLifecycle({
      worker: old.worker,
      timeout: 1000,
      restart: { spawn: () => next.worker, payload: {} },
      emit(event, state) {
        if (event === 'state' && state === 'disconnected') reconnect = lifecycle.reconnect();
      },
      forward() {},
      exportsUpdated() {},
    });
    const login = lifecycle.login({ method: 'quick', uin: '123' });
    const account = { uin: '123', uid: 'u_fixture' };
    old.events.emit('message', { event: 'ready', payload: account });
    old.events.emit('message', { id: old.sent[0].id, result: account });
    await login;
    old.events.emit('message', { event: offline, payload: {} });
    const observed = reconnect?.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(submittedLogin, { method: 'restore' });
    } finally {
      const sent = next.sent.find((value) => value.method === 'login');
      if (sent) {
        next.events.emit('message', { event: 'ready', payload: account });
        next.events.emit('message', { id: sent.id, result: account });
      }
      await observed;
      await lifecycle.close();
    }
  });
}

for (const observer of ['state', 'raw'] as const) {
  test(`${observer} offline observer can start a new login without old retirement or auto restore`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = workerFixture();
    let spawns = 0;
    let nextLogin: Promise<unknown> | undefined;
    const start = () => {
      nextLogin = lifecycle.login({ method: 'quick', uin: '456' });
    };
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      restart: {
        spawn() {
          spawns++;
          return workerFixture().worker;
        },
        payload: {},
      },
      autoReconnect: { delayMs: 50, maxAttempts: 1 },
      emit(event, state) {
        if (observer === 'state' && event === 'state' && state === 'disconnected') start();
      },
      forward(event) {
        if (observer === 'raw' && event === 'disconnected') start();
      },
      exportsUpdated() {},
    });
    const oldAccount = { uin: '123', uid: 'u_old' };
    const oldLogin = lifecycle.login({ method: 'quick', uin: '123' });
    f.events.emit('message', { event: 'ready', payload: oldAccount });
    f.events.emit('message', { id: f.sent[0].id, result: oldAccount });
    await oldLogin;
    f.events.emit('message', { event: 'disconnected', payload: { retryable: true } });
    assert.ok(nextLogin);
    let settled = false;
    const observed = nextLogin.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    try {
      context.mock.timers.tick(60);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(spawns, 0);
      assert.equal(settled, false);
      assert.equal(lifecycle.state, 'connecting');
      assert.equal(f.sent.filter((sent) => sent.method === 'login').length, 2);
      const newAccount = { uin: '456', uid: 'u_new' };
      const sent = f.sent.at(-1);
      assert.ok(sent && sent.method === 'login');
      f.events.emit('message', { event: 'ready', payload: newAccount });
      f.events.emit('message', { id: sent.id, result: newAccount });
      assert.deepEqual(await observed, newAccount);
    } finally {
      await lifecycle.close();
    }
  });
}

test('nested nonretryable disconnect blocks the outer retryable automatic restore decision', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = workerFixture();
  let spawns = 0;
  let nested = false;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    restart: {
      spawn() {
        spawns++;
        return workerFixture().worker;
      },
      payload: {},
    },
    autoReconnect: { delayMs: 50, maxAttempts: 1 },
    emit() {},
    forward(event) {
      if (event === 'disconnected' && !nested) {
        nested = true;
        f.events.emit('message', { event: 'disconnected', payload: { retryable: false } });
      }
    },
    exportsUpdated() {},
  });
  const account = { uin: '123', uid: 'u_old' };
  const login = lifecycle.login({ method: 'quick', uin: '123' });
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await login;
  try {
    f.events.emit('message', { event: 'disconnected', payload: { retryable: true } });
    context.mock.timers.tick(60);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(nested, true);
    assert.equal(spawns, 0);
    assert.equal(lifecycle.state, 'disconnected');
    assert.equal(f.sent.filter((sent) => sent.method === 'login').length, 1);
  } finally {
    await lifecycle.close();
  }
});

for (const observerThrows of [false, true]) {
  test(`offline policy getter failure retires old RPCs and preserves observer failure=${observerThrows}`, async () => {
    const f = workerFixture();
    const policyFailure = Object.freeze({ policy: 'opaque' });
    const observerFailure = Object.freeze({ observer: 'opaque' });
    const forwarded: string[] = [];
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      emit(event, state) {
        if (event === 'state' && state === 'disconnected' && observerThrows) throw observerFailure;
      },
      forward(event) {
        forwarded.push(event);
      },
      exportsUpdated() {},
    });
    f.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    const outcome = lifecycle.request('listFriends').then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const request = f.sent.at(-1)!;
    let reads = 0;
    const payload = Object.defineProperty({}, 'retryable', {
      get() {
        reads++;
        throw policyFailure;
      },
    });
    try {
      assert.throws(
        () => f.events.emit('message', { event: 'disconnected', payload }),
        (error: unknown) => {
          if (observerThrows) {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [policyFailure, observerFailure]);
          } else assert.equal(error, policyFailure);
          return true;
        },
      );
      f.events.emit('message', { id: request.id, result: 'late success' });
      const result = await outcome;
      assert.ok('error' in result && result.error instanceof Error);
      assert.match(result.error.message, /offline/);
      assert.equal(lifecycle.account, undefined);
      assert.equal(lifecycle.state, 'disconnected');
      assert.equal(reads, 1);
      assert.deepEqual(forwarded, ['ready']);
    } finally {
      await lifecycle.close();
      await outcome;
    }
  });
}

test('offline policy getter close cannot overwrite closing or forward the obsolete event', async () => {
  const f = workerFixture();
  const forwarded: string[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit() {},
    forward(event) {
      forwarded.push(event);
    },
    exportsUpdated() {},
  });
  f.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
  let closing: Promise<void> | undefined;
  let reads = 0;
  const payload = Object.defineProperty({}, 'retryable', {
    get() {
      reads++;
      closing = lifecycle.close();
      return true;
    },
  });
  try {
    f.events.emit('message', { event: 'disconnected', payload });
    assert.equal(lifecycle.state, 'closing');
    assert.equal(reads, 1);
    assert.deepEqual(forwarded, ['ready']);
    assert.ok(closing);
    await closing;
    assert.equal(lifecycle.state, 'closed');
  } finally {
    await closing;
    await lifecycle.close();
  }
});

test('offline policy getter nested nonretryable notification defeats outer retryable restore', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = workerFixture();
  let spawns = 0;
  const forwarded: unknown[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    restart: {
      spawn() {
        spawns++;
        return workerFixture().worker;
      },
      payload: {},
    },
    autoReconnect: { delayMs: 50, maxAttempts: 1 },
    emit() {},
    forward(event, payload) {
      if (event === 'disconnected') forwarded.push(payload);
    },
    exportsUpdated() {},
  });
  f.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
  const nested = { retryable: false };
  let reads = 0;
  const outer = Object.defineProperty({}, 'retryable', {
    get() {
      reads++;
      f.events.emit('message', { event: 'disconnected', payload: nested });
      return true;
    },
  });
  try {
    f.events.emit('message', { event: 'disconnected', payload: outer });
    context.mock.timers.tick(60);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawns, 0);
    assert.equal(reads, 1);
    assert.deepEqual(forwarded, [nested]);
    assert.equal(lifecycle.state, 'disconnected');
  } finally {
    await lifecycle.close();
  }
});

for (const kind of ['error', 'opaque', 'undefined'] as const) {
  for (const cleanupFails of [false, true]) {
    test(`login timeout retires siblings and stops worker despite ${kind} observer (${cleanupFails ? 'failed' : 'successful'} cleanup)`, async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const f = workerFixture();
      const observerFailure: unknown =
        kind === 'error'
          ? new Error('observer fixture')
          : kind === 'opaque'
            ? { message: 'opaque observer fixture', code: 7 }
            : undefined;
      const cleanupFailure = new Error('stop fixture');
      let kills = 0;
      let readSettled = false;
      let mergedSettled = false;
      f.worker.send = ((
        message: { id: number; method: string },
        callback: (error: Error | null) => void,
      ) => {
        f.sent.push(message);
        callback(null);
        return true;
      }) as typeof f.worker.send;
      f.worker.kill = () => {
        kills++;
        if (cleanupFails) throw cleanupFailure;
        Object.assign(f.worker, { exitCode: 0, connected: false });
        f.events.emit('exit', 0, null);
        return true;
      };
      const lifecycle = new ClientLifecycle({
        worker: f.worker,
        timeout: 10,
        emit(event, state) {
          if (event !== 'state' || state !== 'failed') return;
          for (const sent of f.sent)
            if (sent.method === 'listFriends' || sent.method === 'sendMergedForward')
              f.events.emit('message', { id: sent.id, result: 'late observer reply' });
          throw observerFailure;
        },
        forward() {},
        exportsUpdated() {},
      });
      const login = lifecycle.login({ method: 'quick', uin: '123' }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const read = lifecycle.request('listFriends', {}, 1000).then(
        (value) => {
          readSettled = true;
          return { value };
        },
        (error: unknown) => {
          readSettled = true;
          return { error };
        },
      );
      const merged = lifecycle.request('sendMergedForward', {}, 1000).then(
        (value) => {
          mergedSettled = true;
          return { value };
        },
        (error: unknown) => {
          mergedSettled = true;
          return { error };
        },
      );
      context.mock.timers.tick(10);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const immediatelyRetired = { read: readSettled, merged: mergedSettled, kills };
      f.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_late' } });
      // Drain old-source retained timers before asserting, keeping red replay bounded.
      context.mock.timers.tick(1000);
      const [loginResult, readResult, mergedResult] = await Promise.all([login, read, merged]);
      assert.deepEqual(immediatelyRetired, { read: true, merged: true, kills: 1 });
      assert.equal(lifecycle.state, 'failed');
      assert.equal(lifecycle.account, undefined);
      assert.ok('error' in readResult);
      assert.match(String(readResult.error), /login timed out/);
      assert.ok('error' in mergedResult && mergedResult.error instanceof KernelRequestError);
      assert.equal(mergedResult.error.mergedForward?.uploadCompletion, 'unknown');
      assert.equal(mergedResult.error.mergedForward?.cardCompletion, 'unknown');
      assert.ok('error' in loginResult);
      assert.ok(loginResult.error instanceof AggregateError);
      const failures: unknown[] = loginResult.error.errors;
      assert.equal(failures.length, cleanupFails ? 3 : 2);
      assert.ok(failures[0] instanceof Error);
      assert.match(failures[0].message, /login timed out/);
      assert.equal(failures[1], observerFailure);
      if (cleanupFails) assert.equal(failures[2], cleanupFailure);
      assert.equal(kills, 1);
      assert.equal(f.worker.exitCode, cleanupFails ? null : 0);
      if (cleanupFails) {
        const closing = lifecycle.close();
        await assert.rejects(closing, (error: unknown) => error === cleanupFailure);
        assert.equal(lifecycle.close(), closing);
        context.mock.timers.tick(5000);
        assert.equal(kills, 1);
      }
    });
  }
}

test('login timeout and reentrant close share one stop and await actual exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = workerFixture();
  let kills = 0;
  let closing: Promise<void> | undefined;
  let loginSettled = false;
  let closeSettled = false;
  const original = new Error('failed observer fixture');
  f.worker.kill = () => {
    kills++;
    return true;
  };
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 10,
    emit(event, state) {
      if (event === 'state' && state === 'failed') {
        closing = lifecycle.close();
        closing.then(
          () => {
            closeSettled = true;
          },
          () => {
            closeSettled = true;
          },
        );
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const login = lifecycle.login({ method: 'quick', uin: '123' }).then(
    (value) => {
      loginSettled = true;
      return { value };
    },
    (error: unknown) => {
      loginSettled = true;
      return { error };
    },
  );
  context.mock.timers.tick(10);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeExit = { kills, loginSettled, closeSettled };
  Object.assign(f.worker, { exitCode: 0, connected: false });
  f.events.emit('exit', 0, null);
  const result = await login;
  await closing;
  assert.deepEqual(beforeExit, { kills: 1, loginSettled: false, closeSettled: false });
  assert.ok('error' in result && result.error instanceof AggregateError);
  assert.equal(result.error.errors[1], original);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(lifecycle.close(), closing);
  assert.equal(kills, 1);
});

test('failed timeout observer reconnect binds retirement to old worker and never kills replacement', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const old = workerFixture(),
    next = workerFixture();
  let oldKills = 0,
    nextKills = 0;
  let reconnect: Promise<unknown> | undefined;
  const original = new Error('reconnecting observer fixture');
  old.worker.kill = () => {
    oldKills++;
    return true;
  };
  const nextKill = next.worker.kill.bind(next.worker);
  next.worker.kill = (...args) => {
    nextKills++;
    return nextKill(...args);
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 10,
    restart: { spawn: () => next.worker, payload: {} },
    emit(event, state) {
      if (event === 'state' && state === 'failed') {
        reconnect = lifecycle.reconnect({ method: 'quick', uin: '456' });
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const login = lifecycle.login({ method: 'quick', uin: '123' }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  context.mock.timers.tick(10);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const killsBeforeExit = oldKills;
  assert.ok(reconnect);
  Object.assign(old.worker, { exitCode: 0, connected: false });
  old.events.emit('exit', 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sent = next.sent.find((value) => value.method === 'login');
  try {
    assert.ok(sent);
    const account = { uin: '456', uid: 'u_replacement' };
    next.events.emit('message', { event: 'ready', payload: account });
    next.events.emit('message', { id: sent.id, result: account });
    assert.deepEqual(await reconnect, account);
    const result = await login;
    assert.ok('error' in result && result.error instanceof AggregateError);
    assert.equal(result.error.errors[1], original);
    assert.equal(killsBeforeExit, 1);
    assert.equal(nextKills, 0);
    assert.deepEqual(lifecycle.account, account);
  } finally {
    await lifecycle.close();
  }
});

test('login timeout clears a previously queued automatic restore without clearing explicit restoration account', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = workerFixture();
  let spawns = 0;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 10,
    restart: {
      spawn() {
        spawns++;
        return workerFixture().worker;
      },
      payload: {},
    },
    autoReconnect: { delayMs: 100, maxAttempts: 1 },
    emit() {},
    forward() {},
    exportsUpdated() {},
  });
  const account = { uin: '123', uid: 'u_old' };
  const initial = lifecycle.login({ method: 'quick', uin: '123' });
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await initial;
  f.events.emit('message', { event: 'disconnected', payload: { retryable: true } });
  const failed = lifecycle.login({ method: 'quick', uin: '456' });
  const observed = assert.rejects(failed, /login timed out/);
  context.mock.timers.tick(10);
  await observed;
  context.mock.timers.tick(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(spawns, 0);
  assert.equal(lifecycle.state, 'failed');
  assert.equal(lifecycle.account, undefined);
  assert.equal(f.worker.exitCode, 0);
});

for (const phase of ['init', 'login'] as const) {
  for (const observer of ['none', 'error', 'opaque', 'undefined'] as const) {
    for (const cleanupFails of [false, true]) {
      test(`replacement ${phase} failure retires siblings (${observer} observer, cleanup ${cleanupFails ? 'fails' : 'succeeds'})`, async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const old = workerFixture(),
          next = workerFixture();
        const primary = new Error(`${phase} failed fixture`);
        const notification: unknown =
          observer === 'error'
            ? new Error('failed observer fixture')
            : observer === 'opaque'
              ? { opaque: true }
              : undefined;
        const cleanup = new Error('replacement kill fixture');
        let fail: ((error: Error | null) => void) | undefined;
        let kills = 0,
          notifications = 0;
        next.worker.send = ((
          message: { id: number; method: string },
          callback: (error: Error | null) => void,
        ) => {
          next.sent.push(message);
          if (message.method === phase) fail = callback;
          else {
            callback(null);
            if (message.method === 'init')
              queueMicrotask(() =>
                next.events.emit('message', { id: message.id, result: { exports: [] } }),
              );
          }
          return true;
        }) as typeof next.worker.send;
        next.worker.kill = () => {
          kills++;
          if (cleanupFails) throw cleanup;
          Object.assign(next.worker, { exitCode: 0, connected: false });
          next.events.emit('exit', 0, null);
          return true;
        };
        const lifecycle = new ClientLifecycle({
          worker: old.worker,
          timeout: 1000,
          restart: { spawn: () => next.worker, payload: {} },
          emit(event, state) {
            if (event === 'state' && state === 'failed') {
              notifications++;
              for (const sent of next.sent)
                if (sent.method === 'listFriends' || sent.method === 'sendMergedForward')
                  next.events.emit('message', { id: sent.id, result: 'late' });
              if (observer !== 'none') throw notification;
            }
          },
          forward() {},
          exportsUpdated() {},
        });
        const reconnect = lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(fail);
        let readSettled = false,
          mergedSettled = false;
        const read = lifecycle.request('listFriends', {}, 2000).then(
          (value) => {
            readSettled = true;
            return { value };
          },
          (error: unknown) => {
            readSettled = true;
            return { error };
          },
        );
        const merged = lifecycle.request('sendMergedForward', {}, 2000).then(
          (value) => {
            mergedSettled = true;
            return { value };
          },
          (error: unknown) => {
            mergedSettled = true;
            return { error };
          },
        );
        fail(primary);
        const result = await reconnect;
        const retired = { read: readSettled, merged: mergedSettled, kills };
        next.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_late' } });
        context.mock.timers.tick(2000);
        const [readResult, mergedResult] = await Promise.all([read, merged]);
        assert.deepEqual(retired, { read: true, merged: true, kills: 1 });
        assert.equal(notifications, 1);
        assert.equal(lifecycle.account, undefined);
        assert.ok('error' in readResult && readResult.error === primary);
        assert.ok('error' in mergedResult && mergedResult.error instanceof KernelRequestError);
        assert.equal(mergedResult.error.mergedForward?.uploadCompletion, 'unknown');
        assert.equal(mergedResult.error.mergedForward?.cardCompletion, 'unknown');
        assert.ok('error' in result);
        if (observer === 'none' && !cleanupFails) assert.equal(result.error, primary);
        else {
          assert.ok(result.error instanceof AggregateError);
          assert.deepEqual(result.error.errors, [
            primary,
            ...(observer === 'none' ? [] : [notification]),
            ...(cleanupFails ? [cleanup] : []),
          ]);
        }
        if (phase === 'init')
          assert.equal(next.sent.filter((sent) => sent.method === 'login').length, 0);
        if (cleanupFails)
          await assert.rejects(lifecycle.close(), (error: unknown) => error === cleanup);
        assert.equal(kills, 1);
      });
    }
  }
}

test('reconnect login timeout joins the completed failure transaction without duplicate notification or aggregation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const old = workerFixture(),
    next = workerFixture();
  const original = new Error('timeout observer fixture');
  let notifications = 0,
    kills = 0;
  const kill = next.worker.kill.bind(next.worker);
  next.worker.kill = (...args) => {
    kills++;
    return kill(...args);
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 10,
    restart: { spawn: () => next.worker, payload: {} },
    emit(event, state) {
      if (event === 'state' && state === 'failed') {
        notifications++;
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const reconnect = lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(next.sent.some((sent) => sent.method === 'login'));
  const read = lifecycle.request('listFriends', {}, 1000).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  context.mock.timers.tick(10);
  const result = await reconnect;
  const readResult = await read;
  assert.ok('error' in result && result.error instanceof AggregateError);
  assert.equal(result.error.errors.length, 2);
  assert.ok(result.error.errors[0] instanceof Error);
  assert.match(result.error.errors[0].message, /login timed out/);
  assert.equal(result.error.errors[1], original);
  assert.ok('error' in readResult && readResult.error === result.error.errors[0]);
  assert.equal(notifications, 1);
  assert.equal(kills, 1);
});

test('replacement failure observer close joins one stop and waits for actual replacement exit', async () => {
  const old = workerFixture(),
    next = workerFixture();
  const primary = new Error('init failure fixture'),
    original = new Error('observer fixture');
  let fail: ((error: Error | null) => void) | undefined;
  let kills = 0;
  let closing: Promise<void> | undefined;
  let reconnectSettled = false,
    closeSettled = false;
  next.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    next.sent.push(message);
    if (message.method === 'init') fail = callback;
    else callback(null);
    return true;
  }) as typeof next.worker.send;
  next.worker.kill = () => {
    kills++;
    return true;
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: { spawn: () => next.worker, payload: {} },
    emit(event, state) {
      if (event === 'state' && state === 'failed') {
        closing = lifecycle.close();
        closing.then(
          () => {
            closeSettled = true;
          },
          () => {
            closeSettled = true;
          },
        );
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const reconnect = lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
    (value) => {
      reconnectSettled = true;
      return { value };
    },
    (error: unknown) => {
      reconnectSettled = true;
      return { error };
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(fail);
  fail(primary);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeExit = { kills, reconnectSettled, closeSettled };
  Object.assign(next.worker, { exitCode: 0, connected: false });
  next.events.emit('exit', 0, null);
  const result = await reconnect;
  await closing;
  assert.deepEqual(beforeExit, { kills: 1, reconnectSettled: false, closeSettled: false });
  assert.ok('error' in result && result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [primary, original]);
  assert.equal(lifecycle.close(), closing);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(kills, 1);
});

for (const prior of ['idle', 'online', 'failed'] as const) {
  for (const kind of ['error', 'opaque', 'undefined'] as const) {
    test(`reconnect entry ${kind} observer failure returns shared rejection and preserves ${prior} ownership`, async () => {
      const old = workerFixture(),
        next = workerFixture();
      const original: unknown =
        kind === 'error'
          ? new Error('entry observer fixture')
          : kind === 'opaque'
            ? { opaque: true }
            : undefined;
      let notified = false,
        spawns = 0;
      let joined: Promise<unknown> | undefined;
      let joinedOutcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
      let different: Promise<unknown> | undefined;
      const send = next.worker.send.bind(next.worker);
      next.worker.send = ((
        message: { id: number; method: string },
        callback: (error: Error | null) => void,
      ) => {
        const returned = send(message, callback);
        if (message.method === 'login')
          queueMicrotask(() => {
            const account = { uin: '456', uid: 'u_new' };
            next.events.emit('message', { event: 'ready', payload: account });
            next.events.emit('message', { id: message.id, result: account });
          });
        return returned;
      }) as typeof next.worker.send;
      const lifecycle = new ClientLifecycle({
        worker: old.worker,
        timeout: 1000,
        restart: {
          spawn() {
            spawns++;
            return next.worker;
          },
          payload: {},
        },
        emit(event, state) {
          if (event !== 'state' || state !== 'connecting' || notified || !armed) return;
          notified = true;
          joined = lifecycle.reconnect({ method: 'quick', uin: '456' });
          joinedOutcome = joined.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          different = lifecycle.reconnect({ method: 'quick', uin: '789' }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          throw original;
        },
        forward() {},
        exportsUpdated() {},
      });
      let armed = false;
      const account = { uin: '123', uid: 'u_old' };
      if (prior === 'online') {
        const login = lifecycle.login({ method: 'quick', uin: '123' });
        old.events.emit('message', { event: 'ready', payload: account });
        old.events.emit('message', { id: old.sent[0].id, result: account });
        await login;
      } else if (prior === 'failed') old.events.emit('error', new Error('old worker fixture'));
      const read =
        prior === 'failed'
          ? undefined
          : lifecycle.request('listFriends').then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
      armed = true;
      let escaped = false;
      let returned: Promise<unknown> | undefined;
      try {
        returned = lifecycle.reconnect({ method: 'quick', uin: '456' });
      } catch {
        escaped = true;
      }
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(escaped, false);
        assert.equal(returned, joined);
        assert.deepEqual(await joinedOutcome, { error: original });
        const differentResult = await different;
        assert.ok(
          differentResult && typeof differentResult === 'object' && 'error' in differentResult,
        );
        assert.match(String(differentResult.error), /different reconnect/);
        assert.equal(spawns, 0);
        assert.equal(next.sent.length, 0);
        assert.equal(lifecycle.state, prior);
        assert.deepEqual(lifecycle.account, prior === 'online' ? account : undefined);
        if (read) {
          const sent = old.sent.find((sent) => sent.method === 'listFriends');
          assert.ok(sent);
          old.events.emit('message', { id: sent.id, result: ['retained'] });
          assert.deepEqual(await read, { value: ['retained'] });
        }
        if (prior === 'idle' && kind === 'error') {
          const retry = lifecycle.reconnect({ method: 'quick', uin: '456' });
          assert.notEqual(retry, returned);
          assert.deepEqual(await retry, { uin: '456', uid: 'u_new' });
          assert.equal(spawns, 1);
          assert.deepEqual(
            next.sent.map((sent) => sent.method),
            ['init', 'login'],
          );
        }
      } finally {
        await lifecycle.close();
        await read;
        await joinedOutcome;
        await different;
      }
    });
  }
}

for (const action of ['close', 'disconnect'] as const) {
  test(`reconnect entry failure does not roll back observer ${action}`, async () => {
    const f = workerFixture();
    const original = { presentation: action };
    let armed = false,
      spawns = 0;
    let closing: Promise<void> | undefined;
    let joined: Promise<unknown> | undefined;
    let observed: Promise<{ value: unknown } | { error: unknown }> | undefined;
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      restart: {
        spawn() {
          spawns++;
          return workerFixture().worker;
        },
        payload: {},
      },
      emit(event, state) {
        if (!armed || event !== 'state' || state !== 'connecting') return;
        armed = false;
        joined = lifecycle.reconnect({ method: 'quick', uin: '456' });
        observed = joined.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (action === 'close') closing = lifecycle.close();
        else f.events.emit('message', { event: 'disconnected', payload: { retryable: false } });
        throw original;
      },
      forward() {},
      exportsUpdated() {},
    });
    const account = { uin: '123', uid: 'u_old' };
    const login = lifecycle.login({ method: 'quick', uin: '123' });
    f.events.emit('message', { event: 'ready', payload: account });
    f.events.emit('message', { id: f.sent[0].id, result: account });
    await login;
    armed = true;
    let returned: Promise<unknown> | undefined;
    let escaped = false;
    try {
      returned = lifecycle.reconnect({ method: 'quick', uin: '456' });
    } catch {
      escaped = true;
    }
    try {
      assert.equal(escaped, false);
      assert.equal(returned, joined);
      assert.deepEqual(await observed, { error: original });
      await closing;
      assert.equal(lifecycle.state, action === 'close' ? 'closed' : 'disconnected');
      assert.equal(lifecycle.account, undefined);
      assert.equal(spawns, 0);
    } finally {
      await lifecycle.close();
      await observed;
    }
  });
}

for (const action of ['login', 'ready'] as const) {
  test(`reconnect entry failure preserves observer ${action} state instead of restoring idle`, async () => {
    const f = workerFixture();
    const original = { presentation: action };
    const account = { uin: '123', uid: 'u_nested' };
    let armed = true,
      spawns = 0;
    let nestedLogin: Promise<unknown> | undefined;
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      restart: {
        spawn() {
          spawns++;
          return workerFixture().worker;
        },
        payload: {},
      },
      emit(event, state) {
        if (!armed || event !== 'state' || state !== 'connecting') return;
        armed = false;
        if (action === 'login') nestedLogin = lifecycle.login({ method: 'quick', uin: '123' });
        else f.events.emit('message', { event: 'ready', payload: account });
        throw original;
      },
      forward() {},
      exportsUpdated() {},
    });
    try {
      await assert.rejects(
        lifecycle.reconnect({ method: 'quick', uin: '456' }),
        (error: unknown) => error === original,
      );
      assert.equal(spawns, 0);
      assert.equal(lifecycle.state, action === 'login' ? 'connecting' : 'online');
      if (action === 'login') {
        const sent = f.sent.find((sent) => sent.method === 'login');
        assert.ok(sent);
        f.events.emit('message', { event: 'ready', payload: account });
        f.events.emit('message', { id: sent.id, result: account });
        assert.deepEqual(await nestedLogin, account);
      }
      assert.deepEqual(lifecycle.account, account);
    } finally {
      await lifecycle.close();
      await nestedLogin;
    }
  });
}

for (const row of [
  { primary: 'error', observer: 'none' },
  { primary: 'opaque', observer: 'none' },
  { primary: 'undefined', observer: 'none' },
  { primary: 'error', observer: 'error' },
  { primary: 'opaque', observer: 'undefined' },
  { primary: 'undefined', observer: 'opaque' },
  { primary: 'error', observer: 'undefined' },
] as const) {
  test(`spawn ${row.primary} failure retains original with ${row.observer} observer`, async () => {
    const old = workerFixture(),
      next = workerFixture();
    const primary: unknown =
      row.primary === 'error'
        ? new Error('spawn fixture')
        : row.primary === 'opaque'
          ? { spawn: true }
          : undefined;
    const notification: unknown =
      row.observer === 'error'
        ? new Error('failed observer fixture')
        : row.observer === 'opaque'
          ? { observer: true }
          : undefined;
    let attempts = 0,
      kills = 0,
      notifications = 0;
    const kill = old.worker.kill.bind(old.worker);
    old.worker.kill = (...args) => {
      kills++;
      return kill(...args);
    };
    const send = next.worker.send.bind(next.worker);
    next.worker.send = ((
      message: { id: number; method: string },
      callback: (error: Error | null) => void,
    ) => {
      const result = send(message, callback);
      if (message.method === 'login')
        queueMicrotask(() => {
          const account = { uin: '123', uid: 'u_recovered' };
          next.events.emit('message', { event: 'ready', payload: account });
          next.events.emit('message', { id: message.id, result: account });
        });
      return result;
    }) as typeof next.worker.send;
    const lifecycle = new ClientLifecycle({
      worker: old.worker,
      timeout: 1000,
      restart: {
        spawn() {
          attempts++;
          if (attempts === 1) throw primary;
          return next.worker;
        },
        payload: {},
      },
      emit(event, state) {
        if (event === 'state' && state === 'failed') {
          notifications++;
          if (row.observer !== 'none') throw notification;
        }
      },
      forward() {},
      exportsUpdated() {},
    });
    try {
      const result = await lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      assert.ok('error' in result);
      if (row.observer === 'none') assert.equal(result.error, primary);
      else {
        assert.ok(result.error instanceof AggregateError);
        assert.deepEqual(result.error.errors, [primary, notification]);
      }
      assert.equal(notifications, 1);
      assert.equal(kills, 1);
      assert.equal(attempts, 1);
      assert.equal(old.worker.exitCode, 0);
      assert.equal(next.sent.length, 0);
      assert.equal(lifecycle.state, 'failed');
      assert.equal(lifecycle.account, undefined);
      if (row.primary === 'error' && row.observer === 'error') {
        assert.deepEqual(await lifecycle.reconnect({ method: 'quick', uin: '123' }), {
          uin: '123',
          uid: 'u_recovered',
        });
        assert.equal(attempts, 2);
        assert.equal(kills, 1);
        assert.deepEqual(
          next.sent.map((sent) => sent.method),
          ['init', 'login'],
        );
      }
    } finally {
      await lifecycle.close();
    }
  });
}

test('old worker stop failure and failed observer failure retain both originals without retry or spawn', async () => {
  const old = workerFixture();
  const primary = new Error('old stop fixture'),
    notification = new Error('failed observer fixture');
  let kills = 0,
    spawns = 0;
  old.worker.kill = () => {
    kills++;
    throw primary;
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: {
      spawn() {
        spawns++;
        return workerFixture().worker;
      },
      payload: {},
    },
    emit(event, state) {
      if (event === 'state' && state === 'failed') throw notification;
    },
    forward() {},
    exportsUpdated() {},
  });
  const result = await lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await assert.rejects(lifecycle.close(), (error: unknown) => error === primary);
  assert.ok('error' in result && result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [primary, notification]);
  assert.equal(kills, 1);
  assert.equal(spawns, 0);
  assert.equal(old.sent.length, 0);
});

test('spawn failure observer close preserves both failures and never repeats completed old stop', async () => {
  const old = workerFixture();
  const primary = new Error('spawn fixture'),
    notification = { notification: true };
  let closing: Promise<void> | undefined;
  let kills = 0,
    spawns = 0;
  const kill = old.worker.kill.bind(old.worker);
  old.worker.kill = (...args) => {
    kills++;
    return kill(...args);
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: {
      spawn() {
        spawns++;
        throw primary;
      },
      payload: {},
    },
    emit(event, state) {
      if (event === 'state' && state === 'failed') {
        closing = lifecycle.close();
        throw notification;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const result = await lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await closing;
  assert.ok('error' in result && result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [primary, notification]);
  assert.equal(lifecycle.close(), closing);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(kills, 1);
  assert.equal(spawns, 1);
  assert.equal(old.sent.length, 0);
});

for (const kind of ['error', 'opaque', 'undefined'] as const) {
  test(`close cleanup failure retains ${kind} failed observer alongside original cleanup`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = workerFixture();
    const ipc = new Error('close IPC fixture'),
      cleanup = new Error('kill fixture');
    const notification: unknown =
      kind === 'error'
        ? new Error('failed notification fixture')
        : kind === 'opaque'
          ? { failed: true }
          : undefined;
    let kills = 0,
      sends = 0;
    f.worker.send = ((message: { method: string }, callback: (error: Error | null) => void) => {
      assert.equal(message.method, 'close');
      sends++;
      callback(ipc);
      return true;
    }) as typeof f.worker.send;
    f.worker.kill = () => {
      kills++;
      throw cleanup;
    };
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      emit(event, state) {
        if (event === 'state' && state === 'failed') throw notification;
      },
      forward() {},
      exportsUpdated() {},
    });
    const closing = lifecycle.close();
    const outcome = await closing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert.equal(lifecycle.close(), closing);
    context.mock.timers.tick(5000);
    assert.equal(kills, 1);
    assert.equal(sends, 1);
    assert.equal(f.worker.exitCode, null);
    assert.equal(lifecycle.state, 'failed');
    assert.ok('error' in outcome && outcome.error instanceof AggregateError);
    assert.deepEqual(outcome.error.errors, [cleanup, notification]);
    assert.equal(outcome.error.errors.includes(ipc), false);
  });
}

test('closing observer and cleanup plus failed observer retain established flattened order', async () => {
  const f = workerFixture();
  const closingFailure = new Error('closing notification fixture');
  const cleanup = new Error('kill fixture'),
    failedFailure = { failed: true };
  let kills = 0;
  f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
    callback(new Error('close IPC fixture'));
    return true;
  }) as typeof f.worker.send;
  f.worker.kill = () => {
    kills++;
    throw cleanup;
  };
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'closing') throw closingFailure;
      if (event === 'state' && state === 'failed') throw failedFailure;
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [closingFailure, cleanup, failedFailure]);
    return true;
  });
  assert.equal(lifecycle.close(), closing);
  assert.equal(kills, 1);
});

test('retiring worker concurrent close shares kill failure and retains failed notification', async () => {
  const old = workerFixture();
  const cleanup = new Error('retiring kill fixture'),
    notification = { failed: true };
  let kills = 0,
    spawns = 0;
  let closing: Promise<void> | undefined;
  let closeOutcome: Promise<{ value: void } | { error: unknown }> | undefined;
  old.worker.kill = () => {
    kills++;
    closing = lifecycle.close();
    closeOutcome = closing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    throw cleanup;
  };
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: {
      spawn() {
        spawns++;
        return workerFixture().worker;
      },
      payload: {},
    },
    emit(event, state) {
      if (event === 'state' && state === 'failed') throw notification;
    },
    forward() {},
    exportsUpdated() {},
  });
  const reconnect = lifecycle.reconnect({ method: 'quick', uin: '123' }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const reconnectOutcome = await reconnect;
  const result = await closeOutcome;
  assert.ok('error' in reconnectOutcome && reconnectOutcome.error === cleanup);
  assert.ok(result && 'error' in result && result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [cleanup, notification]);
  assert.equal(lifecycle.close(), closing);
  assert.equal(kills, 1);
  assert.equal(spawns, 0);
  assert.equal(old.worker.exitCode, null);
});

for (const cleanup of [{ opaqueCleanup: true }, undefined]) {
  test(`close without failed notification error retains ${cleanup === undefined ? 'undefined' : 'opaque'} cleanup identity`, async () => {
    const f = workerFixture();
    let kills = 0;
    f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
      callback(new Error('close IPC fixture'));
      return true;
    }) as typeof f.worker.send;
    f.worker.kill = () => {
      kills++;
      throw cleanup;
    };
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      emit() {},
      forward() {},
      exportsUpdated() {},
    });
    const closing = lifecycle.close();
    const outcome = await closing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert.deepEqual(outcome, { error: cleanup });
    assert.equal(lifecycle.close(), closing);
    assert.equal(kills, 1);
    assert.equal(lifecycle.state, 'failed');
  });
}

for (const row of [
  { phase: 'ipc', observer: 'error' },
  { phase: 'ipc', observer: 'opaque' },
  { phase: 'ipc', observer: 'undefined' },
  { phase: 'connecting', observer: 'error' },
  { phase: 'opaque', observer: 'none' },
  { phase: 'undefined', observer: 'none' },
] as const) {
  test(`login ${row.phase} failure retains primary and ${row.observer} idle observer on shared promise`, async () => {
    const f = workerFixture();
    const primary: unknown =
      row.phase === 'opaque'
        ? { connecting: true }
        : row.phase === 'undefined'
          ? undefined
          : new Error('login primary fixture');
    const notification: unknown =
      row.observer === 'error'
        ? new Error('idle observer fixture')
        : row.observer === 'opaque'
          ? { idle: true }
          : undefined;
    const callbacks: ((error: Error | null) => void)[] = [];
    const send = f.worker.send.bind(f.worker);
    f.worker.send = ((
      message: { id: number; method: string },
      callback: (error: Error | null) => void,
    ) => {
      if (message.method === 'login') {
        f.sent.push(message);
        callbacks.push(callback);
        return true;
      }
      return send(message, callback);
    }) as typeof f.worker.send;
    let failing = true;
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      emit(event, state) {
        if (event !== 'state' || !failing) return;
        if (state === 'connecting' && row.phase !== 'ipc') throw primary;
        if (state === 'idle' && row.observer !== 'none') throw notification;
      },
      forward() {},
      exportsUpdated() {},
    });
    const first = lifecycle.login({ method: 'quick', uin: '123' });
    assert.equal(lifecycle.login({ method: 'quick', uin: '123' }), first);
    const observed = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (row.phase === 'ipc') {
      assert.ok(primary instanceof Error);
      callbacks[0](primary);
    }
    try {
      const result = await observed;
      assert.ok('error' in result);
      if (row.observer === 'none') assert.equal(result.error, primary);
      else {
        assert.ok(result.error instanceof AggregateError);
        assert.deepEqual(result.error.errors, [primary, notification]);
      }
      assert.equal(
        f.sent.filter((sent) => sent.method === 'login').length,
        row.phase === 'ipc' ? 1 : 0,
      );
      assert.equal(lifecycle.state, 'idle');
      if (row.phase === 'ipc' && row.observer === 'error') {
        failing = false;
        const retry = lifecycle.login({ method: 'quick', uin: '123' });
        assert.notEqual(retry, first);
        const sent = f.sent.at(-1);
        assert.ok(sent && sent.method === 'login');
        const account = { uin: '123', uid: 'u_recovery' };
        callbacks.at(-1)?.(null);
        f.events.emit('message', { event: 'ready', payload: account });
        f.events.emit('message', { id: sent.id, result: account });
        assert.deepEqual(await retry, account);
        assert.equal(callbacks.length, 2);
      }
    } finally {
      failing = false;
      await lifecycle.close();
    }
  });
}

for (const action of ['login', 'close', 'reconnect'] as const) {
  test(`idle observer ${action} ownership survives original login rejection and notification failure`, async () => {
    const f = workerFixture(),
      next = workerFixture();
    const primary = new Error('login IPC fixture'),
      notification = new Error('idle notification fixture');
    const callbacks: ((error: Error | null) => void)[] = [];
    const send = f.worker.send.bind(f.worker);
    f.worker.send = ((
      message: { id: number; method: string },
      callback: (error: Error | null) => void,
    ) => {
      if (message.method === 'login') {
        f.sent.push(message);
        callbacks.push(callback);
        return true;
      }
      return send(message, callback);
    }) as typeof f.worker.send;
    const nextSend = next.worker.send.bind(next.worker);
    next.worker.send = ((
      message: { id: number; method: string },
      callback: (error: Error | null) => void,
    ) => {
      const result = nextSend(message, callback);
      if (message.method === 'login')
        queueMicrotask(() => {
          const account = { uin: '456', uid: 'u_next' };
          next.events.emit('message', { event: 'ready', payload: account });
          next.events.emit('message', { id: message.id, result: account });
        });
      return result;
    }) as typeof next.worker.send;
    let armed = true,
      spawns = 0;
    let nested: Promise<unknown> | undefined;
    let nestedObserved: Promise<unknown> | undefined;
    const lifecycle = new ClientLifecycle({
      worker: f.worker,
      timeout: 1000,
      restart: {
        spawn() {
          spawns++;
          return next.worker;
        },
        payload: {},
      },
      emit(event, state) {
        if (!armed || event !== 'state' || state !== 'idle') return;
        armed = false;
        nested =
          action === 'login'
            ? lifecycle.login({ method: 'quick', uin: '456' })
            : action === 'close'
              ? lifecycle.close()
              : lifecycle.reconnect({ method: 'quick', uin: '456' });
        nestedObserved = nested.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        throw notification;
      },
      forward() {},
      exportsUpdated() {},
    });
    const login = lifecycle.login({ method: 'quick', uin: '123' });
    const observed = login.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    callbacks[0](primary);
    try {
      const result = await observed;
      assert.ok('error' in result && result.error instanceof AggregateError);
      assert.deepEqual(result.error.errors, [primary, notification]);
      assert.ok(nested);
      assert.equal(lifecycle.state, action === 'close' ? 'closing' : 'connecting');
      if (action === 'login') {
        assert.equal(lifecycle.login({ method: 'quick', uin: '456' }), nested);
        const sent = f.sent.at(-1);
        assert.ok(sent && sent.method === 'login');
        callbacks[1](null);
        const account = { uin: '456', uid: 'u_next' };
        f.events.emit('message', { event: 'ready', payload: account });
        f.events.emit('message', { id: sent.id, result: account });
        assert.deepEqual(await nested, account);
        assert.equal(spawns, 0);
      } else {
        await nested;
        assert.equal(lifecycle.state, action === 'close' ? 'closed' : 'online');
        assert.equal(spawns, action === 'close' ? 0 : 1);
      }
    } finally {
      await lifecycle.close();
      await nestedObserved;
    }
  });
}
