import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

async function fixture(sessionExports: Record<string, any>, startupExports?: Record<string, any>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-session-strategy-'));
  let loginListener: any;
  const events: string[] = [];
  const login = {
    initConfig() {},
    addKernelLoginListener(value: any) {
      loginListener = value;
    },
    connect() {
      loginListener.onLoginConnected();
    },
    getMsfStatus: () => 0,
    getQRCodePicture() {
      loginListener.onQRCodeLoginSucceed({ uin: '123', uid: 'u_fixture' });
      return true;
    },
    getMachineGuid: () => '0123456789abcdef0123456789abcdef',
  };
  const kernel = createKernel(
    {
      NodeIQQNTWrapperEngine: {
        get: () => ({
          initWithDeskTopConfig() {
            events.push('engine-init');
          },
        }),
      },
      NodeIKernelLoginService: { get: () => login },
      ...(startupExports ? { NodeIQQNTStartupSessionWrapper: startupExports } : {}),
      NodeIQQNTWrapperSession: sessionExports,
    },
    {
      dataDir,
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      loginTimeoutMs: 500,
    },
    (event) => events.push(event),
  );
  return {
    kernel,
    events,
    async close() {
      await kernel.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

for (const failureAt of ['startup-create', 'account-get'] as const) {
  test(`selected startup strategy preserves ${failureAt} failure without falling back`, async () => {
    const calls: string[] = [];
    const failure = Object.assign(new Error('fixture native creation failure'), { code: -7001 });
    const f = await fixture(
      {
        getNTWrapperSession(name: string) {
          calls.push(`get:${name}`);
          if (failureAt === 'account-get') throw failure;
          return {};
        },
        create() {
          calls.push('fallback-create');
          return {};
        },
      },
      {
        create() {
          calls.push('startup-create');
          if (failureAt === 'startup-create') throw failure;
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
        failureAt === 'startup-create' ? ['startup-create'] : ['startup-create', 'get:nt_1'],
      );
      assert.equal(f.events.includes('engine-init'), false);
    } finally {
      await f.close();
    }
  });
}

test('direct Session startup failure preserves native error and never retries without arguments', async () => {
  const calls: unknown[][] = [];
  let sessionListener: any;
  const failure = Object.assign(new Error('fixture dispatched startNT failure'), { code: -7002 });
  const session = {
    init(_config: any, _depends: any, _dispatcher: any, listener: any) {
      sessionListener = listener;
    },
    startNT(...args: unknown[]) {
      calls.push(args);
      if (args.length) throw failure;
      sessionListener.onOpentelemetryInit({ is_init: true });
    },
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
  };
  const f = await fixture({ create: () => session });
  try {
    await assert.rejects(f.kernel.login({ method: 'qr' }), (error) => error === failure);
    assert.deepEqual(calls, [[0]]);
    assert.equal(f.events.includes('ready'), false);
    assert.equal(f.events.includes('login'), false);
  } finally {
    await f.close();
  }
});

test('a partial startup surface selects direct create before invoking any startup factory', async () => {
  const calls: string[] = [];
  const f = await fixture(
    {
      create() {
        calls.push('direct-create');
        return {};
      },
    },
    {
      create() {
        calls.push('unused-startup-create');
        return {};
      },
    },
  );
  try {
    await f.kernel.prepare();
    assert.deepEqual(calls, ['direct-create']);
  } finally {
    await f.close();
  }
});

test('unsupported session creation surface rejects before invoking a startup factory', async () => {
  let calls = 0;
  const f = await fixture(
    {},
    {
      create() {
        calls++;
        return {};
      },
    },
  );
  try {
    await assert.rejects(f.kernel.prepare(), /session|Session/);
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

for (const strategy of ['startup', 'direct'] as const) {
  for (const readyAt of ['init', 'start'] as const) {
    test(`${strategy}: reentrant ${readyAt} readiness cannot mask a startup throw`, async () => {
      let listener: any;
      let starts = 0;
      const failure = Object.assign(new Error('fixture start failed after readiness'), {
        code: -7012,
      });
      const start = () => {
        starts++;
        if (readyAt === 'start') listener.onOpentelemetryInit({ is_init: true });
        throw failure;
      };
      const session = {
        init(_config: any, _depends: any, _dispatcher: any, callback: any) {
          listener = callback;
          if (readyAt === 'init') listener.onOpentelemetryInit({ is_init: true });
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
        await assert.rejects(f.kernel.login({ method: 'qr' }), (error) => error === failure);
        assert.equal(starts, 1);
        assert.equal(f.events.includes('login'), false);
        assert.equal(f.events.includes('ready'), false);
        await assert.rejects(f.kernel.invokeOperation('listFriends'), /not online/);
      } finally {
        await f.close();
      }
    });
  }
  test(`${strategy}: init readiness waits for successful start return`, async () => {
    let starts = 0;
    const session = {
      init(_config: any, _depends: any, _dispatcher: any, listener: any) {
        listener.onOpentelemetryInit({ is_init: true });
      },
      startNT() {
        starts++;
      },
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
    };
    const f = await fixture(
      { create: () => session, getNTWrapperSession: () => session },
      strategy === 'startup'
        ? {
            create: () => ({
              start() {
                starts++;
              },
            }),
          }
        : undefined,
    );
    try {
      assert.deepEqual(await f.kernel.login({ method: 'qr' }), { uin: '123', uid: 'u_fixture' });
      assert.equal(starts, 1);
      assert.equal(f.events.filter((v) => v === 'ready').length, 1);
    } finally {
      await f.close();
    }
  });
  for (const completion of ['reject', 'close'] as const) {
    test(`${strategy}: pending start ${completion} cannot publish buffered readiness`, async () => {
      let listener: any;
      let release!: (value?: unknown) => void;
      let rejectStart!: (error: Error) => void;
      let began!: () => void;
      const starting = new Promise<void>((resolve) => {
        began = resolve;
      });
      const startResult = new Promise((resolve, reject) => {
        release = resolve;
        rejectStart = reject;
      });
      const failure = Object.assign(new Error('fixture asynchronous Session start failed'), {
        code: -7013,
      });
      let starts = 0;
      const start = () => {
        starts++;
        listener.onOpentelemetryInit({ is_init: true });
        began();
        return startResult;
      };
      const session = {
        init(_config: any, _depends: any, _dispatcher: any, callback: any) {
          listener = callback;
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
        const login = f.kernel.login({ method: 'qr' });
        await starting;
        assert.equal(f.events.includes('ready'), false);
        if (completion === 'reject') {
          rejectStart(failure);
          await assert.rejects(login, (error) => error === failure);
        } else {
          await f.kernel.close();
          await assert.rejects(login, /closed/i);
          release();
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(starts, 1);
        assert.equal(f.events.includes('login'), false);
        assert.equal(f.events.includes('ready'), false);
      } finally {
        await f.close();
      }
    });
  }
}
