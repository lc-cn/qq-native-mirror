import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runVersionDriver } from './driver-transaction.mjs';

for (const primary of [
  Error('operation failure'),
  undefined,
  null,
  Object.freeze({ opaque: true }),
]) {
  test(`driver preserves arbitrary primary ${String(primary)}`, async () => {
    const steps = [];
    await assert.rejects(
      runVersionDriver(
        async () => {
          steps.push('operation');
          throw primary;
        },
        async (error) => {
          assert.strictEqual(error, primary);
          steps.push('report');
        },
        async () => {
          steps.push('cleanup');
        },
      ),
      (error) => error === primary,
    );
    assert.deepEqual(steps, ['operation', 'report', 'cleanup']);
  });
}
test('report and cleanup failures retain all original values in order', async () => {
  const primary = Error('runtime');
  const report = Object.freeze({ failure: 'receipt' });
  const cleanup = undefined;
  let cleaned = 0;
  await assert.rejects(
    runVersionDriver(
      async () => {
        throw primary;
      },
      async () => {
        throw report;
      },
      async () => {
        cleaned++;
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, report, cleanup]);
      assert.strictEqual(error.errors[0], primary);
      assert.strictEqual(error.errors[1], report);
      return true;
    },
  );
  assert.equal(cleaned, 1);
});
test('operation settles before cleanup and success does not report failure', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let cleaned = 0;
  const result = runVersionDriver(
    async () => {
      await gate;
      return 42;
    },
    async () => {
      assert.fail('success reported as failure');
    },
    async () => {
      cleaned++;
    },
  );
  await Promise.resolve();
  assert.equal(cleaned, 0);
  release();
  assert.equal(await result, 42);
  assert.equal(cleaned, 1);
});
test('sole cleanup failure preserves identity after successful operation', async () => {
  const cleanup = Error('directory cleanup');
  await assert.rejects(
    runVersionDriver(
      async () => 42,
      async (error, stage) => {
        assert.strictEqual(error, cleanup);
        assert.equal(stage, 'cleanup');
      },
      async () => {
        throw cleanup;
      },
    ),
    (error) => error === cleanup,
  );
});
test('actual driver acquires within transaction and preserves real installed execution', async () => {
  const source = await readFile(new URL('./verify.mjs', import.meta.url), 'utf8');
  assert.match(source, /await runVersionDriver\(/);
  assert.ok(source.indexOf('await mkdtemp(') > source.indexOf('await runVersionDriver('));
  assert.match(source, /execFileSync\(process\.execPath, \[join\(temporary, 'consumer.mjs'\)\]/);
  assert.match(source, /if \(temporary\) await rm\(temporary,/);
});

test('cleanup-only reporting failure retains cleanup then reporting identity', async () => {
  const cleanup = undefined;
  const report = Object.freeze({ report: 'opaque' });
  await assert.rejects(
    runVersionDriver(
      async () => 42,
      async (error, stage) => {
        assert.strictEqual(error, cleanup);
        assert.equal(stage, 'cleanup');
        throw report;
      },
      async () => {
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], cleanup);
      assert.strictEqual(error.errors[1], report);
      return true;
    },
  );
});
test('actual early driver failure replaces stale success without removing main inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-version-stale-receipt-'));
  try {
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out/version-consumer.json'), JSON.stringify({ success: true }));
    await writeFile(
      join(root, 'out/version-consumer-driver-error.json'),
      JSON.stringify({ success: true }),
    );
    await writeFile(join(root, 'out/main-source.json'), 'keep-main-source');
    await writeFile(join(root, 'out/qq-native-client-fixture.tgz'), 'keep-archive');
    const env = { ...process.env };
    delete env.EXPECTED_MAIN_SOURCE_SHA256;
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./verify.mjs', import.meta.url))],
        { cwd: root, env, timeout: 10000 },
      ),
      /Missing shared producer seal/,
    );
    for (const name of ['version-consumer.json', 'version-consumer-driver-error.json']) {
      const receipt = JSON.parse(await readFile(join(root, 'out', name), 'utf8'));
      assert.equal(receipt.success, false);
      assert.equal(receipt.stage, 'install-or-runtime');
    }
    assert.equal(await readFile(join(root, 'out/main-source.json'), 'utf8'), 'keep-main-source');
    assert.equal(
      await readFile(join(root, 'out/qq-native-client-fixture.tgz'), 'utf8'),
      'keep-archive',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
