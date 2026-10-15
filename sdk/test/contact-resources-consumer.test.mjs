import { test } from 'node:test';
import * as api from '../src/index.ts';
import { verifyContactResourcesClient } from '../scripts/consumers/contact-resources-consumer-contract.mjs';

await test('public contact resource workflows retain routing, results and session lifetime', async () => {
  await verifyContactResourcesClient(api);
});
