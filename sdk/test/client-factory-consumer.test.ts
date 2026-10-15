import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyClientFactoryConsumer } from '../scripts/consumers/client-factory-consumer-contract.mjs';

test('source root factory executes its worker with captured bridge precedence and clean environment', async () => {
  const result = await verifyClientFactoryConsumer(fileURLToPath(new URL('../', import.meta.url)), {
    source: true,
  });
  assert.equal(result.clientFactoryInstalledContract, true);
  assert.equal(result.clientFactoryConfiguredLoginLifecycleContract, true);
  assert.equal(result.clientFactoryNativeExportsSnapshotContract, true);
  assert.equal(result.clientFactoryCancellationContract, true);
  assert.equal(result.workerUrlExecuted, true);
  assert.equal(result.nativeSourceSelectionContract, true);
  assert.equal(result.nativeSourcePreflightContract, true);
  assert.equal(result.nativeDirectoryInstalledContract, true);
  assert.equal(result.nativeDefaultLatestContract, true);
  assert.equal(result.nativePinnedOfflineContract, true);
  assert.equal(result.nativeHttpFailureCleanupContract, true);
  assert.equal(result.nativeExecuted, false);
  assert.equal(result.accountUsed, false);
});
