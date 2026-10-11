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
    platform: 'darwin',
    arch: 'arm64',
    clientVersion: '7.0.2-53644',
    wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
  },
];

test('assignment grants only the two independently bound exact binary profiles', () => {
  assert.deepEqual(
    evidence.profiles.map(({ platform, arch, clientVersion, wrapperSha256 }) => ({
      platform,
      arch,
      clientVersion,
      wrapperSha256,
    })),
    expected,
  );
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
      ['linux', 'arm64'],
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
    const other = expected.find((value) => value !== profile)!;
    assert.equal(
      supportsCategoryAssignment(
        { ...profile, wrapperSha256: other.wrapperSha256 },
        profile.clientVersion,
      ),
      false,
    );
  }
});
