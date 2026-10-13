import assert from 'node:assert/strict';
import test from 'node:test';
import { MergedForwardError } from '../src/errors.ts';
import { createNativeServices } from '../src/native-services.ts';
import { hasStringSsoCarrier } from '../src/native/native-contracts.ts';

// Independent static observation: this wrapper consumes STRING/STRING and
// resolves result/errMsg/rsp strings. No protocol encoding is inferred.
const profile = {
  platform: 'darwin',
  arch: 'arm64',
  clientVersion: '7.0.2-53644',
  wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
};

test('the string-carrier fact is bound to exact measured binary identity', () => {
  assert.equal(hasStringSsoCarrier(profile, profile.clientVersion), true);
  for (const candidate of [
    undefined,
    { ...profile, platform: 'linux' },
    { ...profile, arch: 'x64' },
    { ...profile, clientVersion: 'other' },
    { ...profile, wrapperSha256: '0'.repeat(64) },
  ])
    assert.equal(hasStringSsoCarrier(candidate, profile.clientVersion), false);
  assert.equal(hasStringSsoCarrier(profile, 'other'), false);
});

test('known string carrier rejects forward byte operations before packet acquisition or send', async () => {
  let acquisitions = 0,
    sends = 0;
  const services = createNativeServices({
    session: {
      getMsgService() {
        acquisitions++;
        return {
          addKernelMsgListener() {},
          sendSsoCmdReqByContend() {
            sends++;
            throw Error('must not send');
          },
        };
      },
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
    },
    version: profile.clientVersion,
    binaryProfile: profile,
    identity: { userId: '123', uid: 'u_self' },
    events: { emit() {} },
  });
  const initialAcquisitions = acquisitions;
  try {
    await assert.rejects(
      services.invokeOperation('getForwardResource', { resourceId: 'r' }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'unsupported-native-contract',
    );
    await assert.rejects(
      services.invokeOperation('sendMergedForward', {
        peer: { type: 'group', groupId: '123' },
        nodes: [{ userId: '123', nickname: 'fixture', time: 100, text: 'fixture' }],
      }),
      (error: unknown) =>
        error instanceof MergedForwardError &&
        error.phase === 'upload' &&
        error.progress.uploadCompletion === 'not-dispatched' &&
        error.progress.cardCompletion === 'not-dispatched',
    );
    assert.equal(sends, 0);
    assert.equal(acquisitions, initialAcquisitions);
  } finally {
    services.close();
  }
});
