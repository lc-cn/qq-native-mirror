import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import type { NativeObject } from '../src/native/native-object.ts';
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-cleanup-'));
  let listener: NativeObject = {};
  const removed: string[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const failure = Object.assign(new Error('buddy remove failed'), { code: 71 });
  const session = {
    init(_config: unknown, _depends: unknown, _dispatch: unknown, callback: NativeObject) {
      callback.onOpentelemetryInit({ is_init: true });
    },
    startNT() {},
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({
      addKernelGroupListener() {
        return 1;
      },
      removeKernelGroupListener() {
        removed.push('group');
      },
    }),
    getBuddyService: () => ({
      addKernelBuddyListener() {
        return 1;
      },
      removeKernelBuddyListener() {
        removed.push('buddy');
        throw failure;
      },
    }),
  };
  const login = {
    initConfig() {},
    addKernelLoginListener(value: NativeObject) {
      listener = value;
    },
    connect() {
      listener.onLoginConnected();
    },
    getMsfStatus: () => 0,
    getQRCodePicture() {
      listener.onQRCodeLoginSucceed({ uin: '123', uid: 'u_fixture' });
      return true;
    },
    getMachineGuid: () => '0123456789abcdef0123456789abcdef',
  };
  const kernel = createKernel(
    {
      NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
      NodeIKernelLoginService: { get: () => login },
      NodeIQQNTWrapperSession: { create: () => session },
    },
    {
      dataDir,
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      loginTimeoutMs: 500,
    },
    (event, payload) => events.push({ event, payload }),
  );
  await kernel.login({ method: 'qr' });
  return {
    kernel,
    listener,
    removed,
    events,
    failure,
    dispose: () => rm(dataDir, { recursive: true, force: true }),
  };
}
test('kernel close converges before cleanup failure and never retries native removal', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.kernel.close(), (error) => error === f.failure);
    await f.kernel.close();
    assert.deepEqual(f.removed, ['buddy', 'group']);
    await assert.rejects(f.kernel.invokeOperation('listFriends'), /closed/);
  } finally {
    await f.dispose();
  }
});
for (const callback of ['onLoginDisConnected', 'onLogoutSucceed', 'onLoginFailed'])
  test(`${callback} retains notification/error despite cleanup failure`, async () => {
    const f = await fixture();
    try {
      assert.doesNotThrow(() => f.listener[callback]('fixture failure'));
      assert.deepEqual(f.removed, ['buddy', 'group']);
      await assert.rejects(f.kernel.invokeOperation('listFriends'), /not online/);
      if (callback === 'onLoginFailed') {
        const failure = f.events.find((value) => value.event === 'login-error')?.payload;
        assert.ok(failure instanceof AggregateError);
        assert.match(failure.errors[0].message, /Native login failed/);
        assert.equal(failure.errors[1], f.failure);
        const diagnostics = f.events.filter(
          (value) =>
            value.event === 'diagnostic' &&
            value.payload &&
            typeof value.payload === 'object' &&
            'stage' in value.payload &&
            value.payload.stage === 'native-cleanup',
        );
        assert.equal(diagnostics.length, 1);
        const diagnostic = diagnostics[0].payload as {
          cleanupFailures: { message: string; name?: string; code?: number | string }[];
        };
        assert.match(diagnostic.cleanupFailures[0].message, /Native login failed/);
        assert.deepEqual(diagnostic.cleanupFailures[1], {
          message: f.failure.message,
          name: f.failure.name,
          code: 71,
        });
        for (const entry of diagnostic.cleanupFailures) {
          assert.equal(entry instanceof Error, false);
          assert.deepEqual(
            Object.keys(entry).sort(),
            entry.code === undefined ? ['message', 'name'] : ['code', 'message', 'name'],
          );
        }
      } else {
        assert.ok(
          f.events.some(
            (value) => value.event === (callback === 'onLogoutSucceed' ? 'logout' : 'disconnected'),
          ),
        );
        const diagnostic = f.events.find(
          (value) =>
            value.event === 'diagnostic' &&
            value.payload &&
            typeof value.payload === 'object' &&
            'stage' in value.payload &&
            value.payload.stage === 'native-cleanup',
        )?.payload as {
          stage: string;
          cleanupFailures: { message: string; name?: string; code?: number | string }[];
        };
        assert.equal(diagnostic.cleanupFailures.length, 2);
        assert.deepEqual(diagnostic.cleanupFailures[1], {
          message: f.failure.message,
          name: f.failure.name,
          code: 71,
        });
        assert.match(diagnostic.cleanupFailures[0].message, /offline|logged out/);
        assert.deepEqual(Object.keys(diagnostic).sort(), ['cleanupFailures', 'stage']);
        for (const failure of diagnostic.cleanupFailures) {
          assert.equal(failure instanceof Error, false);
          assert.equal('stack' in failure, false);
          assert.equal('cause' in failure, false);
          assert.equal('errors' in failure, false);
        }
      }
      await f.kernel.close();
      assert.deepEqual(f.removed, ['buddy', 'group']);
    } finally {
      await f.kernel.close();
      await f.dispose();
    }
  });
