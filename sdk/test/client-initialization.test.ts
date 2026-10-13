import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readlink, rm, mkdir, access, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createClient, KernelRequestError } from '../src/index.ts';

test('invalid timer values fail before native preparation or worker creation', async () => {
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(
      createClient({ dataDir: '/unused-account', timeoutMs }),
      /timeoutMs must be an integer/,
    );
  }
});

test('failed initialization waits for worker exit and releases its data-directory lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-init-failure-'));
  try {
    const wrapper = join(root, 'never-loaded.node');
    await writeFile(wrapper, 'not a native binary');
    const dataDir = join(root, 'account-unused');
    const bridgePath = join(root, 'invalid-registration-bridge.node');
    await writeFile(bridgePath, 'not a native binary');
    const options = {
      wrapperPath: wrapper,
      dataDir,
      bridgePath,
      version: { clientVersion: 'test', appId: 'test', qua: 'test' },
      timeoutMs: 5000,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(createClient(options), (error: unknown) => {
        assert.ok(error instanceof KernelRequestError);
        assert.match(error.message, /invalid-registration-bridge/);
        assert.equal(error.operation, 'init');
        assert.equal(error.code, 'ERR_DLOPEN_FAILED');
        return true;
      });
      await assert.rejects(readlink(join(dataDir, '.qq-native-client.lock')), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit invalid bridges reject before native preparation, data creation or fork', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qq-bridge-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'directory.node');
  await mkdir(directory);
  const originalFetch = globalThis.fetch;
  const originalFork = childProcess.fork;
  let preparations = 0;
  let forks = 0;
  globalThis.fetch = async () => {
    preparations++;
    throw new Error('Native preparation must not start');
  };
  childProcess.fork = () => {
    forks++;
    throw new Error('Worker must not start');
  };
  syncBuiltinESMExports();
  t.after(() => {
    globalThis.fetch = originalFetch;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  });
  for (const [index, bridgePath] of [
    '',
    '   ',
    'bad\0path',
    join(root, 'missing.node'),
    directory,
  ].entries()) {
    const dataDir = join(root, `unused-${index}`);
    await assert.rejects(createClient({ dataDir, bridgePath }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof KernelRequestError));
      if (index < 3) assert.match(error.message, /non-empty path without NUL/);
      else {
        assert.match(error.message, /Cannot use registration bridge/);
        assert.ok(error.cause instanceof Error);
        if (index === 3)
          assert.equal(Object.getOwnPropertyDescriptor(error.cause, 'code')?.value, 'ENOENT');
        else assert.match(error.cause.message, /regular file/);
      }
      return true;
    });
    await assert.rejects(access(dataDir), { code: 'ENOENT' });
  }
  assert.equal(preparations, 0);
  assert.equal(forks, 0);
});

test('explicit relative bridge paths retain the worker data-directory base', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qq-relative-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'account');
  const wrapperPath = join(root, 'wrapper.node');
  await mkdir(dataDir);
  await writeFile(wrapperPath, 'not loaded');
  await writeFile(join(dataDir, 'relative.node'), 'invalid relative bridge');
  await assert.rejects(
    createClient({
      dataDir,
      wrapperPath,
      bridgePath: 'relative.node',
      version: { clientVersion: 'test', appId: 'test', qua: 'test' },
      timeoutMs: 5000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KernelRequestError);
      assert.equal(error.operation, 'init');
      assert.equal(error.code, 'ERR_DLOPEN_FAILED');
      assert.match(error.message, /relative/);
      return true;
    },
  );
  await assert.rejects(readlink(join(dataDir, '.qq-native-client.lock')), { code: 'ENOENT' });
});

test(
  'an existing invalid adjacent bridge is rejected rather than bypassed by fallback',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qq-adjacent-bridge-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const wrapperPath = join(root, 'wrapper.node');
    await writeFile(wrapperPath, 'synthetic wrapper');
    await mkdir(join(root, 'registration-bridge.node'));
    const originalFork = childProcess.fork;
    let forks = 0;
    childProcess.fork = () => {
      forks++;
      throw new Error('Worker must not start');
    };
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.fork = originalFork;
      syncBuiltinESMExports();
    });
    const dataDir = join(root, 'unused');
    await assert.rejects(
      createClient({
        wrapperPath,
        dataDir,
        version: { clientVersion: 'test', appId: 'test', qua: 'test' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cannot use registration bridge/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /regular file/);
        return true;
      },
    );
    assert.equal(forks, 0);
    await assert.rejects(access(dataDir), { code: 'ENOENT' });
  },
);

test('runtime null and numeric explicit bridges cannot fall back to preparation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qq-bridge-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalFork = childProcess.fork;
  let preparations = 0;
  let forks = 0;
  globalThis.fetch = async () => {
    preparations++;
    throw Error('Unexpected preparation');
  };
  childProcess.fork = () => {
    forks++;
    throw Error('Unexpected worker');
  };
  syncBuiltinESMExports();
  t.after(() => {
    globalThis.fetch = originalFetch;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  });
  for (const bridgePath of [null, 42]) {
    await assert.rejects(
      Reflect.apply(createClient, undefined, [
        {
          dataDir: join(root, 'unused'),
          bridgePath,
        },
      ]),
      /bridgePath must be a non-empty path without NUL/,
    );
  }
  assert.equal(preparations, 0);
  assert.equal(forks, 0);
  await assert.rejects(access(join(root, 'unused')), { code: 'ENOENT' });
});

test(
  'unreadable explicit bridges reject before preparation or fork',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qq-bridge-permissions-'));
    const bridgePath = join(root, 'unreadable.node');
    await writeFile(bridgePath, 'synthetic bridge');
    await chmod(bridgePath, 0o000);
    const originalFetch = globalThis.fetch;
    const originalFork = childProcess.fork;
    let preparations = 0;
    let forks = 0;
    globalThis.fetch = async () => {
      preparations++;
      throw Error('Unexpected preparation');
    };
    childProcess.fork = () => {
      forks++;
      throw Error('Unexpected worker');
    };
    syncBuiltinESMExports();
    t.after(async () => {
      globalThis.fetch = originalFetch;
      childProcess.fork = originalFork;
      syncBuiltinESMExports();
      await chmod(bridgePath, 0o600);
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(
      createClient({ dataDir: join(root, 'unused'), bridgePath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cannot use registration bridge/);
        assert.ok(error.cause instanceof Error);
        assert.equal(Object.getOwnPropertyDescriptor(error.cause, 'code')?.value, 'EACCES');
        return true;
      },
    );
    assert.equal(preparations, 0);
    assert.equal(forks, 0);
    await assert.rejects(access(join(root, 'unused')), { code: 'ENOENT' });
  },
);
