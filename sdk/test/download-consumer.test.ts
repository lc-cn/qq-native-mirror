import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';
import { prepareCommand } from '../src/cli.ts';
import { checkDownloadContract } from '../scripts/download-consumer-contract.mjs';
test('attachment consumer captures inputs, checks completion and closes without replay or overwriting files', async () => {
  await checkDownloadContract({ QQClient, createNativeServices, prepareCommand });
});
