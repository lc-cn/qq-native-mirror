import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { QQClient } from '../src/index.ts';
import { verifyWorkerReadCancellation } from '../scripts/worker-read-consumer-contract.mjs';

test(
  'actual worker cancellation reaches HTTP reads without closing its Session',
  { timeout: 15000 },
  async () => {
    const proof = await verifyWorkerReadCancellation({
      QQClient,
      workerPath: fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
      kernelPath: fileURLToPath(new URL('../src/kernel.ts', import.meta.url)),
      nativeServicesPath: fileURLToPath(new URL('../src/native-services.ts', import.meta.url)),
    });
    assert.equal(proof.workerReadCancellation, true);
    assert.equal(proof.accountUsed, false);
    assert.equal(proof.nativeExecuted, false);
    assert.equal(proof.realHttp, false);
  },
);
