import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNativeServices } from '../src/native-services.ts';
import type { NativeContractProfile } from '../src/native/native-contracts.ts';
import type { GroupFileListParams } from '../src/features/groups/group-file-input.ts';

const evidence = JSON.parse(
  readFileSync(new URL('../docs/evidence/group-file-page-contract.json', import.meta.url), 'utf8'),
) as {
  profiles: NativeContractProfile[];
  nativeExecuted: boolean;
  accountUsed: boolean;
};
const allProfiles = JSON.parse(
  readFileSync(new URL('../docs/evidence/group-file-count-contract.json', import.meta.url), 'utf8'),
) as {
  profiles: NativeContractProfile[];
};
let nextToken = 200_000;
function fixture(profile: NativeContractProfile | undefined, version: string) {
  let acquire = 0;
  let notify!: (value: unknown) => void;
  const richMedia = {
    getGroupFileList(groupId: string, params: GroupFileListParams) {
      assert.equal(this, richMedia);
      assert.equal(groupId, '000123');
      assert.equal(params.startIndex, 0);
      const token = nextToken++;
      notify({
        reqId: token,
        retCode: 0,
        retMsg: '',
        clientWording: '',
        item: [],
        isEnd: true,
        nextIndex: 0,
        allFileCount: 0,
      });
      return token;
    },
  };
  const services = createNativeServices({
    version,
    binaryProfile: profile,
    events: { emit() {} },
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value: { onGroupFileInfoUpdate: (value: unknown) => void }) {
          notify = value.onGroupFileInfoUpdate;
        },
      }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getRichMediaService() {
        acquire++;
        return richMedia;
      },
    },
  });
  return { services, acquisitions: () => acquire };
}

test('only separately inspected exact page binaries are enabled; other profiles reject before acquisition', async () => {
  assert.deepEqual(
    evidence.profiles.map(({ platform, arch, clientVersion }) => [platform, arch, clientVersion]),
    [
      ['darwin', 'arm64', '7.0.2-53644'],
      ['linux', 'arm64', '3.2.32-52194'],
      ['linux', 'x64', '3.2.32-52194'],
    ],
  );
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  for (const supported of evidence.profiles) {
    const positive = fixture(supported, supported.clientVersion);
    try {
      assert.deepEqual(
        await positive.services.invokeOperation('listGroupFiles', { groupId: '000123' }),
        [],
      );
      assert.equal(positive.acquisitions(), 1);
    } finally {
      positive.services.close();
    }
  }
  for (const candidate of allProfiles.profiles.filter(
    (candidate) =>
      !evidence.profiles.some(
        (supported) =>
          candidate.platform === supported.platform &&
          candidate.arch === supported.arch &&
          candidate.clientVersion === supported.clientVersion &&
          candidate.wrapperSha256 === supported.wrapperSha256,
      ),
  )) {
    const f = fixture(candidate, candidate.clientVersion);
    try {
      await assert.rejects(f.services.invokeOperation('getGroupFilePage', { groupId: '000123' }), {
        code: 'unsupported-native-contract',
      });
      assert.equal(f.acquisitions(), 0);
    } finally {
      f.services.close();
    }
  }
  for (const supported of evidence.profiles) {
    for (const [profile, version] of [
      [undefined, supported.clientVersion],
      [{ ...supported, platform: 'unknown' }, supported.clientVersion],
      [{ ...supported, arch: 'unknown' }, supported.clientVersion],
      [{ ...supported, wrapperSha256: '0'.repeat(64) }, supported.clientVersion],
      [{ ...supported, clientVersion: 'unverified' }, 'unverified'],
      [supported, 'unverified'],
    ] as const) {
      const f = fixture(profile, version);
      try {
        await assert.rejects(
          f.services.invokeOperation('getGroupFilePage', { groupId: '000123' }),
          {
            code: 'unsupported-native-contract',
          },
        );
        assert.equal(f.acquisitions(), 0);
      } finally {
        f.services.close();
      }
    }
  }
});
