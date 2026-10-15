import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';
import { prepareCommand } from '../src/cli/command-plan.ts';
import { runClientCommand, observeWatchEvents } from '../src/cli/client-command.ts';
import { verifyGroupRequestParticipantClient } from '../scripts/consumers/group-request-participant-consumer-contract.mjs';

await test('native Group participant projection reaches public requests, approval, CLI and watch', async () => {
  assert.deepEqual(
    await verifyGroupRequestParticipantClient({
      QQClient,
      createNativeServices,
      prepareCommand,
      runClientCommand,
      observeWatchEvents,
    }),
    {
      groupRequestParticipantCompositionContract: true,
      groupRequestParticipantApprovalIdentityContract: true,
      groupRequestParticipantOptionalDataContract: true,
      groupRequestParticipantCliWatchContract: true,
      nativeGroupRequestAttempted: false,
      accountUsed: false,
    },
  );
});
