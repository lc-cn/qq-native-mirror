import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationAttempt,
  type AuthenticationLoginPort,
} from '../src/runtime/authentication-attempt.ts';
import type { LoginRequest } from '../src/contracts/client.ts';
import type { NativeObject } from '../src/native/native-object.ts';

function fixture(
  request: LoginRequest = { method: 'qr' },
  service: NativeObject = {},
  acquire: () => AuthenticationLoginPort | undefined = () => service,
) {
  let current = true;
  const failures: Error[] = [];
  const events: string[] = [];
  const attempt = new AuthenticationAttempt({
    request,
    timeoutMs: 1000,
    prepare: async () => {},
    loginService: acquire,
    isCurrent: () => current,
    notify: (event) => {
      events.push(event);
    },
    failed: (error) => {
      failures.push(error);
      attempt.invalidate();
      attempt.reject(error);
    },
  });
  return {
    attempt,
    failures,
    events,
    retire: () => {
      current = false;
      attempt.invalidate();
    },
  };
}

const invocationCases: readonly {
  method: keyof AuthenticationLoginPort;
  request: LoginRequest;
  result: unknown;
  args: readonly unknown[];
}[] = [
  { method: 'connect', request: { method: 'qr' }, result: undefined, args: [] },
  { method: 'getMsfStatus', request: { method: 'qr' }, result: 0, args: [] },
  { method: 'getQRCodePicture', request: { method: 'qr' }, result: true, args: [] },
  {
    method: 'getLoginList',
    request: { method: 'restore' },
    result: { LocalLoginInfoList: [{ uin: '123', isQuickLogin: true }] },
    args: [],
  },
  {
    method: 'quickLoginWithUin',
    request: { method: 'quick', uin: '123' },
    result: { result: '0' },
    args: ['123'],
  },
];

for (const { method, request, result, args } of invocationCases) {
  test(`${method} captures one callable and retains its native receiver and arguments`, async () => {
    let reads = 0;
    const calls: { receiver: unknown; args: unknown[] }[] = [];
    const service: AuthenticationLoginPort = {
      getMsfStatus: () => 0,
      getQRCodePicture: () => true,
      quickLoginWithUin: () => ({ result: '0' }),
    };
    Object.defineProperty(service, method, {
      get() {
        reads++;
        if (reads > 1) throw new Error('Native method was acquired twice');
        return function (this: unknown, ...actual: unknown[]) {
          calls.push({ receiver: this, args: actual });
          return result;
        };
      },
    });
    const f = fixture(request, service);
    try {
      await (method === 'connect' ? f.attempt.begin() : f.attempt.onConnected());
      assert.equal(reads, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.receiver, service);
      assert.deepEqual(calls[0]!.args, args);
      assert.deepEqual(f.failures, []);
    } finally {
      f.retire();
    }
  });

  for (const throws of [false, true]) {
    test(`${method} acquisition retirement${throws ? ' followed by a throw' : ''} prevents dispatch`, async () => {
      let calls = 0;
      let reads = 0;
      const service: AuthenticationLoginPort = { getMsfStatus: () => 0 };
      Object.defineProperty(service, method, {
        get() {
          reads++;
          f.retire();
          if (throws) throw new Error('Retired native acquisition');
          return () => {
            calls++;
            return result;
          };
        },
      });
      const f = fixture(request, service);
      try {
        await (method === 'connect' ? f.attempt.begin() : f.attempt.onConnected());
        assert.equal(reads, 1);
        assert.equal(calls, 0);
        assert.deepEqual(f.failures, []);
      } finally {
        f.retire();
      }
    });
  }
}

test('service acquisition retirement prevents method lookup and native dispatch', async () => {
  let reads = 0;
  const service = Object.defineProperty({}, 'connect', {
    get() {
      reads++;
      throw new Error('Retired service was inspected');
    },
  });
  const f = fixture(undefined, {}, () => {
    f.retire();
    return service;
  });
  await f.attempt.begin();
  assert.equal(reads, 0);
  assert.deepEqual(f.failures, []);
});

test('an active native acquisition error keeps its original identity without retry', async () => {
  const failure = new Error('Native connect acquisition failed');
  let reads = 0;
  const service = Object.defineProperty({}, 'connect', {
    get() {
      reads++;
      throw failure;
    },
  });
  const f = fixture(undefined, service);
  await f.attempt.begin();
  await assert.rejects(f.attempt.result, (error) => error === failure);
  assert.deepEqual(f.failures, [failure]);
  assert.equal(reads, 1);
});

test('authentication only validates identity; Session readiness owns result settlement', async () => {
  const f = fixture(undefined, { getMsfStatus: () => 0, getQRCodePicture: () => true });
  let settled = false;
  void f.attempt.result.then(() => {
    settled = true;
  });
  await f.attempt.onConnected();
  const identity = f.attempt.acceptAuthentication({ uin: '123', uid: 'u_test' });
  await Promise.resolve();
  assert.equal(settled, false);
  f.attempt.completeReady(identity);
  identity.uid = 'changed';
  assert.deepEqual(await f.attempt.result, { uin: '123', uid: 'u_test' });
});

test('issued request is recorded before synchronous native authentication', async () => {
  const service = {
    getMsfStatus: () => 0,
    getQRCodePicture() {
      assert.deepEqual(authentication.attempt.acceptAuthentication({ uin: '123', uid: 'u_test' }), {
        uin: '123',
        uid: 'u_test',
      });
      return true;
    },
  };
  const authentication = fixture(undefined, service);
  await authentication.attempt.onConnected();
  assert.equal(authentication.failures.length, 0);
  authentication.retire();
});

test('retirement while restore records are pending prevents quick-login and late failure', async () => {
  let resolve!: (value: unknown) => void;
  let calls = 0;
  const f = fixture(
    { method: 'restore' },
    {
      getMsfStatus: () => 0,
      getLoginList: () =>
        new Promise((done) => {
          resolve = done;
        }),
      quickLoginWithUin() {
        calls++;
      },
    },
  );
  const connected = f.attempt.onConnected();
  f.retire();
  resolve({ LocalLoginInfoList: [{ uin: '123', isQuickLogin: true }] });
  await connected;
  assert.equal(calls, 0);
  assert.equal(f.failures.length, 0);
});

test('begin skips connect after prepare completes for a retired attempt', async () => {
  let resolve!: () => void;
  let calls = 0;
  let current = true;
  const attempt = new AuthenticationAttempt({
    request: { method: 'qr' },
    timeoutMs: 1000,
    prepare: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    loginService: () => ({
      connect() {
        calls++;
      },
    }),
    isCurrent: () => current,
    notify: () => {},
    failed: () => {
      assert.fail('late failure');
    },
  });
  const beginning = attempt.begin();
  current = false;
  attempt.invalidate();
  resolve();
  await beginning;
  assert.equal(calls, 0);
});

test('failed prepare rejects once with original normalized Error and no connect', async () => {
  const error = new Error('prepare failed');
  let calls = 0;
  const failures: Error[] = [];
  const attempt = new AuthenticationAttempt({
    request: { method: 'qr' },
    timeoutMs: 1000,
    prepare: async () => {
      throw error;
    },
    loginService: () => ({
      connect() {
        calls++;
      },
    }),
    isCurrent: () => true,
    notify: () => {},
    failed: (value) => {
      failures.push(value);
      attempt.reject(value);
    },
  });
  await attempt.begin();
  await assert.rejects(attempt.result, (value) => value === error);
  assert.deepEqual(failures, [error]);
  assert.equal(calls, 0);
});

test('reentrant diagnostic retirement prevents connect', async () => {
  let calls = 0;
  const attempt = new AuthenticationAttempt({
    request: { method: 'qr' },
    timeoutMs: 1000,
    prepare: async () => {},
    loginService: () => ({
      connect() {
        calls++;
      },
    }),
    isCurrent: () => true,
    notify: () => {
      attempt.invalidate();
    },
    failed: () => {},
  });
  await attempt.begin();
  assert.equal(calls, 0);
});

test('reentrant native status retirement prevents QR request', async () => {
  let calls = 0;
  const f = fixture(undefined, {
    getMsfStatus() {
      f.retire();
      return 0;
    },
    getQRCodePicture() {
      calls++;
    },
  });
  await f.attempt.onConnected();
  assert.equal(calls, 0);
});

test('restore trace retirement prevents quick login and preserves trace shape', async () => {
  const original = process.env.QQ_NATIVE_TRACE_FIELDS;
  process.env.QQ_NATIVE_TRACE_FIELDS = '1';
  let calls = 0;
  const stages: string[] = [];
  const attempt = new AuthenticationAttempt({
    request: { method: 'restore' },
    timeoutMs: 1000,
    prepare: async () => {},
    loginService: () => ({
      getMsfStatus: () => 0,
      getLoginList: () => ({ LocalLoginInfoList: [{ uin: '123', isQuickLogin: true }] }),
      quickLoginWithUin() {
        calls++;
      },
    }),
    isCurrent: () => true,
    notify: (_event, payload) => {
      stages.push((payload as { stage: string }).stage);
      attempt.invalidate();
    },
    failed: () => {},
  });
  try {
    await attempt.onConnected();
    assert.equal(calls, 0);
    assert.match(stages[0], /^restore-records:/);
    assert.deepEqual(JSON.parse(stages[0].slice('restore-records:'.length)).quickLoginFlags, [
      true,
    ]);
  } finally {
    attempt.invalidate();
    if (original === undefined) delete process.env.QQ_NATIVE_TRACE_FIELDS;
    else process.env.QQ_NATIVE_TRACE_FIELDS = original;
  }
});

test('retired quick-login rejection is observed without failing the replacement', async () => {
  let reject!: (error: Error) => void;
  const f = fixture(
    { method: 'quick', uin: '123' },
    {
      getMsfStatus: () => 0,
      quickLoginWithUin: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    },
  );
  const connected = f.attempt.onConnected();
  f.retire();
  const replacement = fixture();
  reject(new Error('late quick rejection'));
  await connected;
  assert.equal(f.failures.length, 0);
  assert.equal(replacement.failures.length, 0);
  replacement.retire();
});

test('repeated connecting status retains only one poll and invalidation clears it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let statusCalls = 0;
  const f = fixture(undefined, {
    getMsfStatus() {
      statusCalls++;
      return 3;
    },
  });
  await f.attempt.onConnected();
  await f.attempt.onConnected();
  t.mock.timers.tick(500);
  assert.equal(statusCalls, 3);
  f.retire();
  t.mock.timers.tick(2000);
  assert.equal(statusCalls, 3);
  assert.equal(f.failures.length, 0);
});
