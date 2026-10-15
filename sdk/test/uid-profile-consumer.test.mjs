import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';
import { prepareCommand } from '../src/cli/command-plan.ts';
import { runClientCommand } from '../src/cli/client-command.ts';
import { verifyUidProfileClient } from '../scripts/consumers/uid-profile-consumer-contract.mjs';

await test('explicit UID profile lookup composes with requests, original sessions and CLI lifecycle', async () => {
  assert.deepEqual(
    await verifyUidProfileClient({
      QQClient,
      createNativeServices,
      prepareCommand,
      runClientCommand,
    }),
    {
      explicitUidProfileCompositionContract: true,
      uidProfileNoAutomaticLookupOrFallback: true,
      uidProfileExactIdentityContract: true,
      uidProfileOriginalSessionContract: true,
      uidProfileCliLifecycleContract: true,
      nativeProfileQueryAttempted: false,
      accountUsed: false,
    },
  );
});
