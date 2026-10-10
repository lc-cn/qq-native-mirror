import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyClientFactoryConsumer } from '../scripts/client-factory-consumer-contract.mjs';

test('source root factory executes its worker with captured bridge precedence and clean environment', async () => {
  const result = await verifyClientFactoryConsumer(fileURLToPath(new URL('../', import.meta.url)), {
    source: true,
  });
  assert.equal(result.clientFactoryInstalledContract, true);
  assert.equal(result.workerUrlExecuted, true);
  assert.equal(result.nativeExecuted, false);
  assert.equal(result.accountUsed, false);
});
