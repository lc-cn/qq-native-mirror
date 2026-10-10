import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { QQClient } from '../src/index.ts';
import { verifyWorkerErrorRoutes } from '../scripts/worker-error-consumer-contract.mjs';

test('actual worker replies to opaque failures and the same worker serves the next query', async () => {
  await verifyWorkerErrorRoutes({
    QQClient,
    workerPath: fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
    kernelPath: fileURLToPath(new URL('../src/kernel.ts', import.meta.url)),
    errorsPath: fileURLToPath(new URL('../src/errors.ts', import.meta.url)),
    nativeContractsPath: fileURLToPath(
      new URL('../src/native/native-contracts.ts', import.meta.url),
    ),
  });
});
