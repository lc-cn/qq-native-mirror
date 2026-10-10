import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyGroupFilePagesConsumer } from '../scripts/group-file-pages-consumer-contract.mjs';

test('group-file consumer uses source modules and a real controlled worker with complete DTOs', async () => {
  const result = await verifyGroupFilePagesConsumer(
    fileURLToPath(new URL('../', import.meta.url)),
    { source: true },
  );
  assert.equal(result.groupFileCompleteDtoContract, true);
  assert.equal(result.groupFileLinuxX64CompositionContract, true);
  assert.equal(result.groupFileInstalledWorkerCliContract, true);
  assert.equal(result.groupFileWorkerCancellationContract, true);
  assert.equal(result.nativeGroupFileQueryAttempted, false);
  assert.equal(result.accountUsed, false);
});
