import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    const options = {
      wrapperPath: wrapper,
      dataDir,
      bridgePath: join(root, 'missing-registration-bridge.node'),
      version: { clientVersion: 'test', appId: 'test', qua: 'test' },
      timeoutMs: 5000,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(createClient(options), (error: unknown) => {
        assert.ok(error instanceof KernelRequestError);
        assert.match(error.message, /missing-registration-bridge/);
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
