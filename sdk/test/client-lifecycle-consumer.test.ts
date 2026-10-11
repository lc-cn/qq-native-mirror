import test from 'node:test';
import assert from 'node:assert/strict';
import { QQClient } from '../src/index.ts';
import { verifyClientLifecycleConsumer } from '../scripts/consumers/client-lifecycle-consumer-contract.mjs';

// The helper owns unspawned ChildProcess fixtures and their cleanup; this boundary
// supplies the actual public constructor without forking or loading native code.
test('public source client satisfies the shared controlled lifecycle consumer contract', async () => {
  const checks = await verifyClientLifecycleConsumer(QQClient);
  const expected = [
    'clientIdentityInstalledContract',
    'clientLoginReentrancyContract',
    'clientClosingObserverCleanupContract',
    'clientOfflineObserverRetirementContract',
    'clientOfflineBatchCancellationContract',
    'clientNestedOfflineRestoreContract',
    'clientLoginTimeoutObserverRetirementContract',
    'clientReconnectFailureRetirementContract',
    'clientReconnectEntryReservationContract',
    'clientReconnectSpawnFailureContract',
    'clientCloseFailureNotificationContract',
    'clientLoginFailureNotificationContract',
    'clientNativeExportsSnapshotContract',
    'clientAutomaticRestoreRetirementContract',
    'clientWaitForReconnectContract',
    'clientLoginReconnectAdmissionContract',
    'clientEventPresentationInstalledContract',
  ];
  assert.deepEqual(Object.keys(checks).sort(), expected.sort());
  assert.equal(
    Object.values(checks).every((value) => value === true),
    true,
  );
});
