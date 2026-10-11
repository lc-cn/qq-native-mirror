import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelEnvironment } from '../src/runtime/kernel-environment.ts';

for (const stage of [
  'engine-get',
  'login-get',
  'session-create',
  'engine-init',
  'login-config',
  'login-listener',
] as const) {
  for (const behavior of ['capture', 'close', 'throw'] as const) {
    test(`environment ${stage}: ${behavior} during method capture`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qq-environment-capture-'));
      let closed = false;
      let reads = 0;
      let dispatches = 0;
      const original = new Error('fixture getter failure');
      const engine = { initWithDeskTopConfig() {} };
      const login = { initConfig() {}, addKernelLoginListener() {} };
      const engineFactory = { get: () => engine };
      const loginFactory = { get: () => login };
      const sessionFactory = { create: () => ({}) };
      const [receiver, name, result] = {
        'engine-get': [engineFactory, 'get', engine],
        'login-get': [loginFactory, 'get', login],
        'session-create': [sessionFactory, 'create', {}],
        'engine-init': [engine, 'initWithDeskTopConfig', undefined],
        'login-config': [login, 'initConfig', undefined],
        'login-listener': [login, 'addKernelLoginListener', undefined],
      }[stage];
      Object.defineProperty(receiver, name as string, {
        get() {
          reads++;
          if (behavior === 'throw') throw original;
          if (behavior === 'close') closed = true;
          return function (this: unknown) {
            assert.equal(this, receiver);
            assert.equal(reads, 1, 'The selected method must never be read again.');
            dispatches++;
            return result;
          };
        },
      });
      const environment = createKernelEnvironment({
        wrapper: {
          NodeIQQNTWrapperEngine: engineFactory,
          NodeIKernelLoginService: loginFactory,
          NodeIQQNTWrapperSession: sessionFactory,
        },
        options: {
          dataDir: dir,
          version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
        },
        isClosed: () => closed,
        diagnostic() {},
        engineCallbacks: () => ({}),
        loginCallbacks: () => ({}),
        onAcquired() {},
      });
      try {
        const pending = environment.prepare();
        if (behavior === 'capture') await pending;
        else if (behavior === 'close') await assert.rejects(pending, /Client is closed/);
        else await assert.rejects(pending, (error) => error === original);
        assert.equal(reads, 1);
        assert.equal(dispatches, behavior === 'capture' ? 1 : 0);
        assert.equal(
          environment.prepare(),
          pending,
          'Failure must not trigger another preparation.',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test('startup selection captures both factories once and never falls back after dispatch failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-environment-strategy-'));
  const failure = new Error('fixture dispatched factory failure');
  let startupReads = 0;
  let accountReads = 0;
  let fallbackCalls = 0;
  const startup = {
    get create() {
      startupReads++;
      return function (this: unknown) {
        assert.equal(this, startup);
        throw failure;
      };
    },
  };
  const account = {
    get getNTWrapperSession() {
      accountReads++;
      return () => ({});
    },
    create() {
      fallbackCalls++;
      return {};
    },
  };
  const environment = createKernelEnvironment({
    wrapper: {
      NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
      NodeIKernelLoginService: { get: () => ({ initConfig() {}, addKernelLoginListener() {} }) },
      NodeIQQNTStartupSessionWrapper: startup,
      NodeIQQNTWrapperSession: account,
    },
    options: { dataDir: dir, version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' } },
    isClosed: () => false,
    diagnostic() {},
    engineCallbacks: () => ({}),
    loginCallbacks: () => ({}),
    onAcquired() {
      assert.fail('Failed factory must not publish handles.');
    },
  });
  try {
    await assert.rejects(environment.prepare(), (error) => error === failure);
    assert.equal(startupReads, 1);
    assert.equal(accountReads, 1);
    assert.equal(fallbackCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const failure of [undefined, 'engine', 'config', 'listener']) {
  test(`environment publishes before initialization and never replays: ${failure}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-environment-'));
    const calls: string[] = [];
    let published = false;
    const primary = new Error('fixture failure');
    const step = (name: string) => {
      calls.push(name);
      assert.equal(published, true);
      if (failure === name) throw primary;
    };
    const login = {
      initConfig() {
        step('config');
      },
      addKernelLoginListener() {
        step('listener');
      },
    };
    const account = {};
    const environment = createKernelEnvironment({
      wrapper: {
        NodeIQQNTWrapperEngine: {
          get: () => ({
            initWithDeskTopConfig() {
              step('engine');
            },
          }),
        },
        NodeIKernelLoginService: { get: () => login },
        NodeIQQNTWrapperSession: { create: () => account },
      },
      options: { dataDir: dir, version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' } },
      isClosed: () => false,
      diagnostic() {},
      engineCallbacks: () => ({}),
      loginCallbacks: () => {
        step('callbacks');
        return {};
      },
      onAcquired(value) {
        assert.equal(value.loginService, login);
        assert.equal(value.accountSession, account);
        assert.equal(value.sessionStrategy, 'direct');
        published = true;
      },
    });
    try {
      const first = environment.prepare();
      assert.equal(environment.prepare(), first);
      if (failure) await assert.rejects(first, (error) => error === primary);
      else await first;
      assert.equal(environment.prepare(), first);
      assert.deepEqual(
        calls,
        failure === 'engine'
          ? ['engine']
          : failure === 'config'
            ? ['engine', 'config']
            : ['engine', 'config', 'callbacks', 'listener'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('environment observes close after mkdir before acquiring native factories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-environment-'));
  let checks = 0;
  let acquired = 0;
  const environment = createKernelEnvironment({
    wrapper: {
      NodeIQQNTWrapperEngine: {
        get() {
          acquired++;
        },
      },
    },
    options: { dataDir: dir, version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' } },
    isClosed: () => ++checks > 1,
    diagnostic() {},
    engineCallbacks: () => ({}),
    loginCallbacks: () => ({}),
    onAcquired() {},
  });
  try {
    await assert.rejects(environment.prepare(), /Client is closed/);
    assert.equal(acquired, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rememberPassword invalidity remains after config but before listener construction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-environment-'));
  const calls: string[] = [];
  const environment = createKernelEnvironment({
    wrapper: {
      NodeIQQNTWrapperEngine: {
        get: () => ({
          initWithDeskTopConfig() {
            calls.push('engine');
          },
        }),
      },
      NodeIKernelLoginService: {
        get: () => ({
          initConfig() {
            calls.push('config');
          },
        }),
      },
      NodeIQQNTWrapperSession: { create: () => ({}) },
    },
    options: {
      dataDir: dir,
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      rememberPassword: 'invalid' as unknown as boolean,
    },
    isClosed: () => false,
    diagnostic() {},
    engineCallbacks: () => ({}),
    loginCallbacks: () => {
      calls.push('listener');
      return {};
    },
    onAcquired() {},
  });
  try {
    await assert.rejects(environment.prepare(), /rememberPassword must be boolean/);
    assert.deepEqual(calls, ['engine', 'config']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('synchronous registration callback sees acquired handles and reentrant prepare shares promise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-environment-'));
  const account = {};
  let acquired: { loginService: unknown; accountSession: unknown } | undefined;
  let callbackCount = 0;
  let reentrant: Promise<void> | undefined;
  const login = {
    initConfig() {},
    getMsfStatus() {
      return 3;
    },
    addKernelLoginListener(listener: { onLoginConnected(): void }) {
      listener.onLoginConnected();
    },
  };
  const environment = createKernelEnvironment({
    wrapper: {
      NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
      NodeIKernelLoginService: { get: () => login },
      NodeIQQNTWrapperSession: { create: () => account },
    },
    options: { dataDir: dir, version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' } },
    isClosed: () => false,
    diagnostic() {},
    engineCallbacks: () => ({}),
    onAcquired(value) {
      acquired = value;
    },
    loginCallbacks: () => ({
      onLoginConnected() {
        assert.equal(acquired?.loginService, login);
        assert.equal(acquired?.accountSession, account);
        assert.equal(login.getMsfStatus.call(acquired?.loginService), 3);
        reentrant = environment.prepare();
        callbackCount++;
      },
    }),
  });
  try {
    const first = environment.prepare();
    await first;
    assert.equal(reentrant, first);
    assert.equal(callbackCount, 1);
    assert.equal(environment.prepare(), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
