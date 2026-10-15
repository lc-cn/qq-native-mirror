import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyNativeCreationCancellation } from '../scripts/consumers/native-creation-cancellation-consumer-contract.mjs';

await test('actual CLI cancels manifest and concurrent payload bodies before native loading', async () => {
  assert.deepEqual(
    await verifyNativeCreationCancellation(
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    ),
    {
      nativeCreationManifestCancellationContract: true,
      nativeCreationPayloadCancellationContract: true,
      nativeCreationCancellationCleanupContract: true,
      nativeCreationCancellationSignalMode:
        process.platform === 'win32' ? 'programmatic-sigint' : 'os-sigint',
      nativeCreationCancellationLoopbackOnly: true,
      nativeCreationCancellationNativeExecuted: false,
      nativeCreationCancellationAccountUsed: false,
    },
  );
});
