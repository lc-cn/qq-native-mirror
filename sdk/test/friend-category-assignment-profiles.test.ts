import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  supportsCategoryAssignment,
  type NativeContractProfile,
} from '../src/native/native-contracts.ts';

const evidence = JSON.parse(
  readFileSync(
    new URL('../docs/evidence/friend-category-assignment-contract.json', import.meta.url),
    'utf8',
  ),
) as { profiles: NativeContractProfile[]; nativeExecuted: boolean; accountUsed: boolean };

const expected: NativeContractProfile[] = [
  {
    platform: 'linux',
    arch: 'x64',
    clientVersion: '3.2.32-52194',
    wrapperSha256: '7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    clientVersion: '3.2.32-52194',
    wrapperSha256: 'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337',
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    clientVersion: '7.0.2-53644',
    wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
  },
];

test('assignment grants only the three independently bound exact binary profiles', () => {
  assert.deepEqual(
    evidence.profiles.map(({ platform, arch, clientVersion, wrapperSha256 }) => ({
      platform,
      arch,
      clientVersion,
      wrapperSha256,
    })),
    expected,
  );
  const unsupported: NativeContractProfile[] = [
    {
      platform: 'darwin',
      arch: 'x64',
      clientVersion: '7.0.2-53644',
      wrapperSha256: 'e91c58872d3d498f2d3ac1c304ab3ae4602d016274cf3e0f0cb651ad765f1f54',
    },
    {
      platform: 'win32',
      arch: 'arm64',
      clientVersion: '9.9.33-52230',
      wrapperSha256: '54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a',
    },
    {
      platform: 'win32',
      arch: 'x64',
      clientVersion: '9.9.33-52230',
      wrapperSha256: '63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0',
    },
  ];
  for (const profile of unsupported)
    assert.equal(supportsCategoryAssignment(profile, profile.clientVersion), false);
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  for (const profile of expected) {
    assert.equal(supportsCategoryAssignment(profile, profile.clientVersion), true);
    for (const key of ['platform', 'arch', 'clientVersion', 'wrapperSha256'] as const) {
      assert.equal(
        supportsCategoryAssignment({ ...profile, [key]: 'unverified' }, profile.clientVersion),
        false,
      );
    }
    assert.equal(supportsCategoryAssignment(profile, 'unverified'), false);
    assert.equal(supportsCategoryAssignment(undefined, profile.clientVersion), false);
    for (const [platform, arch] of [
      ['darwin', 'x64'],
      ['win32', 'arm64'],
      ['win32', 'x64'],
    ]) {
      assert.equal(
        supportsCategoryAssignment(
          { ...profile, platform: platform!, arch: arch! },
          profile.clientVersion,
        ),
        false,
      );
    }
    for (const key of ['platform', 'arch', 'clientVersion', 'wrapperSha256'] as const) {
      const incomplete = { ...profile };
      Reflect.deleteProperty(incomplete, key);
      assert.equal(supportsCategoryAssignment(incomplete, profile.clientVersion), false);
    }
    for (const other of expected.filter((value) => value !== profile))
      assert.equal(
        supportsCategoryAssignment(
          { ...profile, wrapperSha256: other.wrapperSha256 },
          profile.clientVersion,
        ),
        false,
      );
  }
});
