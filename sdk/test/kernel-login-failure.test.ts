import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKernel } from '../src/kernel.ts';

async function fixture(failureFactory?: () => unknown) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-login-failure-fake-'));
  let listener: any;
  let notifyConnected!: () => void;
  let requests = 0;
  const events: Array<[string, unknown]> = [];
  const kernel = createKernel(
    {
      NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
      NodeIQQNTWrapperSession: { create: () => ({}) },
      NodeIKernelLoginService: {
        get: () => ({
          initConfig() {},
          addKernelLoginListener(value: any) {
            listener = value;
          },
          connect() {
            notifyConnected();
            listener.onLoginConnected();
          },
          getMsfStatus: () => 0,
          getQRCodePicture() {
            requests++;
            if (failureFactory) throw failureFactory();
            return true;
          },
        }),
      },
    },
    { dataDir, loginTimeoutMs: 1000, version: { clientVersion: 'fake', appId: '1', qua: 'fake' } },
    (event, value) => events.push([event, value]),
  );
  await kernel.prepare();
  return {
    kernel,
    events,
    listener: () => listener,
    requests: () => requests,
    async begin() {
      const connected = new Promise<void>((resolve) => {
        notifyConnected = resolve;
      });
      const pending = kernel.login({ method: 'qr' });
      // Observe immediately, including regressions which escape the callback.
      void pending.catch(() => {});
      await connected;
      return { pending };
    },
    async cleanup() {
      await kernel.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

for (const name of ['circular', 'bigint', 'throwing-toJSON', 'sensitive-string']) {
  test(`native login failure ${name} settles without serializing opaque payload`, async () => {
    const f = await fixture();
    try {
      const { pending } = await f.begin();
      const circular: any = {};
      circular.self = circular;
      let projections = 0;
      const payload =
        name === 'circular'
          ? circular
          : name === 'bigint'
            ? 1n
            : name === 'throwing-toJSON'
              ? {
                  toJSON() {
                    projections++;
                    throw new Error('SYNTHETIC_PRIVATE_VALUE');
                  },
                }
              : 'SYNTHETIC_PRIVATE_VALUE';
      assert.doesNotThrow(() => f.listener().onLoginFailed(payload));
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Native login failed');
        return true;
      });
      assert.equal(projections, 0);
      assert.equal(f.requests(), 1);
      const failures = f.events.filter(([event]) => event === 'login-error');
      assert.equal(failures.length, 1);
      assert.ok(failures[0][1] instanceof Error);
      assert.equal(failures[0][1].message, 'Native login failed');
      assert.equal(
        f.events.some(([event]) => ['authenticated', 'login', 'ready'].includes(event)),
        false,
      );
      await f.kernel.close();
      const count = f.events.length;
      assert.doesNotThrow(() => f.listener().onLoginFailed(payload));
      assert.equal(f.events.length, count);
      await assert.rejects(f.kernel.login({ method: 'qr' }), /closed/);
    } finally {
      await f.cleanup();
    }
  });
}

for (const kind of ['opaque', 'revoked', 'message-accessor']) {
  test(`native QR throw ${kind} settles once without escaping the callback`, async () => {
    let projections = 0;
    const f = await fixture(() => {
      if (kind === 'revoked') {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        return revoked.proxy;
      }
      if (kind === 'message-accessor') {
        const error = Error('private');
        Object.defineProperty(error, 'message', {
          get() {
            projections++;
            throw Error('private');
          },
        });
        return error;
      }
      return {
        toString() {
          projections++;
          throw Error('private');
        },
      };
    });
    try {
      const { pending } = await f.begin();
      await assert.rejects(pending, { message: 'Kernel request failed' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(projections, 0);
      assert.equal(f.requests(), 1);
      assert.equal(f.events.filter(([event]) => event === 'login-error').length, 1);
      assert.equal(
        f.events.some(([event]) => event === 'ready'),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
}
