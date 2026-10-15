import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient, segment } from '../src/index.ts';
import { verifyBotApiClient } from '../scripts/consumers/bot-api-consumer-contract.mjs';

await test('public bot APIs preserve messages, request decisions and group-avatar lifetimes', async () => {
  assert.deepEqual(await verifyBotApiClient({ QQClient, segment }), {
    installedMessageComposition: true,
    installedImmutableMessageRouting: true,
    installedRequestApprovalLifetime: true,
    installedMessageContacts: true,
    installedMessageMemberInfo: true,
    installedCapturedMessageText: true,
    installedGroupAvatarRouting: true,
    installedGroupAvatarValidation: true,
    installedGroupAvatarLifetime: true,
  });
});
