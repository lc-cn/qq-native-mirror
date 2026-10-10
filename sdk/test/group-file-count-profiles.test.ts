import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNativeServices } from '../src/native-services.ts';
import type { NativeContractProfile } from '../src/native/native-contracts.ts';

// Independent binary evidence, not the implementation's capability allowlist.
const evidence = JSON.parse(
  readFileSync(new URL('../docs/evidence/group-file-count-contract.json', import.meta.url), 'utf8'),
) as { profiles: NativeContractProfile[]; nativeExecuted: boolean; accountUsed: boolean };

function fixture(profile: NativeContractProfile | undefined, version: string) {
  let acquisitions = 0;
  const calls: string[][] = [];
  const richMedia = {
    batchGetGroupFileCount(groups: string[]) {
      assert.equal(this, richMedia);
      calls.push(groups);
      return Promise.resolve({ result: 0, groupCodes: ['123'], groupFileCounts: [0] });
    },
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getRichMediaService() {
        acquisitions++;
        return richMedia;
      },
    },
    version,
    binaryProfile: profile,
    events: { emit() {} },
  });
  return { services, calls, acquisitions: () => acquisitions };
}

test('all six independently inspected count profiles are gated at composition before lazy acquisition', async () => {
  assert.equal(evidence.profiles.length, 6);
  assert.equal(new Set(evidence.profiles.map((p) => `${p.platform}/${p.arch}`)).size, 6);
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  for (const profile of evidence.profiles) {
    const f = fixture(profile, profile.clientVersion);
    try {
      assert.equal(f.acquisitions(), 0);
      assert.equal(await f.services.invokeOperation('getGroupFileCount', { groupId: '000123' }), 0);
      assert.deepEqual(f.calls, [['000123']]);
      assert.equal(f.acquisitions(), 1);
      f.services.close();
      await assert.rejects(
        f.services.invokeOperation('getGroupFileCount', { groupId: '123' }),
        /closed/,
      );
      assert.equal(f.calls.length, 1);
    } finally {
      f.services.close();
    }
    for (const [candidate, version] of [
      [undefined, profile.clientVersion],
      [{ ...profile, platform: 'unknown' }, profile.clientVersion],
      [{ ...profile, arch: 'unknown' }, profile.clientVersion],
      [{ ...profile, wrapperSha256: '0'.repeat(64) }, profile.clientVersion],
      [{ ...profile, clientVersion: 'unverified' }, 'unverified'],
      [profile, 'unverified'],
    ] as const) {
      const rejected = fixture(candidate, version);
      try {
        await assert.rejects(
          rejected.services.invokeOperation('getGroupFileCount', { groupId: '123' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as Error & { code: string }).code, 'unsupported-native-contract');
            return true;
          },
        );
        assert.equal(rejected.acquisitions(), 0);
        assert.equal(rejected.calls.length, 0);
      } finally {
        rejected.services.close();
      }
    }
  }
});
