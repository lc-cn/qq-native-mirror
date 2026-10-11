import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed compiled kernel, fake native services, real isolated directories.
 * @param {string} packageRoot
 * No addon, account credentials, network, authentication or native start call.
 */
export async function verifyKernelSessionConsumer(packageRoot) {
  /** @type {Promise<typeof import('../../src/kernel.ts')>} */
  const kernelModule = import(pathToFileURL(join(packageRoot, 'dist/kernel.js')).href);
  const { createKernel } = await kernelModule;
  /**
   * @param {{create?:()=>unknown,getNTWrapperSession?:(name:string)=>unknown}} accountFactory
   * @param {{create:()=>unknown}|undefined} [startupFactory]
   * @param {unknown} [loginFailure]
   * @param {(name:string,payload:unknown)=>void} [onEvent]
   */
  async function fixture(accountFactory, startupFactory, loginFailure, onEvent) {
    const dataDir = await mkdtemp(join(tmpdir(), 'qq-installed-session-'));
    /** @type {{onLoginConnected():void,onLoginFailed(value:unknown):void,onQRCodeLoginSucceed(value:{uin:string,uid:string}):void}|undefined} */
    let loginListener;
    /** @type {string[]} */
    const events = [];
    /** @type {string[]} */
    const dispatches = [];
    const service = {
      initConfig() {},
      addKernelLoginListener(/** @type {NonNullable<typeof loginListener>} */ value) {
        loginListener = value;
      },
      connect() {
        dispatches.push('connect');
        assert.ok(loginListener);
        loginListener.onLoginConnected();
      },
      getMsfStatus: () => 0,
      getQRCodePicture() {
        dispatches.push('qr');
        assert.ok(loginListener);
        if (loginFailure !== undefined) {
          loginListener.onLoginFailed(loginFailure);
          return true;
        }
        loginListener.onQRCodeLoginSucceed({ uin: '123', uid: 'u_fake' });
        return true;
      },
      getMachineGuid: () => '0123456789abcdef0123456789abcdef',
    };
    const kernel = createKernel(
      {
        NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
        NodeIKernelLoginService: { get: () => service },
        NodeIQQNTWrapperSession: accountFactory,
        ...(startupFactory ? { NodeIQQNTStartupSessionWrapper: startupFactory } : {}),
      },
      {
        dataDir,
        version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
        loginTimeoutMs: 500,
      },
      (name, payload) => {
        events.push(name);
        onEvent?.(name, payload);
      },
    );
    return {
      kernel,
      events,
      service,
      dispatches,
      async close() {
        await kernel.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  }
  for (const failureAt of ['create', 'get']) {
    /** @type {unknown[][]} */
    const calls = [];
    const failure = Object.assign(new Error('mock native creation rejected'), { code: -7010 });
    const f = await fixture(
      {
        getNTWrapperSession(/** @type {string} */ name) {
          calls.push(['get', name]);
          if (failureAt === 'get') throw failure;
          return {};
        },
        create() {
          calls.push(['fallback']);
          return {};
        },
      },
      {
        create() {
          calls.push(['create']);
          if (failureAt === 'create') throw failure;
          return {};
        },
      },
    );
    try {
      const prepared = f.kernel.prepare();
      await assert.rejects(prepared, (error) => error === failure);
      assert.equal(f.kernel.prepare(), prepared);
      await assert.rejects(f.kernel.prepare(), (error) => error === failure);
      assert.deepEqual(
        calls,
        failureAt === 'create' ? [['create']] : [['create'], ['get', 'nt_1']],
      );
    } finally {
      await f.close();
    }
  }
  for (const strategy of ['direct', 'startup']) {
    /** @type {unknown[][]} */
    const starts = [];
    /** @type {{onOpentelemetryInit(value:{is_init:boolean}):void}|undefined} */
    let listener;
    const failure = Object.assign(new Error('mock dispatched Session start rejected'), {
      code: -7011,
    });
    const session = {
      init(
        /** @type {unknown} */ _config,
        /** @type {unknown} */ _depends,
        /** @type {unknown} */ _dispatcher,
        /** @type {NonNullable<typeof listener>} */ callback,
      ) {
        listener = callback;
      },
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      startNT(/** @type {unknown[]} */ ...args) {
        starts.push(['direct', ...args]);
        assert.ok(listener);
        listener.onOpentelemetryInit({ is_init: true });
        if (args.length) throw failure;
      },
    };
    const f = await fixture(
      { create: () => session, getNTWrapperSession: () => session },
      strategy === 'startup'
        ? {
            create: () => ({
              start() {
                starts.push(['startup']);
                assert.ok(listener);
                listener.onOpentelemetryInit({ is_init: true });
                throw failure;
              },
            }),
          }
        : undefined,
    );
    try {
      await assert.rejects(f.kernel.login({ method: 'qr' }), (error) => error === failure);
      assert.deepEqual(starts, strategy === 'startup' ? [['startup']] : [['direct', 0]]);
      assert.equal(f.events.includes('ready'), false);
      assert.equal(f.events.includes('login'), false);
    } finally {
      await f.close();
    }
  }
  for (const strategy of ['startup', 'direct']) {
    for (const rejects of [false, true]) {
      let starts = 0;
      const failure = new Error('mock asynchronous start rejection');
      const start = () => {
        starts++;
        return rejects ? Promise.reject(failure) : undefined;
      };
      const session = {
        init(
          /** @type {unknown} */ _config,
          /** @type {unknown} */ _depends,
          /** @type {unknown} */ _dispatcher,
          /** @type {{onOpentelemetryInit(value:{is_init:boolean}):void}} */ listener,
        ) {
          assert.ok(listener);
          listener.onOpentelemetryInit({ is_init: true });
        },
        startNT: start,
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
      };
      const f = await fixture(
        { create: () => session, getNTWrapperSession: () => session },
        strategy === 'startup' ? { create: () => ({ start }) } : undefined,
      );
      try {
        const result = f.kernel.login({ method: 'qr' });
        if (rejects) {
          await assert.rejects(result, (error) => error === failure);
          assert.equal(f.events.includes('ready'), false);
        } else {
          assert.deepEqual(await result, { uin: '123', uid: 'u_fake' });
          assert.equal(f.events.filter((name) => name === 'ready').length, 1);
        }
        assert.equal(starts, 1);
      } finally {
        await f.close();
      }
    }
  }
  /** @type {string[]} */
  const calls = [];
  const partial = await fixture(
    {
      create() {
        calls.push('direct');
        return {};
      },
    },
    {
      create() {
        calls.push('partial-startup');
        return {};
      },
    },
  );
  try {
    await partial.kernel.prepare();
    assert.deepEqual(calls, ['direct']);
  } finally {
    await partial.close();
  }
  const unsupported = await fixture(
    {},
    {
      create() {
        calls.push('unsupported-startup');
        return {};
      },
    },
  );
  try {
    await assert.rejects(unsupported.kernel.prepare(), /Session/);
    assert.deepEqual(calls, ['direct']);
  } finally {
    await unsupported.close();
  }
  /** @type {{self?:unknown}} */
  const circular = {};
  circular.self = circular;
  for (const payload of [
    circular,
    1n,
    {
      toJSON() {
        throw new Error('Opaque payload must not be evaluated');
      },
    },
    'SYNTHETIC_PRIVATE_VALUE',
  ]) {
    const f = await fixture({ create: () => ({}) }, undefined, payload);
    try {
      const prepared = f.kernel.prepare();
      assert.equal(f.kernel.prepare(), prepared);
      await prepared;
      await assert.rejects(f.kernel.login({ method: 'qr' }), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Native login failed');
        return true;
      });
      assert.equal(f.events.filter((name) => name === 'login-error').length, 1);
      assert.equal(f.events.includes('authenticated'), false);
      assert.equal(f.events.includes('ready'), false);
    } finally {
      await f.close();
    }
  }
  for (const stage of ['login-connect', 'msf-status']) {
    /** @type {Promise<void>|undefined} */
    let closing;
    const close = () => {
      closing = f.kernel.close();
      // The reentrant caller cannot await; retain and observe its completion.
      closing.catch(() => {});
    };
    const f = await fixture({ create: () => ({}) }, undefined, undefined, (name, payload) => {
      if (
        stage === 'login-connect' &&
        name === 'diagnostic' &&
        payload !== null &&
        typeof payload === 'object' &&
        'stage' in payload &&
        payload.stage === stage
      )
        close();
    });
    if (stage === 'msf-status')
      f.service.getMsfStatus = () => {
        close();
        return 0;
      };
    try {
      // Isolate reentrant retirement from cold directory/environment preparation.
      // The login deadline intentionally includes prepare in production; this
      // fixture asserts dispatch ordering once its local environment is ready.
      await f.kernel.prepare();
      assert.deepEqual(f.dispatches, []);
      await assert.rejects(f.kernel.login({ method: 'qr' }), /Client closed during login/);
      assert.deepEqual(
        f.dispatches,
        stage === 'login-connect' ? [] : ['connect'],
        `Reentrant retirement at ${stage} must prevent subsequent native dispatch`,
      );
      assert.equal(f.events.includes('authenticated'), false);
      assert.equal(f.events.includes('ready'), false);
    } finally {
      await closing;
      await f.close();
    }
  }
  return {
    sessionStrategyContract: true,
    opaqueLoginFailureContract: true,
    authenticationRetirementContract: true,
    nativeSessionStrategyLoginAttempted: false,
  };
}
