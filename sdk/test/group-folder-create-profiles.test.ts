import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { supportsGroupFolderCreation } from '../src/native/native-contracts.ts';
import type { NativeContractProfile } from '../src/native/native-contracts.ts';

const evidence = JSON.parse(
  readFileSync(
    new URL('../docs/evidence/group-folder-create-contract.json', import.meta.url),
    'utf8',
  ),
) as { profiles: NativeContractProfile[]; nativeExecuted: boolean; accountUsed: boolean };

test('folder creation gating binds all six independently inspected binaries and rejects changed provenance', () => {
  assert.equal(evidence.profiles.length, 6);
  assert.equal(
    new Set(evidence.profiles.map((profile) => `${profile.platform}/${profile.arch}`)).size,
    6,
  );
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  for (const profile of evidence.profiles) {
    assert.equal(supportsGroupFolderCreation(profile, profile.clientVersion), true);
    for (const key of ['platform', 'arch', 'clientVersion', 'wrapperSha256'] as const) {
      assert.equal(
        supportsGroupFolderCreation({ ...profile, [key]: 'unverified' }, profile.clientVersion),
        false,
      );
    }
    assert.equal(supportsGroupFolderCreation(profile, 'unverified'), false);
    assert.equal(supportsGroupFolderCreation(undefined, profile.clientVersion), false);
  }
});
