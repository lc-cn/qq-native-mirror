import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyWorkerDelivery } from '../scripts/consumers/worker-delivery-consumer-contract.mjs';

await test('worker observes reply failures with one dispatch and one send, and retains acknowledged close', async () => {
  await verifyWorkerDelivery({
    workerPath: fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
    bootstrapPath: fileURLToPath(new URL('../src/worker/bootstrap.ts', import.meta.url)),
  });
});
