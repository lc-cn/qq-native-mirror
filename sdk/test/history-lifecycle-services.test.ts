import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';
import { observeWatchFailures, prepareCommand } from '../src/cli.ts';
// @ts-expect-error Shared JS consumer contract is also run against installed compiled code.
import { checkHistoryLifecycle } from '../scripts/history-lifecycle-consumer-contract.mjs';

test('public login, asynchronous history input and watch policy share the compiled-consumer contract', async () => {
  await checkHistoryLifecycle({ QQClient, createNativeServices, observeWatchFailures, prepareCommand });
});
