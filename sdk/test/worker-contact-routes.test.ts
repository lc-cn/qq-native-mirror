import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QQClient } from '../src/index.ts';
import { verifyContactGroupWorkerRoutes } from '../scripts/contact-group-consumer-contract.mjs';

test('public contact/group methods reach the actual worker allowlist through IPC', async () => {
  await verifyContactGroupWorkerRoutes({
    QQClient,
    workerPath: fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
    kernelPath: fileURLToPath(new URL('../src/kernel.ts', import.meta.url)),
  });
});
