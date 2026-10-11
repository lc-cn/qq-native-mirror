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

test('assignment grants only the independently bound Linux x64 profile', () => {
  assert.equal(evidence.profiles.length, 1);
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  const profile = evidence.profiles[0]!;
  assert.equal(profile.platform, 'linux');
  assert.equal(profile.arch, 'x64');
  assert.equal(profile.clientVersion, '3.2.32-52194');
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
    ['darwin', 'arm64'],
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
});
