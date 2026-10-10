import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

test('login resolves only after account session readiness, with isolated paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-kernel-'));
  const calls: string[] = [];
  let listener: any;
  let sessionListener: any;
  let sessionConfig: any;
  const service = {
    initConfig(config: any) {
      assert.equal(config.commonPath, join(dataDir, 'global'));
    },
    addKernelLoginListener(value: any) {
      listener = value;
    },
    connect() {
      listener.onLoginConnected();
    },
    getMsfStatus() {
      return 0;
    },
    getQRCodePicture() {
      calls.push('qr');
      listener.onQRCodeGetPicture({
        pngBase64QrcodeData: 'data:image/png;base64,aGk=',
        qrcodeUrl: 'https://example.test/qr',
      });
      listener.onQRCodeLoginSucceed({ uid: 'uid-test', uin: '123' });
      return true;
    },
    getMachineGuid() {
      return '0123456789abcdef0123456789abcdef';
    },
  };
  const session = {
    getBuddyService: () => ({
      addKernelBuddyListener() {
        return 1;
      },
    }),
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    init(config: any, _a: any, _b: any, callback: any) {
      sessionConfig = config;
      sessionListener = callback;
      calls.push('session-init');
    },
  };
  const events: Array<[string, any]> = [];
  const kernel = createKernel(
    {
      NodeIQQNTWrapperEngine: {
        get: () => ({
          initWithDeskTopConfig() {
            calls.push('engine');
          },
        }),
      },
      NodeIKernelLoginService: { get: () => service },
      NodeIQQNTStartupSessionWrapper: {
        create: () => ({
          start() {
            calls.push('start');
          },
        }),
      },
      NodeIQQNTWrapperSession: { getNTWrapperSession: () => session },
    },
    { dataDir, version: { clientVersion: '1-test', appId: '1', qua: 'test' } },
    (name, payload) => events.push([name, payload]),
  );
  try {
    const preparation = kernel.prepare();
    assert.equal(kernel.prepare(), preparation);
    await preparation;
    assert.deepEqual(calls, ['engine']);
    assert.ok(!events.some(([event]) => ['qrcode', 'authenticated', 'ready'].includes(event)));
    let settled = false;
    const result = kernel.login({ method: 'qr' }).then((account) => {
      settled = true;
      return account;
    });
    while (!sessionListener) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    assert.deepEqual(calls, ['engine', 'qr', 'session-init', 'start']);
    assert.equal(sessionConfig.desktopPathConfig.account_path, dataDir);
    assert.equal(sessionConfig.deviceInfo.guid, '01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(events.find(([name]) => name === 'qrcode')?.[1].image.toString(), 'hi');
    sessionListener.onOpentelemetryInit({ is_init: true });
    assert.deepEqual(await result, { uid: 'uid-test', uin: '123' });
    assert.equal(events.at(-1)?.[0], 'ready');
    assert.deepEqual(await kernel.login({ method: 'quick', uin: '123' }), {
      uid: 'uid-test',
      uin: '123',
    });
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true });
  }
});

for (const scenario of [
  {
    name: 'single eligible account',
    records: [
      { uin: '123', isQuickLogin: true },
      { uin: '456', isQuickLogin: false },
    ],
    selected: undefined,
    expected: '123',
  },
  {
    name: 'explicit eligible account',
    records: [
      { uin: '123', isQuickLogin: true },
      { uin: '456', isQuickLogin: true },
    ],
    selected: '456',
    expected: '456',
  },
  {
    name: 'ambiguous accounts',
    records: [
      { uin: '123', isQuickLogin: true },
      { uin: '456', isQuickLogin: true },
    ],
    selected: undefined,
    error: /Multiple restorable/,
  },
  {
    name: 'missing requested account',
    records: [{ uin: '123', isQuickLogin: true }],
    selected: '456',
    error: /no restorable/,
  },
  {
    name: 'no eligible account',
    records: [{ uin: '123', isQuickLogin: false }],
    selected: undefined,
    error: /No restorable/,
  },
]) {
  test(`restore: ${scenario.name}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'qq-restore-'));
    let listener: any;
    let sessionListener: any;
    const selected: string[] = [];
    const service = {
      initConfig() {},
      addKernelLoginListener(value: any) {
        listener = value;
      },
      connect() {
        listener.onLoginConnected();
      },
      getMsfStatus() {
        return 0;
      },
      async getLoginList() {
        return { LocalLoginInfoList: scenario.records };
      },
      async quickLoginWithUin(uin: string) {
        selected.push(uin);
        listener.onQRCodeLoginSucceed({ uid: 'uid-test', uin });
        return { result: '0' };
      },
      getMachineGuid() {
        return '0123456789abcdef0123456789abcdef';
      },
    };
    const kernel = createKernel(
      {
        NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
        NodeIKernelLoginService: { get: () => service },
        NodeIQQNTStartupSessionWrapper: {
          create: () => ({
            start() {
              sessionListener.onOpentelemetryInit({ is_init: true });
            },
          }),
        },
        NodeIQQNTWrapperSession: {
          getNTWrapperSession: () => ({
            getBuddyService: () => ({
              addKernelBuddyListener() {
                return 1;
              },
            }),
            getMsgService: () => ({ addKernelMsgListener() {} }),
            getGroupService: () => ({ addKernelGroupListener() {} }),
            init(_a: any, _b: any, _c: any, value: any) {
              sessionListener = value;
            },
          }),
        },
      },
      { dataDir, version: { clientVersion: '1-test', appId: '1', qua: 'test' } },
      () => {},
    );
    try {
      const result = kernel.login({ method: 'restore', uin: scenario.selected });
      if (scenario.error) {
        await assert.rejects(result, scenario.error);
        assert.deepEqual(selected, []);
      } else {
        assert.equal((await result).uin, scenario.expected);
        assert.deepEqual(selected, [scenario.expected]);
      }
    } finally {
      await kernel.close();
      await rm(dataDir, { recursive: true });
    }
  });
}

for (const rememberPassword of [undefined, false, true]) {
  test(`rememberPassword ${rememberPassword}: preserves native setting order`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'qq-settings-'));
    const calls: unknown[] = [];
    let listener: any;
    const service: any = {
      initConfig() {
        calls.push('initConfig');
      },
      setRemerberPwd(value: boolean) {
        calls.push(['remember', value]);
      },
      addKernelLoginListener(value: any) {
        listener = value;
      },
      connect() {
        calls.push('connect');
        listener.onLoginFailed('mock-stop');
      },
    };
    const kernel = createKernel(
      {
        NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
        NodeIKernelLoginService: { get: () => service },
        NodeIQQNTStartupSessionWrapper: { create: () => ({}) },
        NodeIQQNTWrapperSession: { getNTWrapperSession: () => ({}) },
      },
      { dataDir, rememberPassword, version: { clientVersion: 'test', appId: '1', qua: 'test' } },
      () => {},
    );
    try {
      await assert.rejects(kernel.login({ method: 'qr' }), /mock-stop/);
      assert.deepEqual(
        calls,
        rememberPassword === undefined
          ? ['initConfig', 'connect']
          : ['initConfig', ['remember', rememberPassword], 'connect'],
      );
      if (rememberPassword !== undefined) {
        // Missing native support must reject before connection, never silently ignore.
        delete service.setRemerberPwd;
        const other = createKernel(
          {
            NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
            NodeIKernelLoginService: { get: () => service },
            NodeIQQNTStartupSessionWrapper: { create: () => ({}) },
            NodeIQQNTWrapperSession: { getNTWrapperSession: () => ({}) },
          },
          {
            dataDir,
            rememberPassword,
            version: { clientVersion: 'test', appId: '1', qua: 'test' },
          },
          () => {},
        );
        try {
          await assert.rejects(other.login({ method: 'qr' }), /setRemerberPwd/);
        } finally {
          await other.close();
        }
        assert.equal(calls.filter((value) => value === 'connect').length, 1);
      }
    } finally {
      await kernel.close();
      await rm(dataDir, { recursive: true });
    }
  });
}
