import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPrepareCli } from '../scripts/consumers/prepare-cli-consumer-contract.mjs';

await test('actual CLI prepares, closes and suppresses account configuration under controlled failures and signals', async () => {
  assert.deepEqual(
    await verifyPrepareCli(fileURLToPath(new URL('../src/cli.ts', import.meta.url))),
    {
      cliPrepareLifecycleContract: true,
      cliPrepareLoginSuppressionContract: true,
    },
  );
});
