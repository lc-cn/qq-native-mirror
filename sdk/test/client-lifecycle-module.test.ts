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
