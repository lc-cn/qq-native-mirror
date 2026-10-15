import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { verifyOfflineTransitionClient } from '../scripts/consumers/offline-transition-consumer-contract.mjs';

await test('offline observers see retired capabilities and may start a login that survives only its original transition', async () => {
  assert.deepEqual(await verifyOfflineTransitionClient({ QQClient }), {
    installedOfflineObserverRetirement: true,
    installedOfflineTransitionLogin: true,
    installedIndependentOfflineCancellation: true,
  });
});
